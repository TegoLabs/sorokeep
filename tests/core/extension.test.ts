import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import {
    insertContract,
    upsertEntry,
    upsertExtensionPolicy,
    getEntriesForContract,
    recordExtension,
    getExtensionHistory,
    upsertChannelAccount,
    updateChannelBalance,
    insertAlertConfig,
    setEntryTypePolicy,
} from "../../src/db/repositories.js";

// ─── Mock RPC client ────────────────────────────────────────────────────────

const mockSubmitExtension = vi.fn();
const mockSubmitRestore = vi.fn();
const mockGetEntryTTLs = vi.fn();
const mockGetCurrentLedger = vi.fn();
const mockSimulateExtension = vi.fn();
const mockSimulateRestore = vi.fn();

vi.mock("../../src/rpc/client.js", () => {
    return {
        StellarRpcClient: class MockStellarRpcClient {
            constructor() {}
            submitExtension = mockSubmitExtension;
            submitRestore = mockSubmitRestore;
            getEntryTTLs = mockGetEntryTTLs;
            getCurrentLedger = mockGetCurrentLedger;
            simulateExtension = mockSimulateExtension;
            simulateRestore = mockSimulateRestore;
        },
    };
});

// Mock alert dispatcher
const mockDeliverSingleAlert = vi.fn();

vi.mock("../../src/alerts/dispatcher.js", () => ({
    deliverSingleAlert: mockDeliverSingleAlert,
}));

// Import after mocking
const { extendEntries, restoreEntries, simulateExtension, simulateRestore, runAutoExtensions, clearSimulationCache, isRateLimited, HOURLY_RATE_LIMIT } = await import(
    "../../src/core/extension.js"
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function seedContract(db: Database.Database, overrides?: Partial<{ id: string; network: string; name: string }>) {
    const id = overrides?.id ?? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    insertContract(db, {
        id,
        name: overrides?.name ?? "Test Contract",
        network: overrides?.network ?? "testnet",
    });

    upsertEntry(db, {
        contract_id: id,
        entry_key_xdr: "instance-key-xdr",
        entry_type: "instance",
        label: "Contract Instance",
        live_until_ledger: 2500000,
        last_modified_ledger: 2400000,
        discovery_source: "deterministic",
    });

    upsertEntry(db, {
        contract_id: id,
        entry_key_xdr: "wasm-key-xdr",
        entry_type: "wasm",
        label: "WASM Code",
        live_until_ledger: 2600000,
        last_modified_ledger: 2400000,
        discovery_source: "deterministic",
    });

    return id;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Core Extension Logic", () => {
    let db: Database.Database;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        db = getDatabaseForTesting();
        vi.clearAllMocks();
        clearSimulationCache(); // Clear the global simulation cache between tests (issue #501)
    });

    afterEach(() => {
        // Restore env vars
        for (const [key, val] of Object.entries(savedEnv)) {
            if (val === undefined) delete process.env[key];
            else process.env[key] = val;
        }
    });

    function setEnv(key: string, value: string) {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
    }

    // =========================================================================
    // 1. extendEntries
    // =========================================================================
    describe("extendEntries", () => {
        it("returns error when contract not found", async () => {
            const result = await extendEntries(
                db, "NONEXISTENT", ["key1"], 100000, "SECRETKEY123",
            );
            expect(result.success).toBe(false);
            expect(result.error).toBe("Contract not found");
        });

        it("returns error when no entries provided", async () => {
            const contractId = seedContract(db);
            const result = await extendEntries(db, contractId, [], 100000, "SECRETKEY123");
            expect(result.success).toBe(false);
            expect(result.error).toBe("No entries to extend");
        });

        it("extends entries and records history on success", async () => {
            const contractId = seedContract(db);
            const entries = getEntriesForContract(db, contractId);

            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "abc123txhash",
                cpuInsns: 10000,
                memBytes: 1024,
                ledger: 2500100,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2500100,
                entries: [
                    {
                        entryKeyXdr: "instance-key-xdr",
                        latestLedger: 2500100,
                        liveUntilLedgerSeq: 2600100,
                        lastModifiedLedgerSeq: 2500100,
                        remainingTTL: 100000,
                    },
                    {
                        entryKeyXdr: "wasm-key-xdr",
                        latestLedger: 2500100,
                        liveUntilLedgerSeq: 2700100,
                        lastModifiedLedgerSeq: 2500100,
                        remainingTTL: 200000,
                    },
                ],
            });

            const result = await extendEntries(
                db,
                contractId,
                entries.map(e => e.entry_key_xdr),
                100000,
                "SECRETKEY123",
            );

            expect(result.success).toBe(true);
            expect(result.entriesExtended).toBe(2);
            expect(result.txHash).toBe("abc123txhash");
            expect(result.ledger).toBe(2500100);

            // Verify extension history was recorded
            const history = getExtensionHistory(db, contractId);
            expect(history.length).toBe(2);
            expect(history[0]!.tx_hash).toBe("abc123txhash");
            expect(history[0]!.cpu_insns).toBe(10000);
            expect(history[0]!.mem_bytes).toBe(1024);

            // Verify entries were updated with fresh TTLs
            const updatedEntries = getEntriesForContract(db, contractId);
            const instanceEntry = updatedEntries.find(e => e.entry_key_xdr === "instance-key-xdr");
            expect(instanceEntry!.live_until_ledger).toBe(2600100);
        });

        it("returns error on transaction failure", async () => {
            const contractId = seedContract(db);
            const entries = getEntriesForContract(db, contractId);

            mockSubmitExtension.mockResolvedValue({
                success: false,
                txHash: "failed-tx",
                ledger: 0,
                error: "Transaction send error: Insufficient funds",
            });

            const result = await extendEntries(
                db,
                contractId,
                entries.map(e => e.entry_key_xdr),
                100000,
                "SECRETKEY123",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction send error: Insufficient funds");

            // No history should be recorded
            const history = getExtensionHistory(db, contractId);
            expect(history.length).toBe(0);
        });

        it("logs warning and returns error on submitExtension exception", async () => {
            const contractId = seedContract(db);
            const entries = getEntriesForContract(db, contractId);

            mockSubmitExtension.mockRejectedValue(new Error("Network connection lost"));

            const result = await extendEntries(
                db,
                contractId,
                entries.map(e => e.entry_key_xdr),
                100000,
                "SECRETKEY123",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Network connection lost");
        });

        it("logs error and returns false on failed txResult", async () => {
            const contractId = seedContract(db);
            const entries = getEntriesForContract(db, contractId);

            mockSubmitExtension.mockResolvedValue({
                success: false,
                error: "Simulation failed: Invalid footprint key"
            });

            const result = await extendEntries(
                db,
                contractId,
                entries.map(e => e.entry_key_xdr),
                100000,
                "SECRETKEY123",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Simulation failed: Invalid footprint key");
        });
        it("propagates feeCharged from the submitted transaction result", async () => {
            const contractId = seedContract(db);
            const entries = getEntriesForContract(db, contractId);

            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "fee-tx-hash",
                ledger: 2500100,
                feeCharged: 7500,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2500100,
                entries: entries.map(e => ({
                    entryKeyXdr: e.entry_key_xdr,
                    latestLedger: 2500100,
                    liveUntilLedgerSeq: 2600100,
                    lastModifiedLedgerSeq: 2500100,
                    remainingTTL: 100000,
                })),
            });

            const result = await extendEntries(
                db,
                contractId,
                entries.map(e => e.entry_key_xdr),
                100000,
                "SECRETKEY123",
            );

            expect(result.success).toBe(true);
            expect(result.feeCharged).toBe(7500);
        });
    });

    // =========================================================================
    // 2. simulateExtension
    // =========================================================================
    describe("simulateExtension", () => {
        it("returns fee estimate on successful simulation", async () => {
            const contractId = seedContract(db);

            mockSimulateExtension.mockResolvedValue({
                success: true,
                minResourceFee: 50000,
            });

            const result = await simulateExtension(
                db, contractId, ["instance-key-xdr"], 100000, "GPUBLICKEY",
            );

            expect(result.success).toBe(true);
            expect(result.estimatedFee).toBe(50000);
            expect(result.entriesExtended).toBe(1);
        });

        it("returns error on simulation failure", async () => {
            const contractId = seedContract(db);

            mockSimulateExtension.mockRejectedValue(new Error("Entry is archived"));

            const result = await simulateExtension(
                db, contractId, ["instance-key-xdr"], 100000, "GPUBLICKEY",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Entry is archived");
        });

        it("returns error when contract not found", async () => {
            const result = await simulateExtension(
                db, "NONEXISTENT", ["key1"], 100000, "GPUBLICKEY",
            );
            expect(result.success).toBe(false);
            expect(result.error).toBe("Contract not found");
        });

        it("delegates simulation to the RPC client and returns estimated fee as minResourceFee", async () => {
            const contractId = seedContract(db);

            mockSimulateExtension.mockResolvedValue({
                success: true,
                minResourceFee: 12500,
            });

            const result = await simulateExtension(
                db, contractId, ["instance-key-xdr", "wasm-key-xdr"], 100000, "GPUBLICKEY",
            );

            expect(result.success).toBe(true);
            expect(result.estimatedFee).toBe(12500);
            expect(result.entriesExtended).toBe(2);
            expect(mockSimulateExtension).toHaveBeenCalledWith(
                ["instance-key-xdr", "wasm-key-xdr"],
                100000,
                "GPUBLICKEY",
            );
        });
    });

    // =========================================================================
    // 3. restoreEntries
    // =========================================================================
    describe("restoreEntries", () => {
        it("returns error when contract not found", async () => {
            const result = await restoreEntries(
                db, "NONEXISTENT", ["key1"], "SECRETKEY123",
            );
            expect(result.success).toBe(false);
            expect(result.error).toBe("Contract not found");
        });

        it("returns error when no entries provided", async () => {
            const contractId = seedContract(db);
            const result = await restoreEntries(db, contractId, [], "SECRETKEY123");
            expect(result.success).toBe(false);
            expect(result.error).toBe("No entries to restore");
        });

        it("restores entries and updates DB on success", async () => {
            const contractId = seedContract(db);

            mockSubmitRestore.mockResolvedValue({
                success: true,
                txHash: "restore-tx-hash",
                ledger: 2500200,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2500200,
                entries: [
                    {
                        entryKeyXdr: "instance-key-xdr",
                        latestLedger: 2500200,
                        liveUntilLedgerSeq: 2600200,
                        lastModifiedLedgerSeq: 2500200,
                        remainingTTL: 100000,
                    },
                ],
            });

            const result = await restoreEntries(
                db, contractId, ["instance-key-xdr"], "SECRETKEY123",
            );

            expect(result.success).toBe(true);
            expect(result.entriesRestored).toBe(1);
            expect(result.txHash).toBe("restore-tx-hash");
            expect(result.ledger).toBe(2500200);

            // Verify entry was updated
            const updatedEntries = getEntriesForContract(db, contractId);
            const instanceEntry = updatedEntries.find(e => e.entry_key_xdr === "instance-key-xdr");
            expect(instanceEntry!.live_until_ledger).toBe(2600200);
        });

        it("returns error on restore transaction failure", async () => {
            const contractId = seedContract(db);

            mockSubmitRestore.mockResolvedValue({
                success: false,
                txHash: "failed-restore",
                ledger: 0,
                error: "Entry not found in archive",
            });

            const result = await restoreEntries(
                db, contractId, ["instance-key-xdr"], "SECRETKEY123",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Entry not found in archive");
        });

        it("extracts resource fee and status parameters from response", async () => {
            const contractId = seedContract(db);

            mockSubmitRestore.mockResolvedValue({
                success: true,
                txHash: "restore-with-resources",
                ledger: 2500300,
                cpuInsns: 8500,
                memBytes: 2048,
                minResourceFee: 75000,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2500300,
                entries: [
                    {
                        entryKeyXdr: "instance-key-xdr",
                        latestLedger: 2500300,
                        liveUntilLedgerSeq: 2600300,
                        lastModifiedLedgerSeq: 2500300,
                        remainingTTL: 100000,
                    },
                ],
            });

            const result = await restoreEntries(
                db, contractId, ["instance-key-xdr"], "SECRETKEY123",
            );

            expect(result.success).toBe(true);
            expect(result.cpuInsns).toBe(8500);
            expect(result.memBytes).toBe(2048);
            expect(result.minResourceFee).toBe(75000);
            expect(result.txHash).toBe("restore-with-resources");
            expect(result.ledger).toBe(2500300);
        });
    });

    // =========================================================================
    // 4. simulateRestore
    // =========================================================================
    describe("simulateRestore", () => {
        it("returns fee estimate on successful simulation", async () => {
            const contractId = seedContract(db);

            mockSimulateRestore.mockResolvedValue({
                success: true,
                minResourceFee: 65000,
            });

            const result = await simulateRestore(
                db, contractId, ["instance-key-xdr"], "GPUBLICKEY",
            );

            expect(result.success).toBe(true);
            expect(result.estimatedFee).toBe(65000);
            expect(result.entriesRestored).toBe(1);
        });

        it("returns error on simulation failure", async () => {
            const contractId = seedContract(db);

            mockSimulateRestore.mockResolvedValue({
                success: false,
                minResourceFee: 0,
                error: "Entry not found in archive",
            });

            const result = await simulateRestore(
                db, contractId, ["instance-key-xdr"], "GPUBLICKEY",
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Entry not found in archive");
        });

        it("returns error when contract not found", async () => {
            const result = await simulateRestore(
                db, "NONEXISTENT", ["key1"], "GPUBLICKEY",
            );
            expect(result.success).toBe(false);
            expect(result.error).toBe("Contract not found");
        });
    });

    // =========================================================================
    // 4. runAutoExtensions
    // =========================================================================
    describe("runAutoExtensions", () => {
        it("skips contracts without extension policies", async () => {
            seedContract(db);

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsChecked).toBe(0);
            expect(result.contractsExtended).toBe(0);
        });

        it("skips contracts with disabled policies", async () => {
            const contractId = seedContract(db);
            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: false,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsChecked).toBe(0);
        });

        it("extends entries below threshold when policy is enabled", async () => {
            const contractId = seedContract(db);

            // Set instance entry with low TTL (remaining = 10000 when latest ledger = 2400000)
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                label: "Contract Instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            mockGetCurrentLedger.mockResolvedValue(2400000);

            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "auto-ext-tx",
                ledger: 2400100,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [
                    {
                        entryKeyXdr: "instance-key-xdr",
                        latestLedger: 2400100,
                        liveUntilLedgerSeq: 2500100,
                        lastModifiedLedgerSeq: 2400100,
                        remainingTTL: 100000,
                    },
                ],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsChecked).toBe(1);
            expect(result.contractsExtended).toBe(1);
            expect(result.entriesExtended).toBeGreaterThanOrEqual(1);
            expect(result.extensions[0]!.txHash).toBe("auto-ext-tx");
        });

        it("does not extend entries above threshold", async () => {
            const contractId = seedContract(db);

            // Entries have high TTL (remaining = 100000, above 20000 threshold)
            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 200000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            mockGetCurrentLedger.mockResolvedValue(2400000);

            const result = await runAutoExtensions(db, "testnet");

            // Entries have TTL ~100000 and ~200000, both above 20000 — no extension needed
            expect(result.contractsChecked).toBe(1);
            expect(result.contractsExtended).toBe(0);
            expect(mockSubmitExtension).not.toHaveBeenCalled();
        });

        it("reports error when keypair cannot be resolved", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:NONEXISTENT_VAR_12345",
            });

            mockGetCurrentLedger.mockResolvedValue(2400000);

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsChecked).toBe(1);
            expect(result.contractsExtended).toBe(0);
            expect(result.errors.length).toBe(1);
            expect(result.errors[0]).toContain("Cannot resolve keypair");
        });

        it("filters by network", async () => {
            seedContract(db, { id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS3", network: "mainnet" });

            upsertExtensionPolicy(db, {
                contract_id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS3",
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
            });

            const result = await runAutoExtensions(db, "testnet");

            // Should not process mainnet contracts when running for testnet
            expect(result.contractsChecked).toBe(0);
        });

        it("collects errors without aborting for individual contract failures", async () => {
            const id1 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS1";
            const id2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS2";

            seedContract(db, { id: id1 });
            seedContract(db, { id: id2 });

            // Both with low TTL entries
            for (const id of [id1, id2]) {
                upsertEntry(db, {
                    contract_id: id,
                    entry_key_xdr: `instance-${id}`,
                    entry_type: "instance",
                    live_until_ledger: 2410000,
                    discovery_source: "deterministic",
                });
                upsertExtensionPolicy(db, {
                    contract_id: id,
                    enabled: true,
                    target_ttl_ledgers: 100000,
                    extend_when_below_ledgers: 20000,
                    keypair_source: "env:TEST_SECRET_KEY",
                });
            }

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            mockGetCurrentLedger.mockResolvedValue(2400000);

            // First contract succeeds, second fails
            let callCount = 0;
            mockSubmitExtension.mockImplementation(async () => {
                callCount++;
                if (callCount === 1) {
                    return { success: true, txHash: "tx1", ledger: 2400100 };
                }
                return { success: false, txHash: "tx2", ledger: 0, error: "Insufficient funds" };
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: `instance-${id1}`,
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: 2500100,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: 100000,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsChecked).toBe(2);
            // At least one should have been checked, and we should have errors
            expect(result.errors.length).toBeGreaterThanOrEqual(1);
        });

        it("records an error when extension succeeds but txHash or ledger is missing", async () => {
            const contractId = seedContract(db);

            // Set instance entry with low TTL so it triggers extension
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                label: "Contract Instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            mockGetCurrentLedger.mockResolvedValue(2400000);

            // Extension succeeds but txHash and ledger are missing
            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: null,
                ledger: null,
                entriesExtended: 1,
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [
                    {
                        entryKeyXdr: "instance-key-xdr",
                        latestLedger: 2400100,
                        liveUntilLedgerSeq: 2500100,
                        lastModifiedLedgerSeq: 2400100,
                        remainingTTL: 100000,
                    },
                ],
            });

            const result = await runAutoExtensions(db, "testnet");

            // No extension should be pushed to result.extensions
            expect(result.extensions).toHaveLength(0);

            // An error should be recorded about missing txHash or ledger
            expect(result.errors).not.toHaveLength(0);
            expect(result.errors[0]).toContain(contractId);
        });

        it("flags anomalous execution if resource usage spikes", async () => {
            const contractId = seedContract(db);

            // Seed with some normal history. Backdated well outside the
            // cooldown window (issue #510) — these establish the resource-usage
            // baseline and are unrelated to the cooldown behavior under test.
            recordExtension(db, {
                contract_id: contractId, contract_entry_id: 1, old_ttl_ledgers: 1, new_ttl_ledgers: 2,
                tx_hash: "h1", cost_xlm: 0.1, executed_at_ledger: 1, cpu_insns: 1000, mem_bytes: 100
            });
            recordExtension(db, {
                contract_id: contractId, contract_entry_id: 1, old_ttl_ledgers: 1, new_ttl_ledgers: 2,
                tx_hash: "h2", cost_xlm: 0.1, executed_at_ledger: 2, cpu_insns: 1200, mem_bytes: 120
            });
            db.prepare(
                `UPDATE extension_history SET executed_at = datetime('now', '-1 hour') WHERE tx_hash IN ('h1', 'h2')`,
            ).run();

            // Set instance entry with low TTL
            upsertEntry(db, {
                contract_id: contractId, entry_key_xdr: "instance-key-xdr", entry_type: "instance",
                live_until_ledger: 2410000,
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId, enabled: true, target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000, keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            mockGetCurrentLedger.mockResolvedValue(2400000);

            // This extension will have a huge resource spike (3x CPU, 4x MEM)
            mockSubmitExtension.mockResolvedValue({
                success: true, txHash: "anomaly-tx", ledger: 2400100,
                cpuInsns: 3301, // > 3 * 1100
                memBytes: 441, // > 4 * 110
            });

            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: "instance-key-xdr", latestLedger: 2400100,
                    liveUntilLedgerSeq: 2500100, remainingTTL: 100000,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(1);
            expect(result.extensions[0]!.isAnomaly).toBe(true);
            expect(result.extensions[0]!.anomalyDetails).toContain("CPU usage is 3.00x baseline");
            expect(result.extensions[0]!.anomalyDetails).toContain("Memory usage is 4.01x baseline");

            // Verify the new extension was recorded with anomaly flag
            const history = getExtensionHistory(db, contractId);
            const anomaly = history.find(h => h.tx_hash === "anomaly-tx");
            expect(anomaly!.is_anomaly).toBe(1);
        });

        // ── Issue #504: minimum-balance safety check ───────────────────────

        it("skips extension when channel account balance is below minimum threshold", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            const channelPubKey = "GCHANNEL1" + "A".repeat(48);
            upsertChannelAccount(db, {
                public_key: channelPubKey,
                keypair_source: "env:CHANNEL_SECRET",
                network: "testnet",
            });
            setEnv("CHANNEL_SECRET", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB");
            updateChannelBalance(db, channelPubKey, 0.5);

            mockGetCurrentLedger.mockResolvedValue(2400000);

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(0);
            expect(result.extensions).toHaveLength(0);
            expect(mockSubmitExtension).not.toHaveBeenCalled();
            expect(result.errors.some(e => e.includes("balance") || e.includes("below minimum"))).toBe(true);
        });

        it("fires an alert when extension is skipped due to low balance", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            insertAlertConfig(db, {
                contract_id: contractId,
                channel_type: "webhook",
                channel_target: "https://example.com/webhook",
                threshold_ledgers: 20000,
            });

            const channelPubKey = "GCHANNEL2" + "A".repeat(48);
            upsertChannelAccount(db, {
                public_key: channelPubKey,
                keypair_source: "env:CHANNEL_SECRET",
                network: "testnet",
            });
            setEnv("CHANNEL_SECRET", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC");
            updateChannelBalance(db, channelPubKey, 1.0);

            mockGetCurrentLedger.mockResolvedValue(2400000);
            mockDeliverSingleAlert.mockResolvedValue(true);

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(0);
            expect(mockDeliverSingleAlert).toHaveBeenCalled();
        });

        it("proceeds with extension when channel balance is sufficient", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            const channelPubKey = "GCHANNEL3" + "A".repeat(48);
            upsertChannelAccount(db, {
                public_key: channelPubKey,
                keypair_source: "env:CHANNEL_SECRET",
                network: "testnet",
            });
            setEnv("CHANNEL_SECRET", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD");
            updateChannelBalance(db, channelPubKey, 100.0);

            mockGetCurrentLedger.mockResolvedValue(2400000);
            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "sufficient-balance-tx",
                ledger: 2400100,
            });
            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: "instance-key-xdr",
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: 2500100,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: 100000,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(1);
            expect(result.extensions[0]!.txHash).toBe("sufficient-balance-tx");
        });

        it("blocks extension when estimated fee exceeds the max fee ceiling (issue #420)", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
                max_fee_stroops: 10000,
            });

            setEnv("TEST_SECRET_KEY", "SBPQHPF4S2SQ7XMYAC27XZZ3BE4BKXPW2MDJMMNKSAW5GCEYOQUDJPN7");

            const channelPubKey = "GCHANNEL4" + "A".repeat(48);
            upsertChannelAccount(db, {
                public_key: channelPubKey,
                keypair_source: "env:CHANNEL_SECRET",
                network: "testnet",
            });
            setEnv("CHANNEL_SECRET", "SBPQHPF4S2SQ7XMYAC27XZZ3BE4BKXPW2MDJMMNKSAW5GCEYOQUDJPN7");
            updateChannelBalance(db, channelPubKey, 100.0);

            mockGetCurrentLedger.mockResolvedValue(2400000);
            mockSimulateExtension.mockResolvedValue({
                success: true,
                minResourceFee: 50000,
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(0);
            expect(mockSubmitExtension).not.toHaveBeenCalled();
            expect(result.errors.some(e => e.includes("exceeds max fee ceiling"))).toBe(true);
        });

        it("proceeds with extension when estimated fee is under the max fee ceiling (issue #420)", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
                max_fee_stroops: 100000,
            });

            setEnv("TEST_SECRET_KEY", "SBPQHPF4S2SQ7XMYAC27XZZ3BE4BKXPW2MDJMMNKSAW5GCEYOQUDJPN7");

            const channelPubKey = "GCHANNEL5" + "A".repeat(48);
            upsertChannelAccount(db, {
                public_key: channelPubKey,
                keypair_source: "env:CHANNEL_SECRET",
                network: "testnet",
            });
            setEnv("CHANNEL_SECRET", "SBPQHPF4S2SQ7XMYAC27XZZ3BE4BKXPW2MDJMMNKSAW5GCEYOQUDJPN7");
            updateChannelBalance(db, channelPubKey, 100.0);

            mockGetCurrentLedger.mockResolvedValue(2400000);
            mockSimulateExtension.mockResolvedValue({
                success: true,
                minResourceFee: 50000,
            });
            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "under-ceiling-tx",
                ledger: 2400100,
            });
            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: "instance-key-xdr",
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: 2500100,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: 100000,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(1);
            expect(result.extensions[0]!.txHash).toBe("under-ceiling-tx");
        });

        it("does not simulate or block when no max fee ceiling is configured (issue #420)", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            const channelPubKey = "GCHANNEL6" + "A".repeat(48);
            upsertChannelAccount(db, {
                public_key: channelPubKey,
                keypair_source: "env:CHANNEL_SECRET",
                network: "testnet",
            });
            setEnv("CHANNEL_SECRET", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG");
            updateChannelBalance(db, channelPubKey, 100.0);

            mockGetCurrentLedger.mockResolvedValue(2400000);
            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "no-ceiling-tx",
                ledger: 2400100,
            });
            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: "instance-key-xdr",
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: 2500100,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: 100000,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(1);
            expect(result.extensions[0]!.txHash).toBe("no-ceiling-tx");
            expect(mockSimulateExtension).not.toHaveBeenCalled();
        });

        it("skips when channel account balance is null (unknown)", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });

            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            upsertChannelAccount(db, {
                public_key: "GCHANNEL4" + "A".repeat(48),
                keypair_source: "env:CHANNEL_SECRET",
                network: "testnet",
            });
            setEnv("CHANNEL_SECRET", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE");

            mockGetCurrentLedger.mockResolvedValue(2400000);

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(0);
            expect(mockSubmitExtension).not.toHaveBeenCalled();
            expect(result.errors.some(e => e.includes("balance") || e.includes("unknown"))).toBe(true);
        });

        it("with jitter disabled (default), submission timing is unchanged from current behavior", async () => {
            const id1 = seedContract(db, { id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS1" });
            const id2 = seedContract(db, { id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS2" });

            for (const id of [id1, id2]) {
                upsertEntry(db, {
                    contract_id: id, entry_key_xdr: `instance-${id}`, entry_type: "instance", live_until_ledger: 2410000,
                });
                upsertExtensionPolicy(db, {
                    contract_id: id, enabled: true, target_ttl_ledgers: 100000, extend_when_below_ledgers: 20000, keypair_source: "env:TEST_SECRET_KEY",
                });
            }
            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            mockGetCurrentLedger.mockResolvedValue(2400000);
            mockSubmitExtension.mockResolvedValue({ success: true, txHash: "tx", ledger: 2400100 });
            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [
                    { entryKeyXdr: `instance-${id1}`, latestLedger: 2400100, liveUntilLedgerSeq: 2500100, remainingTTL: 100000 },
                    { entryKeyXdr: `instance-${id2}`, latestLedger: 2400100, liveUntilLedgerSeq: 2500100, remainingTTL: 100000 },
                ],
            });

            const startTime = Date.now();
            await runAutoExtensions(db, "testnet");
            const duration = Date.now() - startTime;
            
            // Should execute instantly without jitter
            expect(duration).toBeLessThan(100); 
        });

        it("with jitter enabled, multiple queued extensions are not submitted synchronously back-to-back", async () => {
            const id1 = seedContract(db, { id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS1" });
            const id2 = seedContract(db, { id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS2" });

            for (const id of [id1, id2]) {
                upsertEntry(db, {
                    contract_id: id, entry_key_xdr: `instance-${id}`, entry_type: "instance", live_until_ledger: 2410000,
                });
                upsertExtensionPolicy(db, {
                    contract_id: id, enabled: true, target_ttl_ledgers: 100000, extend_when_below_ledgers: 20000, keypair_source: "env:TEST_SECRET_KEY",
                });
            }
            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            setEnv("EXTENSION_JITTER_MS", "300"); // 300ms jitter

            mockGetCurrentLedger.mockResolvedValue(2400000);
            mockSubmitExtension.mockResolvedValue({ success: true, txHash: "tx", ledger: 2400100 });
            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [
                    { entryKeyXdr: `instance-${id1}`, latestLedger: 2400100, liveUntilLedgerSeq: 2500100, remainingTTL: 100000 },
                    { entryKeyXdr: `instance-${id2}`, latestLedger: 2400100, liveUntilLedgerSeq: 2500100, remainingTTL: 100000 },
                ],
            });

            // Mock Math.random to always return 0.9 to ensure ~270ms delay per task
            const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.9);

            const startTime = Date.now();
            await runAutoExtensions(db, "testnet");
            const duration = Date.now() - startTime;
            
            // Expected delay is at least 270ms (0.9 * 300) since there are multiple queued extensions
            expect(duration).toBeGreaterThanOrEqual(270);

            randomSpy.mockRestore();
        });

        // ── Issue #510: extension cooldown per entry ───────────────────────

        it("skips an entry extended within the cooldown window", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });
            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            const entryRow = db
                .prepare("SELECT id FROM contract_entries WHERE contract_id = ?")
                .get(contractId) as { id: number };

            recordExtension(db, {
                contract_id: contractId,
                contract_entry_id: entryRow.id,
                old_ttl_ledgers: 1000,
                new_ttl_ledgers: 100000,
                tx_hash: "recent-tx",
                executed_at_ledger: 2399900,
            });

            mockGetCurrentLedger.mockResolvedValue(2400000);

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(0);
            expect(mockSubmitExtension).not.toHaveBeenCalled();
        });

        it("extends an entry whose last extension is outside the cooldown window", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });
            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            const entryRow = db
                .prepare("SELECT id FROM contract_entries WHERE contract_id = ?")
                .get(contractId) as { id: number };

            db.prepare(
                `INSERT INTO extension_history
                    (contract_id, contract_entry_id, old_ttl_ledgers, new_ttl_ledgers, tx_hash, executed_at_ledger, executed_at)
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-1 hour'))`,
            ).run(contractId, entryRow.id, 1000, 100000, "old-tx", 2000000);

            mockGetCurrentLedger.mockResolvedValue(2400000);
            mockSubmitExtension.mockResolvedValue({ success: true, txHash: "new-tx", ledger: 2400100 });
            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: "instance-key-xdr",
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: 2500100,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: 100000,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(1);
            expect(mockSubmitExtension).toHaveBeenCalled();
        });

        it("extends an entry that has never been extended before", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });
            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            mockGetCurrentLedger.mockResolvedValue(2400000);
            mockSubmitExtension.mockResolvedValue({ success: true, txHash: "first-tx", ledger: 2400100 });
            mockGetEntryTTLs.mockResolvedValue({
                latestLedger: 2400100,
                entries: [{
                    entryKeyXdr: "instance-key-xdr",
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: 2500100,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: 100000,
                }],
            });

            const result = await runAutoExtensions(db, "testnet");

            expect(result.contractsExtended).toBe(1);
        });

        // ── Issue #490: batch ExtendFootprintTTLOp across matching entries ──

        it("batches entries sharing the same effective target TTL into a single transaction", async () => {
            const contractId = seedContract(db);

            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "persistent-key-xdr",
                entry_type: "persistent",
                live_until_ledger: 2405000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });
            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            mockGetCurrentLedger.mockResolvedValue(2400000);
            mockSubmitExtension.mockResolvedValue({
                success: true,
                txHash: "batched-tx",
                ledger: 2400100,
                cpuInsns: 1000,
                memBytes: 2000,
            });
            mockGetEntryTTLs.mockImplementation(async (entryKeyXdrs: string[]) => ({
                latestLedger: 2400100,
                entries: entryKeyXdrs.map((xdr) => ({
                    entryKeyXdr: xdr,
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: 2500100,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: 100000,
                })),
            }));

            const result = await runAutoExtensions(db, "testnet");

            expect(result.errors).toEqual([]);
            expect(mockSubmitExtension).toHaveBeenCalledTimes(1);

            const [entryKeys, targetTtl] = mockSubmitExtension.mock.calls[0] as [string[], number, string];
            expect(entryKeys.sort()).toEqual(["instance-key-xdr", "persistent-key-xdr"].sort());
            expect(targetTtl).toBe(100000);

            const history = getExtensionHistory(db, contractId, 10);
            expect(history.length).toBe(2);
            expect(history.every((h) => h.tx_hash === "batched-tx")).toBe(true);
            expect(history.every((h) => h.cpu_insns === 1000)).toBe(true);
        });

        // ── Issue #491/#563: per-entry-type policy target grouping ─────────

        it("extends entries with different effective target TTLs in separate transactions", async () => {
            const contractId = seedContract(db);

            // Override the seeded "instance" entry's TTL so it needs extension
            // under the contract-level policy's threshold.
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "instance-key-xdr",
                entry_type: "instance",
                live_until_ledger: 2410000,
                discovery_source: "deterministic",
            });

            // A "persistent" entry that also needs extension, but whose
            // entry-type override resolves to a different target TTL.
            upsertEntry(db, {
                contract_id: contractId,
                entry_key_xdr: "persistent-key-xdr",
                entry_type: "persistent",
                live_until_ledger: 2405000,
                discovery_source: "deterministic",
            });

            upsertExtensionPolicy(db, {
                contract_id: contractId,
                enabled: true,
                target_ttl_ledgers: 100000,
                extend_when_below_ledgers: 20000,
                keypair_source: "env:TEST_SECRET_KEY",
            });
            setEnv("TEST_SECRET_KEY", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

            setEntryTypePolicy(db, contractId, "persistent", {
                target_ttl_ledgers: 50000,
                extend_when_below_ledgers: 20000,
            });

            mockGetCurrentLedger.mockResolvedValue(2400000);
            mockSubmitExtension.mockResolvedValue({ success: true, txHash: "tx", ledger: 2400100 });
            mockGetEntryTTLs.mockImplementation(async (entryKeyXdrs: string[]) => ({
                latestLedger: 2400100,
                entries: entryKeyXdrs.map((xdr) => ({
                    entryKeyXdr: xdr,
                    latestLedger: 2400100,
                    liveUntilLedgerSeq: xdr === "persistent-key-xdr" ? 2450100 : 2500100,
                    lastModifiedLedgerSeq: 2400100,
                    remainingTTL: xdr === "persistent-key-xdr" ? 50000 : 100000,
                })),
            }));

            const result = await runAutoExtensions(db, "testnet");

            expect(result.errors).toEqual([]);
            expect(result.entriesExtended).toBe(2);
            expect(mockSubmitExtension).toHaveBeenCalledTimes(2);

            const calls = mockSubmitExtension.mock.calls as [string[], number, string][];
            const instanceCall = calls.find(([xdrs]) => xdrs.includes("instance-key-xdr"));
            const persistentCall = calls.find(([xdrs]) => xdrs.includes("persistent-key-xdr"));

            expect(instanceCall).toBeDefined();
            expect(persistentCall).toBeDefined();
            expect(instanceCall?.[1]).toBe(100000);
            expect(persistentCall?.[1]).toBe(50000);
        });
    });

    // =========================================================================
    // 6. isRateLimited boundary at HOURLY_RATE_LIMIT (issue #465)
    // =========================================================================
    describe("isRateLimited boundary at HOURLY_RATE_LIMIT (issue #465)", () => {
        function seedRecentExtensions(contractId: string, count: number): void {
            const entryRow = db
                .prepare("SELECT id FROM contract_entries WHERE contract_id = ? LIMIT 1")
                .get(contractId) as { id: number };
            for (let i = 0; i < count; i++) {
                recordExtension(db, {
                    contract_id: contractId,
                    contract_entry_id: entryRow.id,
                    old_ttl_ledgers: 1000,
                    new_ttl_ledgers: 100000,
                    tx_hash: `rate-limit-boundary-tx-${i}`,
                    executed_at_ledger: 2400000 + i,
                });
            }
        }

        it("returns false at HOURLY_RATE_LIMIT - 1 (4 extensions in last hour: 5th extension is allowed)", () => {
            const contractId = seedContract(db);
            seedRecentExtensions(contractId, HOURLY_RATE_LIMIT - 1);

            // With 4 extensions recorded in the last hour (< HOURLY_RATE_LIMIT = 5),
            // isRateLimited (`count >= limit`) returns false so the 5th extension proceeds.
            expect(isRateLimited(db, contractId)).toBe(false);
        });

        it("returns true at exactly HOURLY_RATE_LIMIT (5 extensions in last hour: 6th extension is blocked)", () => {
            const contractId = seedContract(db);
            seedRecentExtensions(contractId, HOURLY_RATE_LIMIT);

            // `isRateLimited` uses `count >= limit` (HOURLY_RATE_LIMIT = 5).
            // Once 5 extensions have been recorded in the last hour, the boundary is reached
            // and any subsequent (6th) extension attempt within the hour is blocked.
            expect(HOURLY_RATE_LIMIT).toBe(5);
            expect(isRateLimited(db, contractId)).toBe(true);
        });

        it("returns true at HOURLY_RATE_LIMIT + 1 (6 extensions in last hour: remains rate-limited)", () => {
            const contractId = seedContract(db);
            seedRecentExtensions(contractId, HOURLY_RATE_LIMIT + 1);

            expect(isRateLimited(db, contractId)).toBe(true);
        });
    });
});
