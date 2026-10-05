import type Database from "better-sqlite3";
import {
    getAllContracts,
    getEntriesForContract,
    upsertEntry,
    updateLastCheckedLedger,
    getAlertConfigsForContract,
    getAlertConfigById,
    hasUnresolvedAlert,
    recordAlertFired,
    resolveAlerts,
    getAlertConfigTargets,
    insertTTLSample,
    pruneOldTTLSamples,
    getTTLSamples,
    getExtensionPolicy,
} from "../db/repositories.js";
import { StellarRpcClient } from "../rpc/client.js";
import { deliverSingleAlert } from "../alerts/dispatcher.js";
import { buildAlertEvent } from "../alerts/types.js";
import { runAutoExtensions, type PredictiveOptions } from "./extension.js";
import { computeDecayRate, projectCrossingLedger } from "./predictive.js";
import { getLogger } from "../logging/index.js";
import { getTracer, endSpan } from "../observability/tracing.js";
import type { Span } from "@opentelemetry/api";
import { ledgersToMilliseconds } from "../utils/ledger.js";

const logger = getLogger().child({ component: "MonitorCycle" });

// ─── Public contract ──────────────────────────────────────────────────────────

export interface ProjectedCrossing {
    contractId: string;
    entryKeyXdr: string;
    /** Projected ledger at which remainingTTL will fall below threshold. Null when insufficient samples. */
    projectedCrossingLedger: number | null;
    /** ISO-8601 string derived from the ledger projection. Null when projection is unavailable. */
    projectedCrossingAt: string | null;
}

export interface MonitorCycleResult {
    /** Number of contracts belonging to the target network that were processed. */
    contractsChecked: number;
    /** Number of individual ledger entries whose TTL was refreshed in the DB. */
    entriesUpdated: number;
    /** Number of alert threshold crossings detected (new, not previously fired). */
    thresholdsCrossed: number;
    /** Number of previously-open alerts that were resolved because TTL recovered. */
    alertsResolved: number;
    /** Total ledger entries extended by the auto-extension phase this cycle. */
    extensionsTriggered: number;
    /** Non-fatal errors from the auto-extension phase. */
    extensionErrors: string[];
    /** Per-contract error messages for any contract that failed during the cycle. */
    errors: string[];
    /** Timestamp when this cycle started. */
    cycleStartedAt: Date;
    /** Timestamp when this cycle completed. */
    cycleFinishedAt: Date;
    /** Projected TTL crossing ledgers for entries with enough historical samples. */
    projectedCrossings: ProjectedCrossing[];
}

// ─── Core implementation ──────────────────────────────────────────────────────

/**
 * One complete monitoring polling cycle.
 *
 * Responsibilities:
 *  1. Load all contracts for the given network from the DB.
 *  2. For each contract, fetch fresh TTLs from the RPC in a single batched call.
 *  3. Persist updated TTL values back to the DB.
 *  4. Detect alert threshold crossings and record them (deduplication aware).
 *  5. Auto-resolve open alerts whose TTL has recovered above the threshold.
 *
 * Contract: pure logic — no timers, no CLI concerns, no side-effects beyond the
 * provided `db` handle.  Errors from individual contracts are collected and
 * returned rather than propagated so that one bad contract cannot abort the
 * entire cycle.
 *
 * @param db               - An open better-sqlite3 Database handle.
 * @param network          - The Stellar network to monitor ("testnet" | "mainnet" | …).
 * @param rpcUrl           - Optional override for the RPC endpoint URL.
 * @param feeSponsorSecret - Optional fee sponsor secret key source string.
 * @param predictiveOpts   - Optional predictive scheduling options (issue #492).
 */
export async function runMonitorCycle(
    db: Database.Database,
    network: string,
    rpcUrl?: string,
    feeSponsorSecret?: string,
    predictiveOpts?: PredictiveOptions,
): Promise<MonitorCycleResult> {
    const cycleStartedAt = new Date();

    const result: MonitorCycleResult = {
        contractsChecked: 0,
        entriesUpdated: 0,
        thresholdsCrossed: 0,
        alertsResolved: 0,
        extensionsTriggered: 0,
        extensionErrors: [],
        errors: [],
        cycleStartedAt,
        cycleFinishedAt: cycleStartedAt,   // will be overwritten at the end
        projectedCrossings: [],
    };

    // One RPC client shared across the cycle for the target network.
    const client = new StellarRpcClient(network, rpcUrl);

    // 1. Load all contracts and filter to the target network and active status.
    const contracts = getAllContracts(db).filter(c => c.network === network && c.active === 1);

    logger.debug(`Monitor cycle started — ${contracts.length} contract(s) on ${network}`);

    const tracer = getTracer();

    for (const contract of contracts) {
        const contractSpan: Span = tracer.startSpan("process-contract", {
            attributes: { "contract.id": contract.id },
        });
        result.contractsChecked++;

        try {
            await processContract(db, client, contract.id, network, result);
            endSpan(contractSpan);
        } catch (error: unknown) {
            // Fault isolation: record the failure, move to next contract.
            const message = error instanceof Error ? error.message : String(error);
            const errorEntry = `Error processing contract ${contract.id}: ${message}`;
            result.errors.push(errorEntry);
            logger.error(errorEntry, error);
            endSpan(contractSpan, error);
        }
    }

    // Auto-extension phase: check extension_policies and submit transactions for
    // entries whose TTL fell below the configured threshold.
    try {
        const ext = await runAutoExtensions(db, network, rpcUrl, feeSponsorSecret, predictiveOpts);
        result.extensionsTriggered = ext.entriesExtended;
        result.extensionErrors = ext.errors;
        if (ext.entriesExtended > 0) {
            logger.info(
                `Auto-extensions — contracts: ${ext.contractsExtended}, ` +
                `entries: ${ext.entriesExtended}`,
            );
        }
        for (const e of ext.extensions) {
            if (e.isAnomaly) {
                logger.warn(`Cost anomaly — contract: ${e.contractId}: ${e.anomalyDetails}`);
            }
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.extensionErrors = [msg];
        logger.error("runAutoExtensions threw unexpectedly", err);
    }

    result.cycleFinishedAt = new Date();

    logger.debug(
        `Monitor cycle finished — checked: ${result.contractsChecked}, ` +
        `updated: ${result.entriesUpdated}, ` +
        `crossed: ${result.thresholdsCrossed}, ` +
        `resolved: ${result.alertsResolved}, ` +
        `extended: ${result.extensionsTriggered}, ` +
        `errors: ${result.errors.length}`,
    );

    return result;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Process a single contract within a cycle.
 * Throws on RPC failure — caller handles fault isolation.
 */
async function processContract(
    db: Database.Database,
    client: StellarRpcClient,
    contractId: string,
    network: string,
    result: MonitorCycleResult,
): Promise<void> {
    const entries = getEntriesForContract(db, contractId);

    // If this contract has no tracked entries there is nothing to do.
    // We skip the RPC call entirely to avoid unnecessary network traffic.
    if (entries.length === 0) {
        logger.debug(`Contract ${contractId} has no tracked entries — skipping RPC call`);
        return;
    }

    // 2. One batched RPC call for all entry keys of this contract.
    const entryKeyXdrs = entries.map(e => e.entry_key_xdr);
    const rpcResult = await client.getEntryTTLs(entryKeyXdrs);

    // 3. Update last_checked_ledger with the ledger that backed this RPC response.
    updateLastCheckedLedger(db, contractId, rpcResult.latestLedger);

    // Build a lookup map: entryKeyXdr → RPC data.
    const rpcMap = new Map(
        rpcResult.entries.map(e => [e.entryKeyXdr, e]),
    );

    // Load alert configurations once per contract.
    const alertConfigs = getAlertConfigsForContract(db, contractId);

    // Load extension policy once — needed for predictive threshold projection.
    const policy = getExtensionPolicy(db, contractId);

    for (const entry of entries) {
        const rpcEntry = rpcMap.get(entry.entry_key_xdr);

        if (!rpcEntry) {
            // Entry not returned by the RPC — possibly archived.
            // Do NOT zero out the DB value; leave it stale rather than destructive.
            logger.debug(
                `Contract ${contractId}: entry ${entry.entry_key_xdr} not returned by RPC (possibly archived)`,
            );
            continue;
        }

        // 3a. Persist fresh TTL data.
        upsertEntry(db, {
            contract_id:          contractId,
            entry_key_xdr:        entry.entry_key_xdr,
            entry_type:           entry.entry_type,
            label:                entry.label ?? undefined,
            live_until_ledger:    rpcEntry.liveUntilLedgerSeq,
            last_modified_ledger: rpcEntry.lastModifiedLedgerSeq,
            discovery_source:     entry.discovery_source,
        });

        result.entriesUpdated++;

        // 3b. Record TTL sample for predictive decay-rate calculation (issue #492).
        insertTTLSample(db, entry.id, rpcResult.latestLedger, rpcEntry.liveUntilLedgerSeq);
        pruneOldTTLSamples(db, entry.id);

        // 3c. Compute projected crossing ledger for this entry when a policy exists.
        const thresholdLedgers = policy?.extend_when_below_ledgers ?? null;
        if (thresholdLedgers !== null) {
            const samples = getTTLSamples(db, entry.id);
            const decayRate = computeDecayRate(samples);
            const projectedLedger = projectCrossingLedger(
                decayRate,
                rpcEntry.remainingTTL,
                thresholdLedgers,
                rpcResult.latestLedger,
            );

            result.projectedCrossings.push({
                contractId,
                entryKeyXdr: entry.entry_key_xdr,
                projectedCrossingLedger: projectedLedger,
                projectedCrossingAt: projectedLedger !== null
                    ? approximateLedgerTimestamp(projectedLedger, rpcResult.latestLedger)
                    : null,
            });
        }

        // 4 & 5. Threshold detection and resolution.
        if (alertConfigs.length === 0) continue;

        const remainingTTL = rpcEntry.remainingTTL;

        for (const alertConfig of alertConfigs) {
            if (!alertConfig.enabled) continue; // disabled configs never fire

            const isBelowThreshold = remainingTTL < alertConfig.threshold_ledgers;

            if (isBelowThreshold) {
                // 4. TTL is below threshold — fire if not already unresolved.
                if (!hasUnresolvedAlert(db, alertConfig.id, entry.id)) {
                    const additionalTargets = getAlertConfigTargets(db, alertConfig.id);
                    const allTargets = [
                        { channel_type: alertConfig.channel_type, channel_target: alertConfig.channel_target },
                        ...additionalTargets
                    ];

                    for (const target of allTargets) {
                        recordAlertFired(db, {
                            alert_config_id:   alertConfig.id,
                            contract_entry_id: entry.id,
                            fired_at_ledger:   rpcResult.latestLedger,
                            ttl_at_fire:       remainingTTL,
                            channel_type:      target.channel_type,
                            channel_target:    target.channel_target,
                        });
                    }
                    result.thresholdsCrossed++;

                    logger.warn(
                        `Threshold crossed — contract: ${contractId}, ` +
                        `entry: ${entry.entry_key_xdr}, ` +
                        `remainingTTL: ${remainingTTL}, ` +
                        `threshold: ${alertConfig.threshold_ledgers}`,
                    );
                }
            } else {
                // 5. TTL is at or above threshold — resolve any open alert.
                if (hasUnresolvedAlert(db, alertConfig.id, entry.id)) {
                    const resolvedConfigIds = resolveAlerts(db, entry.id, alertConfig.id);
                    result.alertsResolved++;

                    logger.info(
                        `Alert resolved — contract: ${contractId}, ` +
                        `entry: ${entry.entry_key_xdr}, ` +
                        `remainingTTL: ${remainingTTL}, ` +
                        `threshold: ${alertConfig.threshold_ledgers}`,
                    );

                    // Send resolution notifications (best-effort, errors don't block).
                    for (const configId of resolvedConfigIds) {
                        const config = getAlertConfigById(db, configId);
                        if (!config) continue;

                        const event = buildAlertEvent({
                            type: "alert_resolved",
                            contractId,
                            contractName: null,
                            network,
                            entryKeyXdr: entry.entry_key_xdr,
                            entryType: entry.entry_type,
                            entryLabel: entry.label,
                            configuredLedgers: config.threshold_ledgers,
                            remainingTTL,
                            firedAtLedger: rpcResult.latestLedger,
                        });

                        const additionalTargets = getAlertConfigTargets(db, config.id);
                        const allTargets = [
                            { channel_type: config.channel_type, channel_target: config.channel_target },
                            ...additionalTargets
                        ];

                        for (const target of allTargets) {
                            // Best-effort — log failures so they're visible, but don't block.
                            deliverSingleAlert(
                                target.channel_type,
                                target.channel_target,
                                event,
                                config.webhook_secret,
                            ).catch((err: unknown) => {
                                logger.warn(
                                    `Resolution notification failed for config ${configId} target ${target.channel_type}:${target.channel_target}: ${err instanceof Error ? err.message : String(err)}`,
                                );
                            });
                        }
                    }
                }
            }
        }
    }
}

/**
 * Approximate a wall-clock ISO-8601 timestamp for a future ledger.
 */
function approximateLedgerTimestamp(targetLedger: number, currentLedger: number): string {
    return new Date(Date.now() + ledgersToMilliseconds(targetLedger - currentLedger)).toISOString();
}
