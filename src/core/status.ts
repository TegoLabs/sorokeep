import type Database from "better-sqlite3";
import { getContract, getEntriesForContract, getExtensionPolicy, getTTLSamples } from "../db/repositories.js";
import type { ContractEntry } from "../db/repositories.js";
import {
    classifyTTL,
    formatTimeToCloseLedger,
    type TTLStatus,
} from "../utils/formatting.js";
import { computeDecayRate, projectCrossingLedger } from "./predictive.js";
import { ledgersToMilliseconds } from "../utils/ledger.js";

export type EntryTTLStatus = TTLStatus | "unknown";

export type ContractStatusEntry = {
    label: string;
    entryType: string;
    entryKeyXdr: string;
    liveUntilLedger: number | null;
    remainingTTL: number | null;
    approximateTimeRemaining: string | null;
    status: EntryTTLStatus;
    /** Projected ledger at which TTL will cross the guard threshold. Null if not enough data. */
    projectedCrossingLedger: number | null;
    /** ISO-8601 approximate wall-clock time for the projected crossing. */
    projectedCrossingAt: string | null;
};

export type ContractStatus = {
    contractId: string;
    name: string | null;
    network: string;
    lastCheckedLedger: number | null;
    entries: ContractStatusEntry[];
};

export class ContractNotFoundError extends Error {
    constructor(contractId: string) {
        super(`Contract ${contractId} is not registered.`);
        this.name = "ContractNotFoundError";
    }
}

function getEntryLabel(entry: ContractEntry): string {
    if (entry.entry_type === "instance") return "Instance";
    if (entry.entry_type === "wasm") return "WASM Code";
    return entry.label ?? entry.entry_type;
}

function mapEntryStatus(
    db: Database.Database,
    entry: ContractEntry,
    lastCheckedLedger: number | null,
    thresholdLedgers: number | null,
): ContractStatusEntry {
    const label = getEntryLabel(entry);
    const liveUntilLedger = entry.live_until_ledger ?? null;

    if (liveUntilLedger == null || lastCheckedLedger == null) {
        return {
            label,
            entryType: entry.entry_type,
            entryKeyXdr: entry.entry_key_xdr,
            liveUntilLedger,
            remainingTTL: null,
            approximateTimeRemaining: null,
            status: "unknown",
            projectedCrossingLedger: null,
            projectedCrossingAt: null,
        };
    }

    const remainingTTL = liveUntilLedger - lastCheckedLedger;
    const status = classifyTTL(remainingTTL);

    // Compute projected crossing if a threshold is configured and enough samples exist.
    let projectedCrossingLedger: number | null = null;
    let projectedCrossingAt: string | null = null;

    if (thresholdLedgers !== null) {
        const samples = getTTLSamples(db, entry.id);
        const decayRate = computeDecayRate(samples);
        projectedCrossingLedger = projectCrossingLedger(
            decayRate,
            remainingTTL,
            thresholdLedgers,
            lastCheckedLedger,
        );

        if (projectedCrossingLedger !== null) {
            // Must use the same basis as `approximateTimeRemaining` below, which
            // goes through formatTimeToCloseLedger. These two fields describe the
            // same moment and previously disagreed by 10%.
            const deltaMs = ledgersToMilliseconds(projectedCrossingLedger - lastCheckedLedger);
            projectedCrossingAt = new Date(Date.now() + deltaMs).toISOString();
        }
    }

    return {
        label,
        entryType: entry.entry_type,
        entryKeyXdr: entry.entry_key_xdr,
        liveUntilLedger,
        remainingTTL,
        approximateTimeRemaining: formatTimeToCloseLedger(remainingTTL),
        status,
        projectedCrossingLedger,
        projectedCrossingAt,
    };
}

export function getContractStatus(db: Database.Database, contractId: string): ContractStatus {
    const contract = getContract(db, contractId);

    if (!contract) {
        throw new ContractNotFoundError(contractId);
    }

    const lastCheckedLedger = contract.last_checked_ledger ?? null;

    // Determine the configured extension threshold (if any) for projection display.
    const policy = getExtensionPolicy(db, contractId);
    const thresholdLedgers = policy?.extend_when_below_ledgers ?? null;

    const entries = getEntriesForContract(db, contractId).map((entry) =>
        mapEntryStatus(db, entry, lastCheckedLedger, thresholdLedgers),
    );

    return {
        contractId: contract.id,
        name: contract.name,
        network: contract.network,
        lastCheckedLedger,
        entries,
    };
}
