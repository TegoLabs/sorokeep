import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import type Database from "better-sqlite3";
import { getDatabase } from "../db/database.js";
import { getContract, getEntriesForContract, upsertExtensionPolicy, getExtensionPolicy, getEffectivePolicy, setEntryTypePolicy, deleteEntryTypePolicy, type EntryType } from "../db/repositories.js";
import { rollbackExtensionPolicy, listPolicyHistory } from "../db/guard_policy_history.js";
import { getPreset, PRESET_NAMES } from "../core/guard-presets.js";
import { simulateExtension, extendEntries, resolveSecretKey } from "../core/extension.js";
import { applyGuardPolicyByTag } from "../core/fleet.js";
import { getExtensionCosts } from "../core/costs.js";
import { formatContractID, formatTimeToCloseLedger, formatBytes, formatCpuInsns, printOutput, validateContractId, convertLedgerCloseTimeToSeconds } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";
import { handleRpcUnreachableError } from "../rpc/client.js";

const logger = getLogger().child({ component: "GuardCommand" });

function getEntryLabel(entry: { entry_type: string; label?: string | null }): string {
    if (entry.entry_type === "instance") return "Instance";
    if (entry.entry_type === "wasm") return "WASM Code";
    return entry.label ?? entry.entry_type;
}

/**
 * Exported extension policy shape — safe for serialization to JSON.
 * Per SECURITY.md: never contains raw secret keys, only public keys and
 * env:/vault: references.
 */
export interface ExportedExtensionPolicy {
    contract_id: string;
    enabled: boolean;
    target_ttl_ledgers: number;
    extend_when_below_ledgers: number;
    keypair_public: string | null;
    keypair_source: string | null;
}

/**
 * Export an extension policy to a JSON-serializable object.
 * SECURITY: never exports raw secret keys — only public keys and env:/vault: references.
 */
export function exportExtensionPolicy(db: Database.Database, contractId: string): ExportedExtensionPolicy {
    const policy = getExtensionPolicy(db, contractId);

    if (!policy) {
        throw new Error(`No extension policy found for contract ${contractId}`);
    }

    return {
        contract_id: policy.contract_id,
        enabled: Boolean(policy.enabled),
        target_ttl_ledgers: policy.target_ttl_ledgers,
        extend_when_below_ledgers: policy.extend_when_below_ledgers,
        keypair_public: policy.keypair_public,
        keypair_source: policy.keypair_source,
    };
}

/**
 * Import an extension policy from an exported JSON object.
 * SECURITY: validates that no raw secret keys are present in the import —
 * only env: and vault: references are allowed for keypair_source.
 */
export function importExtensionPolicy(
    db: Database.Database,
    targetContractId: string,
    exported: ExportedExtensionPolicy,
): void {
    const forbiddenFields = ["keypair_secret", "secret_key", "private_key", "keypair_private"];
    for (const field of forbiddenFields) {
        if (field in exported) {
            throw new Error(`Import contains forbidden secret key field: ${field}`);
        }
    }

    if (typeof exported.enabled !== "boolean") {
        throw new Error("Missing required field: enabled");
    }
    if (typeof exported.target_ttl_ledgers !== "number") {
        throw new Error("Missing required field: target_ttl_ledgers");
    }
    if (typeof exported.extend_when_below_ledgers !== "number") {
        throw new Error("Missing required field: extend_when_below_ledgers");
    }

    if (exported.target_ttl_ledgers <= 0) {
        throw new Error("target_ttl_ledgers must be a positive number");
    }
    if (exported.extend_when_below_ledgers <= 0) {
        throw new Error("extend_when_below_ledgers must be a positive number");
    }
    if (exported.extend_when_below_ledgers >= exported.target_ttl_ledgers) {
        throw new Error("extend_when_below_ledgers must be less than target_ttl_ledgers");
    }

    const hasPublic = exported.keypair_public !== null && exported.keypair_public !== undefined;
    const hasSource = exported.keypair_source !== null && exported.keypair_source !== undefined;

    if (hasPublic !== hasSource) {
        throw new Error("keypair_public and keypair_source must both be present or both null");
    }

    // SECURITY: if keypair_source is present, it must be an env: or vault: reference
    if (exported.keypair_source) {
        if (!exported.keypair_source.startsWith("env:") && !exported.keypair_source.startsWith("vault:")) {
            throw new Error("keypair_source must be an env: or vault: reference, not a raw secret key");
        }
    }

    if (exported.keypair_public) {
        // Stellar public keys start with 'G' and are 56 characters long
        if (!exported.keypair_public.match(/^G[A-Z0-9]{55}$/)) {
            throw new Error("keypair_public must be a valid Stellar public key (starts with G, 56 chars)");
        }
    }

    upsertExtensionPolicy(db, {
        contract_id: targetContractId,
        enabled: exported.enabled,
        target_ttl_ledgers: exported.target_ttl_ledgers,
        extend_when_below_ledgers: exported.extend_when_below_ledgers,
        keypair_public: exported.keypair_public ?? undefined,
        keypair_source: exported.keypair_source ?? undefined,
    });
}

function parseTargetTtlCandidates(rawValue: string): number[] {
    const values = rawValue
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => parseInt(item, 10));

    if (values.length === 0 || values.some((value) => Number.isNaN(value) || value <= 0)) {
        return [];
    }

    return values;
}

function estimateExtensionsPerMonth(targetTtlLedgers: number): number {
    const secondsPerLedger = convertLedgerCloseTimeToSeconds(1);
    const ledgersPerMonth = (30 * 24 * 60 * 60) / secondsPerLedger;
    return ledgersPerMonth / targetTtlLedgers;
}

async function runCostEstimateCommand(contractId: string, options: { targetTtl?: string }): Promise<void> {
    try {
        const contractIdValidation = validateContractId(contractId);
        if (!contractIdValidation.valid) {
            console.error(chalk.red(`Invalid contract ID: ${contractIdValidation.reason}`));
            process.exit(1);
            return;
        }

        const db = getDatabase();
        const contract = getContract(db, contractId);

        if (!contract) {
            console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
            process.exit(1);
            return;
        }

        const targetTtls = parseTargetTtlCandidates(options.targetTtl ?? "100000");
        if (targetTtls.length === 0) {
            console.error(chalk.red("--target-ttl must be a comma-separated list of positive numbers"));
            process.exit(1);
            return;
        }

        const costResult = getExtensionCosts(db, contractId, { period: 30 });
        if (!costResult.success) {
            console.error(chalk.red(`Unable to estimate cost for ${formatContractID(contractId)}.`));
            process.exit(1);
            return;
        }

        if (costResult.data.summary.totalExtensions === 0) {
            console.log(chalk.yellow(`No extension history found for ${contract.name ?? formatContractID(contractId)}. Unable to estimate monthly costs.`));
            return;
        }

        const averageCostPerExtension = costResult.data.summary.totalCostXlm / costResult.data.summary.totalExtensions;
        const rows = targetTtls.map((targetTtl) => {
            const estimatedExtensionsPerMonth = estimateExtensionsPerMonth(targetTtl);
            return {
                targetTtl,
                estimatedExtensionsPerMonth,
                estimatedMonthlyCost: estimatedExtensionsPerMonth * averageCostPerExtension,
            };
        });

        console.log();
        console.log(chalk.bold(`  Estimated monthly cost for ${contract.name ?? formatContractID(contractId)}:`));
        console.log();
        console.log(`  ${"Target TTL".padEnd(14)} ${"Est. Extensions/Month".padEnd(24)} Est. Monthly Cost`);
        for (const row of rows) {
            console.log(
                `  ${String(row.targetTtl).padEnd(14)} ${row.estimatedExtensionsPerMonth.toFixed(3).padEnd(24)} ${row.estimatedMonthlyCost.toFixed(6)} XLM`,
            );
        }
        console.log();
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("Guard cost-estimate failed", { error: msg });
        if (!handleRpcUnreachableError(error)) {
            console.error(chalk.red(`Error: ${msg}`));
        }
        process.exit(1);
    }
}

/**
 * Resolves --preset into --target-ttl/--threshold values, or returns an
 * error message if --preset is unknown or combined with an explicit
 * --target-ttl/--threshold (issue #494: the intent is ambiguous otherwise).
 * A no-op ({}) is returned when --preset was not supplied.
 */
function resolvePresetOptions(options: { preset?: string; targetTtl?: string; threshold?: string }): {
    targetTtl?: string;
    threshold?: string;
    error?: string;
} {
    if (options.preset === undefined) return {};

    const preset = getPreset(options.preset);
    if (!preset) {
        return { error: `Unknown preset "${options.preset}". Valid presets: ${PRESET_NAMES.join(", ")}` };
    }
    if (options.targetTtl !== undefined) {
        return { error: "--preset and --target-ttl are mutually exclusive. Use --preset to pick a named policy or --target-ttl to set a custom value, not both." };
    }
    if (options.threshold !== undefined) {
        return { error: "--preset and --threshold are mutually exclusive. Use --preset to pick a named policy or --threshold to set a custom value, not both." };
    }

    return { targetTtl: String(preset.targetTtl), threshold: String(preset.threshold) };
}

export function registerGuardCommand(program: Command): void {
    const guard = program
        .command("guard")
        .description("Configure auto-extension policy for a contract, or in bulk via --tag");

    guard
        .command("cost-estimate <contractId>")
        .description("Estimate monthly extension cost for one or more candidate target TTL values")
        .option("--target-ttl <values>", "Comma-separated target TTL values in ledgers", "100000")
        .action(async (contractId: string, options: { targetTtl?: string }) => {
            await runCostEstimateCommand(contractId, options);
        });

    guard
        .command("export <contractId>")
        .description("Export a contract's extension policy to JSON (never includes a raw secret key)")
        .option("--out <file>", "Output file path (default: stdout)")
        .action(async (contractId: string, options: { out?: string }) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                    return;
                }

                const exported = exportExtensionPolicy(db, contractId);
                const json = JSON.stringify(exported, null, 2);

                if (options.out) {
                    const fs = await import("node:fs/promises");
                    await fs.writeFile(options.out, json + "\n", "utf-8");
                    console.log(chalk.green(`Extension policy exported to ${options.out}`));
                } else {
                    console.log(json);
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard export failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });

    guard
        .command("import <contractId>")
        .description("Import an extension policy from JSON onto a (possibly different) contract")
        .option("--file <path>", "Input file path (default: stdin)")
        .action(async (contractId: string, options: { file?: string }) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                    return;
                }

                let jsonContent: string;
                if (options.file) {
                    const fs = await import("node:fs/promises");
                    jsonContent = await fs.readFile(options.file, "utf-8");
                } else {
                    const chunks: Buffer[] = [];
                    process.stdin.setEncoding("utf-8");
                    for await (const chunk of process.stdin) {
                        chunks.push(Buffer.from(chunk, "utf-8"));
                    }
                    jsonContent = Buffer.concat(chunks).toString("utf-8");
                }

                const parsed = JSON.parse(jsonContent);
                importExtensionPolicy(db, contractId, parsed);

                console.log(chalk.green(`Extension policy imported successfully for ${contract.name ?? formatContractID(contractId)}`));

                const imported = getExtensionPolicy(db, contractId);
                if (imported) {
                    console.log(`  Status:    ${imported.enabled ? chalk.green("ENABLED") : chalk.yellow("DISABLED")}`);
                    console.log(`  Target:    ${imported.target_ttl_ledgers.toLocaleString()} ledgers`);
                    console.log(`  Threshold: ${imported.extend_when_below_ledgers.toLocaleString()} ledgers`);
                    if (imported.keypair_public) {
                        console.log(`  Funded by: ${imported.keypair_public.slice(0, 8)}...${imported.keypair_public.slice(-4)}`);
                    }
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard import failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });

    guard
        .command("preview")
        .description("Preview which entries would be auto-extended based on cached TTL data (local-only, no RPC calls)")
        .requiredOption("--contract <id>", "The contract ID to preview auto-extension for")
        .action(async (options: { contract: string }) => {
            try {
                const contractId = options.contract;
                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                    return;
                }

                const policy = getExtensionPolicy(db, contractId);

                if (!policy) {
                    console.log(chalk.yellow(`No extension policy configured for ${contract.name ?? formatContractID(contractId)}.`));
                    console.log(chalk.dim("Run 'sorokeep guard <contractId> --auto-extend ...' first."));
                    return;
                }

                const displayName = contract.name ?? formatContractID(contractId);

                console.log();
                console.log(chalk.bold(`  ${displayName}`) + chalk.dim(` (${formatContractID(contractId)})`));
                console.log(`  Network: ${chalk.cyan(contract.network)}`);
                console.log(
                    `  Policy: ${policy.enabled ? chalk.green("ENABLED") : chalk.yellow("DISABLED")}` +
                    ` (threshold: ${policy.extend_when_below_ledgers.toLocaleString()} ledgers, target: ${policy.target_ttl_ledgers.toLocaleString()} ledgers)`,
                );
                const lastCheckedLedger = contract.last_checked_ledger ?? null;
                if (lastCheckedLedger != null) {
                    console.log(chalk.dim(`  Last checked: ledger ${lastCheckedLedger.toLocaleString()}`));
                }
                console.log();

                const entries = getEntriesForContract(db, contractId);

                if (entries.length === 0) {
                    console.log(chalk.yellow("  No entries tracked for this contract."));
                    console.log();
                    return;
                }

                const labels = entries.map((e) => getEntryLabel(e));
                const maxLabelLen = Math.max(...labels.map((l) => l.length));

                for (const entry of entries) {
                    const label = getEntryLabel(entry);
                    const paddedLabel = label.padEnd(maxLabelLen);
                    const liveUntilLedger = entry.live_until_ledger ?? null;

                    if (liveUntilLedger == null || lastCheckedLedger == null) {
                        console.log(`  ${paddedLabel}  TTL: ${chalk.dim("unknown")}`);
                        continue;
                    }

                    const remaining = liveUntilLedger - lastCheckedLedger;
                    const timeRemaining = formatTimeToCloseLedger(remaining);
                    const wouldExtend = remaining >= 0 && remaining < policy.extend_when_below_ledgers;
                    const statusText = wouldExtend
                        ? chalk.bold.yellow("would extend")
                        : remaining < 0
                            ? chalk.bold.magenta("expired")
                            : chalk.bold.green("ok");

                    console.log(
                        `  ${paddedLabel}  TTL: ${remaining.toLocaleString().padStart(9)} ledgers (${timeRemaining})  ${statusText}`,
                    );
                }

                console.log();
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard preview command failed", { error: msg });
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });

    guard
        .command("rollback")
        .description("Roll back an extension policy to a previous historical version, or list its version history")
        .requiredOption("--contract <id>", "The contract ID to roll back")
        .option("--to <historyId>", "Historical policy version ID to restore (defaults to the immediately previous version)")
        .option("--list", "List policy history instead of rolling back")
        .option("--json", "Output machine-readable JSON")
        .action((options: { contract: string; to?: string; list?: boolean; json?: boolean }) => {
            try {
                const db = getDatabase();
                const contract = getContract(db, options.contract);
                if (!contract) {
                    if (options.json) {
                        printOutput({ success: false, error: "contract_not_found", contractId: options.contract }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red(`Contract ${formatContractID(options.contract)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                    return;
                }

                if (options.list) {
                    const history = listPolicyHistory(db, options.contract);
                    if (options.json) {
                        printOutput({ success: true, contractId: options.contract, history }, true);
                        return;
                    }
                    if (history.length === 0) {
                        console.log(chalk.yellow(`No policy history found for ${contract.name ?? formatContractID(options.contract)}.`));
                        return;
                    }
                    console.log(chalk.bold(`\n  Policy history for ${contract.name ?? formatContractID(options.contract)}:`));
                    for (const row of history) {
                        console.log(
                            `  #${row.id}  target=${row.target_ttl_ledgers.toLocaleString()}  threshold=${row.extend_when_below_ledgers.toLocaleString()}  ` +
                            `${row.enabled ? chalk.green("ENABLED") : chalk.yellow("DISABLED")}  ${chalk.dim(row.created_at ?? "")}`,
                        );
                    }
                    console.log();
                    return;
                }

                let historyId: number | undefined;
                if (options.to !== undefined) {
                    historyId = Number.parseInt(options.to, 10);
                    if (!Number.isInteger(historyId) || historyId <= 0) {
                        if (options.json) {
                            printOutput({ success: false, error: "invalid_history_id", to: options.to }, true);
                            process.exitCode = 1;
                            return;
                        }
                        console.error(chalk.red("--to must be a positive history ID."));
                        process.exit(1);
                        return;
                    }
                }

                const restored = rollbackExtensionPolicy(db, options.contract, historyId);

                if (options.json) {
                    printOutput({ success: true, contractId: options.contract, mode: "rollback", restored }, true);
                    return;
                }

                console.log(chalk.green(`Extension policy rolled back for ${contract.name ?? formatContractID(options.contract)}.`));
                console.log(`  Restored history ID: ${restored.id}`);
                console.log(`  Target TTL:          ${restored.target_ttl_ledgers.toLocaleString()} ledgers`);
                console.log(`  Threshold:           ${restored.extend_when_below_ledgers.toLocaleString()} ledgers`);
                console.log(chalk.dim("  Rollback recorded as a new policy history entry."));
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard rollback command failed", { error: msg });
                if (options.json) {
                    printOutput({ success: false, error: msg, contractId: options.contract }, true);
                    process.exitCode = 1;
                    return;
                }
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });

    guard
        .command("entry-type <contractId> <entryType>")
        .description("Set or clear a per-entry-type TTL policy override (instance, wasm, persistent, temporary)")
        .option("--target-ttl <ledgers>", "Target TTL in ledgers after extension for this entry type")
        .option("--threshold <ledgers>", "Extend when TTL drops below this many ledgers for this entry type")
        .option("--clear", "Remove the override, falling back to the contract-level policy")
        .option("--json", "Output machine-readable JSON")
        .action(async (contractId: string, entryType: string, options: { targetTtl?: string; threshold?: string; clear?: boolean; json?: boolean }) => {
            try {
                const validEntryTypes: EntryType[] = ["instance", "wasm", "persistent", "temporary"];
                if (!validEntryTypes.includes(entryType as EntryType)) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_entry_type", entryType, message: `entryType must be one of: ${validEntryTypes.join(", ")}` }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red(`Invalid entry type '${entryType}'. Must be one of: ${validEntryTypes.join(", ")}`));
                    process.exit(1);
                    return;
                }

                const db = getDatabase();
                const contract = getContract(db, contractId);

                if (!contract) {
                    if (options.json) {
                        printOutput({ success: false, error: "contract_not_found", contractId }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                    return;
                }

                if (options.clear) {
                    deleteEntryTypePolicy(db, contractId, entryType);
                    if (options.json) {
                        printOutput({ success: true, contractId, entryType, mode: "cleared" }, true);
                        return;
                    }
                    console.log(chalk.green(`Cleared entry-type override for '${entryType}' on ${contract.name ?? formatContractID(contractId)}`));
                    return;
                }

                if (!options.targetTtl || !options.threshold) {
                    if (options.json) {
                        printOutput({ success: false, error: "missing_options", message: "--target-ttl and --threshold are required (or pass --clear)" }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("--target-ttl and --threshold are required (or pass --clear to remove an override)"));
                    process.exit(1);
                    return;
                }

                const isValidLedgerCount = (raw: string, value: number): boolean =>
                    /^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0;
                const targetTTL = Number(options.targetTtl);
                const threshold = Number(options.threshold);

                if (!isValidLedgerCount(options.targetTtl, targetTTL)) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_target_ttl", targetTtl: options.targetTtl }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("--target-ttl must be a positive number"));
                    process.exit(1);
                    return;
                }

                if (!isValidLedgerCount(options.threshold, threshold)) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_threshold", threshold: options.threshold }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("--threshold must be a positive number"));
                    process.exit(1);
                    return;
                }

                if (threshold >= targetTTL) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_threshold_range", targetTtl: targetTTL, threshold }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("--threshold must be less than --target-ttl"));
                    process.exit(1);
                    return;
                }

                setEntryTypePolicy(db, contractId, entryType as EntryType, { target_ttl_ledgers: targetTTL, extend_when_below_ledgers: threshold });

                if (options.json) {
                    printOutput({ success: true, contractId, entryType, mode: "set", policy: { target_ttl_ledgers: targetTTL, extend_when_below_ledgers: threshold } }, true);
                    return;
                }

                console.log(chalk.green(`Entry-type override set for '${entryType}' on ${contract.name ?? formatContractID(contractId)}`));
                console.log(`  Target TTL:  ${targetTTL.toLocaleString()} ledgers (${formatTimeToCloseLedger(targetTTL)})`);
                console.log(`  Threshold:   ${threshold.toLocaleString()} ledgers (${formatTimeToCloseLedger(threshold)})`);

                const effective = getEffectivePolicy(db, contractId, entryType as EntryType);
                if (effective && !effective.enabled) {
                    console.log(chalk.dim("\n  Note: this contract's auto-extension is currently DISABLED — the override"));
                    console.log(chalk.dim("  will take effect once auto-extension is enabled via 'sorokeep guard --auto-extend'."));
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard entry-type command failed", { error: msg });
                if (options.json) {
                    printOutput({ success: false, error: msg, contractId, entryType }, true);
                    process.exitCode = 1;
                    return;
                }
                console.error(chalk.red(`Error: ${msg}`));
                process.exit(1);
            }
        });

    guard
        .command("simulate <contractId>")
        .description("Simulate a proposed extension policy and compare against the active policy without modifying the database")
        .option("--target-ttl <ledgers>", "Proposed target TTL in ledgers after extension", "100000")
        .option("--threshold <ledgers>", "Proposed threshold in ledgers below which entries trigger extension", "20000")
        .option("--keypair <secret>", "Stellar secret key for simulating extension transactions")
        .option("--keypair-env <var>", "Environment variable containing the secret key for simulation")
        .option("--keypair-vault <path>", "HashiCorp Vault secret path for simulation")
        .option("--json", "Output machine-readable JSON")
        .action(async (
            contractId: string,
            options: {
                targetTtl?: string;
                threshold?: string;
                keypair?: string;
                keypairEnv?: string;
                keypairVault?: string;
                json?: boolean;
            } = {},
        ) => {
            try {
                const contractIdValidation = validateContractId(contractId);
                if (!contractIdValidation.valid) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_contract_id", contractId, message: contractIdValidation.reason }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red(`Invalid contract ID: ${contractIdValidation.reason}`));
                    process.exit(1);
                    return;
                }

                const db = getDatabase();
                const contract = getContract(db, contractId);
                if (!contract) {
                    if (options.json) {
                        printOutput({ success: false, error: "contract_not_found", contractId }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red(`Contract ${formatContractID(contractId)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                    return;
                }

                const targetTtlRaw = options.targetTtl ?? "100000";
                const thresholdRaw = options.threshold ?? "20000";
                const targetTTL = Number(targetTtlRaw);
                const threshold = Number(thresholdRaw);
                const isValidLedgerCount = (raw: string, value: number): boolean =>
                    /^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0;

                if (!isValidLedgerCount(targetTtlRaw, targetTTL)) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_target_ttl", contractId, targetTtl: options.targetTtl }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("--target-ttl must be a positive number"));
                    process.exit(1);
                    return;
                }

                if (!isValidLedgerCount(thresholdRaw, threshold)) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_threshold", contractId, threshold: options.threshold }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("--threshold must be a positive number"));
                    process.exit(1);
                    return;
                }

                if (threshold >= targetTTL) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_threshold_range", contractId, targetTtl: targetTTL, threshold }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("--threshold must be less than --target-ttl"));
                    process.exit(1);
                    return;
                }

                const currentPolicy = getExtensionPolicy(db, contractId);

                let keypairSource: string | undefined;
                if (options.keypairEnv) {
                    keypairSource = `env:${options.keypairEnv}`;
                } else if (options.keypairVault) {
                    keypairSource = `vault:${options.keypairVault}`;
                } else if (options.keypair) {
                    keypairSource = options.keypair;
                }

                let publicKey = currentPolicy?.keypair_public ?? "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
                if (keypairSource) {
                    const secretKey = await resolveSecretKey(keypairSource) ?? undefined;
                    if (!secretKey) {
                        if (options.json) {
                            printOutput({ success: false, error: "secret_resolution_failed", contractId }, true);
                            process.exitCode = 1;
                            return;
                        }
                        console.error(chalk.red(`Failed to resolve secret key from source: ${keypairSource}`));
                        process.exit(1);
                        return;
                    }
                    const { Keypair } = await import("@stellar/stellar-sdk");
                    publicKey = Keypair.fromSecret(secretKey).publicKey();
                }

                const entries = getEntriesForContract(db, contractId);
                const lastCheckedLedger = contract.last_checked_ledger ?? null;

                interface SimulatedEntryComparison {
                    entryKeyXdr: string;
                    entryType: string;
                    label: string;
                    remainingLedgers: number | null;
                    currentTriggers: boolean;
                    proposedTriggers: boolean;
                    transition: "newly_triggers" | "stops_triggering" | "still_triggers" | "unchanged";
                }

                const comparisons: SimulatedEntryComparison[] = entries.map((entry) => {
                    const label = getEntryLabel(entry);
                    const liveUntil = entry.live_until_ledger ?? null;
                    const remaining =
                        liveUntil != null && lastCheckedLedger != null
                            ? liveUntil - lastCheckedLedger
                            : null;

                    const currentTriggers =
                        currentPolicy != null &&
                        remaining != null &&
                        remaining >= 0 &&
                        remaining < currentPolicy.extend_when_below_ledgers;

                    const proposedTriggers =
                        remaining != null &&
                        remaining >= 0 &&
                        remaining < threshold;

                    let transition: SimulatedEntryComparison["transition"] = "unchanged";
                    if (!currentTriggers && proposedTriggers) {
                        transition = "newly_triggers";
                    } else if (currentTriggers && !proposedTriggers) {
                        transition = "stops_triggering";
                    } else if (currentTriggers && proposedTriggers) {
                        transition = "still_triggers";
                    }

                    return {
                        entryKeyXdr: entry.entry_key_xdr,
                        entryType: entry.entry_type,
                        label,
                        remainingLedgers: remaining,
                        currentTriggers,
                        proposedTriggers,
                        transition,
                    };
                });

                const triggeringEntries = comparisons.filter((c) => c.proposedTriggers);
                const newlyTriggering = comparisons.filter((c) => c.transition === "newly_triggers");
                const stoppedTriggering = comparisons.filter((c) => c.transition === "stops_triggering");

                let simulationResult: Awaited<ReturnType<typeof simulateExtension>> | null = null;
                if (entries.length > 0) {
                    const keysToSimulate =
                        triggeringEntries.length > 0
                            ? triggeringEntries.map((c) => c.entryKeyXdr)
                            : entries.map((e) => e.entry_key_xdr);

                    simulationResult = await simulateExtension(
                        db,
                        contractId,
                        keysToSimulate,
                        targetTTL,
                        publicKey,
                    );

                    if (!simulationResult?.success) {
                        if (options.json) {
                            printOutput(
                                {
                                    success: false,
                                    contractId,
                                    mode: "simulate",
                                    error: simulationResult?.error ?? "simulation_failed",
                                },
                                true,
                            );
                            process.exitCode = 1;
                            return;
                        }
                        console.error(chalk.red(`Simulation failed: ${simulationResult?.error ?? "unknown error"}`));
                        handleRpcUnreachableError(simulationResult?.error);
                        process.exit(1);
                        return;
                    }
                }

                if (options.json) {
                    printOutput(
                        {
                            success: true,
                            contractId,
                            mode: "simulate",
                            currentPolicy: currentPolicy
                                ? {
                                      enabled: Boolean(currentPolicy.enabled),
                                      target_ttl_ledgers: currentPolicy.target_ttl_ledgers,
                                      extend_when_below_ledgers: currentPolicy.extend_when_below_ledgers,
                                  }
                                : null,
                            proposedPolicy: {
                                target_ttl_ledgers: targetTTL,
                                extend_when_below_ledgers: threshold,
                            },
                            entries: comparisons,
                            newlyTriggeringCount: newlyTriggering.length,
                            stoppedTriggeringCount: stoppedTriggering.length,
                            triggeringCount: triggeringEntries.length,
                            estimatedFeeStroops: simulationResult?.estimatedFee ?? 0,
                            estimatedFeeXlm:
                                simulationResult?.estimatedFee != null
                                    ? Number((simulationResult.estimatedFee / 10_000_000).toFixed(7))
                                    : 0,
                            simulation: simulationResult,
                        },
                        true,
                    );
                    return;
                }

                const displayName = contract.name ?? formatContractID(contractId);
                console.log();
                console.log(chalk.bold(`  Guard Policy Simulation (Dry-Run) — ${displayName}`));
                console.log();
                console.log(`  ${"Setting".padEnd(18)} ${"Current Active Policy".padEnd(28)} Proposed Policy`);
                console.log(`  ${"─".repeat(18)} ${"─".repeat(28)} ${"─".repeat(28)}`);
                const currentTargetStr = currentPolicy
                    ? `${currentPolicy.target_ttl_ledgers.toLocaleString()} ledgers`
                    : "none";
                const currentThresholdStr = currentPolicy
                    ? `${currentPolicy.extend_when_below_ledgers.toLocaleString()} ledgers`
                    : "none";
                console.log(
                    `  ${"Target TTL".padEnd(18)} ${currentTargetStr.padEnd(28)} ${targetTTL.toLocaleString()} ledgers`,
                );
                console.log(
                    `  ${"Threshold".padEnd(18)} ${currentThresholdStr.padEnd(28)} ${threshold.toLocaleString()} ledgers`,
                );
                console.log();

                if (comparisons.length === 0) {
                    console.log(chalk.yellow("  No entries tracked for this contract."));
                } else {
                    console.log(`  ${"Entry".padEnd(18)} ${"Remaining TTL".padEnd(18)} ${"Current".padEnd(16)} ${"Proposed".padEnd(16)} Change`);
                    console.log(`  ${"─".repeat(18)} ${"─".repeat(18)} ${"─".repeat(16)} ${"─".repeat(16)} ${"─".repeat(20)}`);
                    for (const row of comparisons) {
                        const ttlText =
                            row.remainingLedgers != null
                                ? `${row.remainingLedgers.toLocaleString()} ledgers`
                                : "unknown";
                        const curText = row.currentTriggers ? "triggers" : "ok";
                        const propText = row.proposedTriggers ? "triggers" : "ok";
                        let changeText = "unchanged";
                        if (row.transition === "newly_triggers") {
                            changeText = chalk.yellow("newly triggers");
                        } else if (row.transition === "stops_triggering") {
                            changeText = chalk.cyan("stops triggering");
                        } else if (row.transition === "still_triggers") {
                            changeText = chalk.dim("still triggers");
                        }
                        console.log(
                            `  ${row.label.padEnd(18)} ${ttlText.padEnd(18)} ${curText.padEnd(16)} ${propText.padEnd(16)} ${changeText}`,
                        );
                    }
                }

                console.log();
                console.log(
                    `  Summary: ${triggeringEntries.length} would trigger (${newlyTriggering.length} newly triggering, ${stoppedTriggering.length} stopped triggering)`,
                );
                if (simulationResult?.success) {
                    const xlmFee = ((simulationResult.estimatedFee ?? 0) / 10_000_000).toFixed(7);
                    console.log(
                        `  Simulated Fee: ${xlmFee} XLM (${simulationResult.estimatedFee ?? 0} stroops)`,
                    );
                    if (simulationResult.cpuInsns !== undefined) {
                        console.log(`  CPU:           ${formatCpuInsns(simulationResult.cpuInsns)}`);
                    }
                    if (simulationResult.memBytes !== undefined) {
                        console.log(`  Memory:        ${formatBytes(simulationResult.memBytes)}`);
                    }
                }
                console.log(chalk.dim("  Read-only simulation: active extension policy was not modified."));
                console.log();
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard simulate command failed", { error: msg });
                if (options.json) {
                    printOutput({ success: false, error: msg, contractId }, true);
                    process.exitCode = 1;
                    return;
                }
                if (!handleRpcUnreachableError(error)) {
                    console.error(chalk.red(`Error: ${msg}`));
                }
                process.exit(1);
            }
        });

    // Registered as a real (hidden, default) subcommand rather than attached
    // directly to `guard` via .argument()/.option() — Commander lets a
    // parent's own option silently shadow an identically-named option on a
    // child subcommand when the parent also owns argument/option/action of
    // its own, which broke `guard cost-estimate --target-ttl` above (it kept
    // resolving to this command's --target-ttl default instead of the value
    // the user passed to cost-estimate). Making this its own isDefault
    // subcommand avoids the collision entirely.
    guard
        .command("apply [contractId]", { isDefault: true, hidden: true })
        .description("Configure auto-extension policy for a contract, or in bulk via --tag")
        .option("--tag <tag>", "Apply policy to all contracts matching this tag instead of a single contract")
        .option("--preset <name>", `Use a named policy preset (${PRESET_NAMES.join(" | ")}). Mutually exclusive with --target-ttl and --threshold.`)
        .option("--target-ttl <ledgers>", "Target TTL in ledgers after extension")
        .option("--threshold <ledgers>", "Extend when TTL drops below this many ledgers")
        .option("--keypair <secret>", "Stellar secret key for signing extension transactions")
        .option("--keypair-env <var>", "Environment variable containing the secret key")
        .option("--keypair-vault <path>", "HashiCorp Vault secret path (e.g. secret/data/stellar/mykey)")
        .option("--max-fee <stroops>", "Maximum fee ceiling for a single extension transaction, in stroops")
        .option("--auto-extend", "Enable auto-extension (the daemon will extend automatically)")
        .option("--predictive <cycles>", "Enable predictive mode: extend N cycles before threshold is projected to be crossed (requires --auto-extend)")
        .option("--dry-run", "Simulate the extension without submitting")
        .option("--disable", "Disable auto-extension for this contract")
        .option("--json", "Output machine-readable JSON")
        .action(async (contractId: string | undefined, options: { json?: boolean; tag?: string; preset?: string; targetTtl?: string; threshold?: string; keypair?: string; keypairEnv?: string; keypairVault?: string; maxFee?: string; autoExtend?: boolean; predictive?: string; dryRun?: boolean; disable?: boolean } = {}) => {
            try {
                if (contractId && options.tag) {
                    if (options.json) {
                        printOutput({ success: false, error: "mutually_exclusive_args", message: "Cannot specify both a contract ID and --tag" }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("Cannot specify both a contract ID and --tag"));
                    process.exit(1);
                    return;
                }

                if (!contractId && !options.tag) {
                    if (options.json) {
                        printOutput({ success: false, error: "missing_target", message: "Specify either a <contractId> or --tag <tag>" }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("Please specify either a <contractId> or --tag <tag>"));
                    process.exit(1);
                    return;
                }

                const db = getDatabase();

                if (options.tag) {
                    await applyGuardPolicyToTag(db, options.tag, options);
                    return;
                }

                const contractIdValidation = validateContractId(contractId!);
                if (!contractIdValidation.valid) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_contract_id", contractId, message: contractIdValidation.reason }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red(`Invalid contract ID: ${contractIdValidation.reason}`));
                    process.exit(1);
                    return;
                }

                const contract = getContract(db, contractId!);

                if (!contract) {
                    if (options.json) {
                        printOutput({ success: false, error: "contract_not_found", contractId }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red(`Contract ${formatContractID(contractId!)} not found. Run 'sorokeep watch' first.`));
                    process.exit(1);
                }

                const presetResolution = resolvePresetOptions(options);
                if (presetResolution.error) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_preset", contractId, message: presetResolution.error }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red(presetResolution.error));
                    process.exit(1);
                    return;
                }
                if (presetResolution.targetTtl) options.targetTtl = presetResolution.targetTtl;
                if (presetResolution.threshold) options.threshold = presetResolution.threshold;

                const targetTtlRaw = options.targetTtl ?? "100000";
                const thresholdRaw = options.threshold ?? "20000";
                const targetTTL = Number(targetTtlRaw);
                const threshold = Number(thresholdRaw);
                const isValidLedgerCount = (raw: string, value: number): boolean =>
                    /^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0;

                let maxFee: number | undefined;
                if (options.maxFee !== undefined) {
                    maxFee = Number(options.maxFee);
                    if (!/^\d+$/.test(options.maxFee) || !Number.isSafeInteger(maxFee) || maxFee < 0) {
                        if (options.json) {
                            printOutput({ success: false, error: "invalid_max_fee", contractId, maxFee: options.maxFee }, true);
                            process.exitCode = 1;
                            return;
                        }
                        console.error(chalk.red("--max-fee must be a positive integer"));
                        process.exit(1);
                        return;
                    }
                }

                if (!isValidLedgerCount(targetTtlRaw, targetTTL)) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_target_ttl", contractId, targetTtl: options.targetTtl }, true);
                        process.exitCode = 1;
                        return;
                    }
                    console.error(chalk.red("--target-ttl must be a positive number"));
                    process.exit(1);
                }

                 if (!isValidLedgerCount(thresholdRaw, threshold)) {
                     if (options.json) {
                         printOutput({ success: false, error: "invalid_threshold", contractId, threshold: options.threshold }, true);
                         process.exitCode = 1;
                         return;
                     }
                     console.error(chalk.red("--threshold must be a positive number"));
                     process.exit(1);
                 }

                 if (threshold >= targetTTL) {
                    if (options.json) {
                        printOutput({ success: false, error: "invalid_threshold_range", contractId, targetTtl: targetTTL, threshold }, true);
                        process.exitCode = 1;
                        return;
                    }

                    console.error(chalk.red("--threshold must be less than --target-ttl"));
                    process.exit(1);
                }

                // Handle --disable
                if (options.disable) {
                    upsertExtensionPolicy(db, {
                        contract_id: contractId!,
                        enabled: false,
                        target_ttl_ledgers: targetTTL,
                        extend_when_below_ledgers: threshold,
                        max_fee_stroops: maxFee,
                    });
                    if (options.json) {
                        printOutput({ success: true, contractId, mode: "disabled", policy: { enabled: false, target_ttl_ledgers: targetTTL, extend_when_below_ledgers: threshold, max_fee_stroops: maxFee } }, true);
                        return;
                    }
                    console.log(chalk.yellow(`Auto-extension disabled for ${contract.name ?? formatContractID(contractId!)}`));
                    return;
                }

                // Resolve keypair source
                let keypairSource: string | undefined;
                let secretKey: string | undefined;

                if (options.keypairEnv) {
                    keypairSource = `env:${options.keypairEnv}`;
                } else if (options.keypairVault) {
                    keypairSource = `vault:${options.keypairVault}`;
                } else if (options.keypair) {
                    keypairSource = options.keypair;
                }

                if (keypairSource) {
                    secretKey = await resolveSecretKey(keypairSource) ?? undefined;
                    if (!secretKey) {
                        if (options.json) {
                            printOutput({ success: false, error: "secret_resolution_failed", contractId }, true);
                            process.exitCode = 1;
                            return;
                        }
                        console.error(chalk.red(`Failed to resolve secret key from source: ${keypairSource}`));
                        process.exit(1);
                    }
                }

                // Save policy
                if (options.autoExtend) {
                    if (!keypairSource || !(keypairSource.startsWith("env:") || keypairSource.startsWith("vault:"))) {
                        if (options.json) {
                            printOutput({ success: false, error: "invalid_key_source", contractId, message: "--auto-extend requires --keypair-env or --keypair-vault" }, true);
                            process.exitCode = 1;
                            return;
                        }
                        console.error(chalk.red("--auto-extend requires --keypair-env or --keypair-vault so the daemon can resolve the key at runtime"));
                        process.exit(1);
                    }

                    // Extract public key from secret for storage (never store the secret itself)
                    const { Keypair } = await import("@stellar/stellar-sdk");
                    const kp = Keypair.fromSecret(secretKey!);

                    let predictiveCycles = 0;
                    if (options.predictive !== undefined) {
                        predictiveCycles = Number(options.predictive);
                        if (!/^\d+$/.test(options.predictive) || !Number.isSafeInteger(predictiveCycles)) {
                            if (options.json) {
                                printOutput({ success: false, error: "invalid_predictive", contractId, predictive: options.predictive }, true);
                                process.exitCode = 1;
                                return;
                            }
                            console.error(chalk.red("--predictive must be a non-negative integer number of cycles"));
                            process.exit(1);
                            return;
                        }
                    }

                    upsertExtensionPolicy(db, {
                        contract_id: contractId!,
                        enabled: true,
                        target_ttl_ledgers: targetTTL,
                        extend_when_below_ledgers: threshold,
                        keypair_public: kp.publicKey(),
                        keypair_source: keypairSource!,
                        max_fee_stroops: maxFee,
                        predictive_cycles: predictiveCycles,
                    });

                    if (options.json) {
                        printOutput({ success: true, contractId, mode: "auto-extend", policy: { enabled: true, target_ttl_ledgers: targetTTL, extend_when_below_ledgers: threshold, keypair_source: keypairSource, keypair_public: kp.publicKey(), max_fee_stroops: maxFee, predictive_cycles: predictiveCycles } }, true);
                        return;
                    }

                    console.log(chalk.green(`\nAuto-extension enabled for ${contract.name ?? formatContractID(contractId!)}`));
                    console.log(`  Target TTL:  ${targetTTL.toLocaleString()} ledgers (${formatTimeToCloseLedger(targetTTL)})`);
                    console.log(`  Threshold:   ${threshold.toLocaleString()} ledgers (${formatTimeToCloseLedger(threshold)})`);
                    if (maxFee !== undefined) {
                        console.log(`  Max Fee:     ${maxFee.toLocaleString()} stroops`);
                    }
                    console.log(`  Funded by:   ${kp.publicKey().slice(0, 8)}...${kp.publicKey().slice(-4)}`);
                    if (predictiveCycles > 0) {
                        console.log(`  Predictive:  ${predictiveCycles} cycle(s) ahead`);
                    }
                    console.log(chalk.dim("\n  The daemon will auto-extend when TTL drops below the threshold."));
                    console.log(chalk.dim("  Run 'sorokeep daemon --network " + contract.network + "' to start monitoring."));
                    return;
                }

                // Dry-run: simulate extension
                if (options.dryRun) {
                    if (!secretKey) {
                        if (options.json) {
                            printOutput({ success: false, error: "missing_keypair", contractId, message: "--keypair, --keypair-env, or --keypair-vault required for dry-run simulation" }, true);
                            process.exitCode = 1;
                            return;
                        }
                        console.error(chalk.red("--keypair, --keypair-env, or --keypair-vault required for dry-run simulation"));
                        process.exit(1);
                    }

                     const entries = getEntriesForContract(db, contractId!);
                     if (entries.length === 0) {
                         if (options.json) {
                             printOutput({ success: true, contractId, mode: "dry-run", message: "No entries to extend", entriesExtended: 0 }, true);
                             return;
                         }
                         console.log(chalk.yellow("No entries to extend"));
                         return;
                     }

                     const spinner = !options.json ? ora("Simulating extension...").start() : undefined;
                     const { Keypair } = await import("@stellar/stellar-sdk");
                     const kp = Keypair.fromSecret(secretKey);

                     const result = await simulateExtension(
                         db,
                         contractId!,
                         entries.map(e => e.entry_key_xdr),
                         targetTTL,
                         kp.publicKey(),
                     );

                     if (result?.success) {
                        if (options.json) {
                            printOutput({ success: true, contractId, mode: "dry-run", result }, true);
                            return;
                        }
                         spinner?.succeed(chalk.green("Simulation successful"));
                        logger.info("Simulation successful in guard.ts");
                        console.log(`  Entries:       ${result.entriesExtended}`);
                        console.log(`  Estimated fee: ${(result.estimatedFee! / 10_000_000).toFixed(7)} XLM`);
                        console.log(`  CPU:          ${formatCpuInsns(result.cpuInsns!)}`);
                        console.log(`  Memory:       ${formatBytes(result.memBytes!)}`);
                        if (result.readBytes !== undefined) {
                            console.log(`  Read size:    ${formatBytes(result.readBytes)}`);
                        }
                        if (result.writeBytes !== undefined) {
                            console.log(`  Write size:   ${formatBytes(result.writeBytes)}`);
                        }
                    } else {
                         if (options.json) {
                            printOutput({ success: false, contractId, mode: "dry-run", error: result?.error ?? "simulation_failed" }, true);
                            process.exitCode = 1;
                            return;
                        }
                         spinner?.fail(chalk.red(`Simulation failed: ${result.error}`));
                         handleRpcUnreachableError(result.error);
                     }
                     return;

                }

                // One-time manual extension
                if (secretKey) {
                    const entries = getEntriesForContract(db, contractId!);
                    if (entries.length === 0) {
                        if (options.json) {
                            printOutput({ success: true, contractId, mode: "manual-extend", message: "No entries to extend", entriesExtended: 0 }, true);
                            return;
                        }
                        console.log(chalk.yellow("No entries to extend"));
                        return;
                    }

                    const spinner = !options.json ? ora("Extending TTL...").start() : undefined;
                    const result = await extendEntries(
                        db,
                        contractId!,
                        entries.map(e => e.entry_key_xdr),
                        targetTTL,
                        secretKey,
                    );

                    if (result.success) {
                        if (options.json) {
                            printOutput({ success: true, contractId, mode: "manual-extend", result }, true);
                            return;
                        }
                        spinner?.succeed(chalk.green("TTL extended successfully"));
                        console.log(`  Entries:  ${result.entriesExtended}`);
                        console.log(`  Tx hash:  ${result.txHash}`);
                        console.log(`  Ledger:   ${result.ledger}`);
                    } else {
                        if (options.json) {
                            printOutput({ success: false, error: result.error, contractId, mode: "manual-extend" }, true);
                            process.exitCode = 1;
                            return;
                        }
                        spinner?.fail(chalk.red(`Extension failed: ${result.error}`));
                        handleRpcUnreachableError(result.error);
                        process.exit(1);
                    }
                    return;
                }

                // No keypair provided - just show current policy
                const policy = getExtensionPolicy(db, contractId!);
                if (options.json) {
                    printOutput({ success: true, contractId, policy: policy ?? null, message: policy ? "Extension policy loaded" : "No extension policy configured" }, true);
                    return;
                }
                if (policy) {
                    console.log(`\nExtension policy for ${contract.name ?? formatContractID(contractId!)}:`);
                    console.log(`  Status:    ${policy.enabled ? chalk.green("ENABLED") : chalk.yellow("DISABLED")}`);
                    console.log(`  Target:    ${policy.target_ttl_ledgers.toLocaleString()} ledgers (${formatTimeToCloseLedger(policy.target_ttl_ledgers)})`);
                    console.log(`  Threshold: ${policy.extend_when_below_ledgers.toLocaleString()} ledgers (${formatTimeToCloseLedger(policy.extend_when_below_ledgers)})`);
                    if (policy.max_fee_stroops != null) {
                        console.log(`  Max Fee:   ${policy.max_fee_stroops.toLocaleString()} stroops`);
                    }
                    if (policy.keypair_public) {
                        console.log(`  Funded by: ${policy.keypair_public.slice(0, 8)}...${policy.keypair_public.slice(-4)}`);
                    }
                    if (policy.keypair_source) {
                        console.log(`  Key source: ${policy.keypair_source}`);
                    }
                    if (policy.predictive_cycles > 0) {
                        console.log(`  Predictive: ${policy.predictive_cycles} cycle(s) ahead`);
                    }
                } else {
                    console.log(chalk.dim("\nNo extension policy configured for this contract."));
                    console.log(chalk.dim("Use --auto-extend with --keypair-env or --keypair-vault to enable auto-extension."));
                }
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("Guard command failed", { error: msg });
                if (options.json) {
                    printOutput({ success: false, error: msg, contractId }, true);
                    process.exitCode = 1;
                    return;
                }
                if (!handleRpcUnreachableError(error)) {
                    console.error(chalk.red(`Error: ${msg}`));
                }
                process.exit(1);
            }
        });
}

interface TagPolicyOptions {
    json?: boolean;
    preset?: string;
    targetTtl?: string;
    threshold?: string;
    keypair?: string;
    keypairEnv?: string;
    keypairVault?: string;
    maxFee?: string;
    autoExtend?: boolean;
    disable?: boolean;
}

async function applyGuardPolicyToTag(
    db: ReturnType<typeof getDatabase>,
    tag: string,
    options: TagPolicyOptions,
): Promise<void> {
    const presetResolution = resolvePresetOptions(options);
    if (presetResolution.error) {
        if (options.json) {
            printOutput({ success: false, error: "invalid_preset", tag, message: presetResolution.error }, true);
            process.exitCode = 1;
            return;
        }
        console.error(chalk.red(presetResolution.error));
        process.exit(1);
        return;
    }
    if (presetResolution.targetTtl) options.targetTtl = presetResolution.targetTtl;
    if (presetResolution.threshold) options.threshold = presetResolution.threshold;

    const targetTtlRaw = options.targetTtl ?? "100000";
    const thresholdRaw = options.threshold ?? "20000";
    const targetTTL = Number(targetTtlRaw);
    const threshold = Number(thresholdRaw);
    const isValidLedgerCount = (raw: string, value: number): boolean =>
        /^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0;

    if (!isValidLedgerCount(targetTtlRaw, targetTTL)) {
        if (options.json) {
            printOutput({ success: false, error: "invalid_target_ttl", tag, targetTtl: options.targetTtl }, true);
            process.exitCode = 1;
            return;
        }
        console.error(chalk.red("--target-ttl must be a positive number"));
        process.exit(1);
        return;
    }

    if (!isValidLedgerCount(thresholdRaw, threshold)) {
        if (options.json) {
            printOutput({ success: false, error: "invalid_threshold", tag, threshold: options.threshold }, true);
            process.exitCode = 1;
            return;
        }
        console.error(chalk.red("--threshold must be a positive number"));
        process.exit(1);
        return;
    }

    if (threshold >= targetTTL) {
        if (options.json) {
            printOutput({ success: false, error: "invalid_threshold_range", tag, targetTtl: targetTTL, threshold }, true);
            process.exitCode = 1;
            return;
        }
        console.error(chalk.red("--threshold must be less than --target-ttl"));
        process.exit(1);
        return;
    }

    let maxFee: number | undefined;
    if (options.maxFee !== undefined) {
        maxFee = Number(options.maxFee);
        if (!/^\d+$/.test(options.maxFee) || !Number.isSafeInteger(maxFee) || maxFee < 0) {
            if (options.json) {
                printOutput({ success: false, error: "invalid_max_fee", tag, maxFee: options.maxFee }, true);
                process.exitCode = 1;
                return;
            }
            console.error(chalk.red("--max-fee must be a non-negative integer"));
            process.exit(1);
            return;
        }
    }

    let keypairSource: string | undefined;
    let secretKey: string | undefined;

    if (options.keypairEnv) {
        keypairSource = `env:${options.keypairEnv}`;
    } else if (options.keypairVault) {
        keypairSource = `vault:${options.keypairVault}`;
    } else if (options.keypair) {
        keypairSource = options.keypair;
    }

    if (keypairSource) {
        secretKey = await resolveSecretKey(keypairSource) ?? undefined;
        if (!secretKey) {
            if (options.json) {
                printOutput({ success: false, error: "secret_resolution_failed", tag }, true);
                process.exitCode = 1;
                return;
            }
            console.error(chalk.red(`Failed to resolve secret key from source: ${keypairSource}`));
            process.exit(1);
            return;
        }
    }

    if (options.autoExtend) {
        if (!keypairSource || !(keypairSource.startsWith("env:") || keypairSource.startsWith("vault:"))) {
            if (options.json) {
                printOutput({ success: false, error: "invalid_key_source", tag, message: "--auto-extend requires --keypair-env or --keypair-vault" }, true);
                process.exitCode = 1;
                return;
            }
            console.error(chalk.red("--auto-extend requires --keypair-env or --keypair-vault so the daemon can resolve the key at runtime"));
            process.exit(1);
            return;
        }
    }

    let keypairPublic: string | undefined;
    if (options.autoExtend && secretKey) {
        const { Keypair } = await import("@stellar/stellar-sdk");
        const kp = Keypair.fromSecret(secretKey);
        keypairPublic = kp.publicKey();
    }

    const results = applyGuardPolicyByTag(db, tag, {
        enabled: options.disable ? false : true,
        target_ttl_ledgers: targetTTL,
        extend_when_below_ledgers: threshold,
        keypair_public: keypairPublic,
        keypair_source: keypairSource,
        max_fee_stroops: maxFee,
    });

    const successCount = results.filter((r) => r.status === "ok").length;
    const failures = results.filter((r) => r.status === "error");

    if (options.json) {
        printOutput({ success: failures.length === 0, tag, applied: successCount, failed: failures.length, results }, true);
        if (failures.length > 0) {
            process.exitCode = 1;
        }
        return;
    }

    if (results.length === 0) {
        console.log(chalk.yellow(`No contracts matched tag '${tag}'.`));
        return;
    }

    console.log(chalk.green(`Applied policy to ${successCount} contract(s) matching tag '${tag}'`));
    if (failures.length > 0) {
        console.error(chalk.red(`Failed to update ${failures.length} contract(s):`));
        for (const res of failures) {
            console.error(chalk.red(`  ${formatContractID(res.contractId)}: ${res.error}`));
        }
        process.exitCode = 1;
    }
}