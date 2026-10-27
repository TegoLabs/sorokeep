import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { getDatabaseForTesting } from "../../src/db/database.js";
import { registerGuardCommand } from "../../src/commands/guard.js";
import * as repos from "../../src/db/repositories.js";
import * as extensionLib from "../../src/core/extension.js";

const VALID_TEST_SECRET = "SCG2IACKCYEUMINFHVGAOB3UFDVSVRACCZJH4K3R6WVC2OTRDQPK2GWG";
const VALID_TEST_PUBKEY = "GA4YORXJVEPWAYDHC3AAFGUJRWCCO3GOP3T226ZFKWSLUCAYS7NKRLUU";
const CONTRACT_ID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";

let mockDb: Database.Database;

vi.mock("../../src/db/database.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        getDatabase: () => mockDb,
    };
});

vi.mock("../../src/core/extension.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        simulateExtension: vi.fn(),
        extendEntries: vi.fn(),
        resolveSecretKey: vi.fn(async (source: string) => {
            if (source.startsWith("env:") || source.startsWith("vault:")) {
                return VALID_TEST_SECRET;
            }
            return source;
        }),
    };
});

async function parseAsync(args: string[]): Promise<void> {
    const program = new Command();
    registerGuardCommand(program);
    await program.parseAsync(["node", "sorokeep", ...args]);
}

describe("guard simulate command", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockDb = getDatabaseForTesting();

        repos.insertContract(mockDb, {
            id: CONTRACT_ID,
            name: "sample-contract",
            network: "testnet",
        });

        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process.exit called");
        }) as never);
        process.exitCode = undefined;

        vi.mocked(extensionLib.simulateExtension).mockResolvedValue({
            success: true,
            entriesExtended: 2,
            estimatedFee: 45000,
            cpuInsns: 120000,
            memBytes: 16384,
            readBytes: 2048,
            writeBytes: 1024,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        process.exitCode = undefined;
    });

    it("is strictly read-only and never modifies extension_policies in the database", async () => {
        repos.updateLastCheckedLedger(mockDb, CONTRACT_ID, 10000);
        repos.upsertExtensionPolicy(mockDb, {
            contract_id: CONTRACT_ID,
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
            keypair_public: VALID_TEST_PUBKEY,
            keypair_source: "env:SOROKEEP_KEY",
        });

        repos.upsertEntry(mockDb, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "AAAA_INSTANCE",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 25000, // remaining 15000
        });

        const policyBefore = repos.getExtensionPolicy(mockDb, CONTRACT_ID);
        const upsertSpy = vi.spyOn(repos, "upsertExtensionPolicy");

        await parseAsync([
            "guard",
            "simulate",
            CONTRACT_ID,
            "--target-ttl",
            "250000",
            "--threshold",
            "50000",
        ]);

        const policyAfter = repos.getExtensionPolicy(mockDb, CONTRACT_ID);
        expect(upsertSpy).not.toHaveBeenCalled();
        expect(extensionLib.extendEntries).not.toHaveBeenCalled();
        expect(policyAfter).toEqual(policyBefore);
        expect(policyAfter?.target_ttl_ledgers).toBe(100000);
        expect(policyAfter?.extend_when_below_ledgers).toBe(20000);
    });

    it("does not create a policy row when no active policy exists before simulation", async () => {
        repos.updateLastCheckedLedger(mockDb, CONTRACT_ID, 10000);
        repos.upsertEntry(mockDb, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "AAAA_INSTANCE",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 25000,
        });

        expect(repos.getExtensionPolicy(mockDb, CONTRACT_ID)).toBeUndefined();

        await parseAsync([
            "guard",
            "simulate",
            CONTRACT_ID,
            "--target-ttl",
            "120000",
            "--threshold",
            "30000",
        ]);

        expect(repos.getExtensionPolicy(mockDb, CONTRACT_ID)).toBeUndefined();
    });

    it("shows entries that newly trigger vs entries that stop triggering compared to current policy and includes simulated fee", async () => {
        repos.updateLastCheckedLedger(mockDb, CONTRACT_ID, 10000);
        repos.upsertExtensionPolicy(mockDb, {
            contract_id: CONTRACT_ID,
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
            keypair_public: VALID_TEST_PUBKEY,
            keypair_source: "env:SOROKEEP_KEY",
        });

        // Entry 1: remaining = 35000 - 10000 = 25000.
        // Current threshold = 20000 (does NOT trigger); Proposed threshold = 30000 (DOES trigger -> newly triggers)
        repos.upsertEntry(mockDb, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "AAAA_NEWLY",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 35000,
        });

        // Entry 2: remaining = 22000 - 10000 = 12000.
        // Current threshold = 20000 (triggers); Proposed threshold = 30000 (still triggers)
        repos.upsertEntry(mockDb, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "AAAA_STILL",
            entry_type: "wasm",
            label: "WASM Code",
            live_until_ledger: 22000,
        });

        await parseAsync([
            "guard",
            "simulate",
            CONTRACT_ID,
            "--target-ttl",
            "150000",
            "--threshold",
            "30000",
        ]);

        const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(allLogs).toContain("newly triggers");
        expect(allLogs).toContain("still triggers");
        expect(allLogs).toContain("0.0045000 XLM");
        expect(allLogs).toContain("45000 stroops");
        expect(extensionLib.simulateExtension).toHaveBeenCalledWith(
            mockDb,
            CONTRACT_ID,
            expect.arrayContaining(["AAAA_NEWLY", "AAAA_STILL"]),
            150000,
            VALID_TEST_PUBKEY,
        );
    });

    it("identifies entries that stop triggering when proposed threshold is lower than current threshold", async () => {
        repos.updateLastCheckedLedger(mockDb, CONTRACT_ID, 10000);
        repos.upsertExtensionPolicy(mockDb, {
            contract_id: CONTRACT_ID,
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 30000,
            keypair_public: VALID_TEST_PUBKEY,
            keypair_source: "env:SOROKEEP_KEY",
        });

        // remaining = 35000 - 10000 = 25000.
        // Current threshold = 30000 (triggers); Proposed threshold = 15000 (does NOT trigger -> stops triggering)
        repos.upsertEntry(mockDb, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "AAAA_STOPPED",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 35000,
        });

        await parseAsync([
            "guard",
            "simulate",
            CONTRACT_ID,
            "--target-ttl",
            "80000",
            "--threshold",
            "15000",
        ]);

        const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(allLogs).toContain("stops triggering");
        expect(allLogs).toContain("0 newly triggering, 1 stopped triggering");
    });

    it("emits structured JSON output when --json is passed", async () => {
        repos.updateLastCheckedLedger(mockDb, CONTRACT_ID, 10000);
        repos.upsertExtensionPolicy(mockDb, {
            contract_id: CONTRACT_ID,
            enabled: true,
            target_ttl_ledgers: 100000,
            extend_when_below_ledgers: 20000,
            keypair_public: VALID_TEST_PUBKEY,
            keypair_source: "env:SOROKEEP_KEY",
        });

        repos.upsertEntry(mockDb, {
            contract_id: CONTRACT_ID,
            entry_key_xdr: "AAAA_NEWLY",
            entry_type: "instance",
            label: "Instance",
            live_until_ledger: 35000, // remaining 25000 -> newly_triggers under threshold 30000
        });

        await parseAsync([
            "guard",
            "simulate",
            CONTRACT_ID,
            "--target-ttl",
            "120000",
            "--threshold",
            "30000",
            "--json",
        ]);

        expect(consoleLogSpy).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
        expect(payload.success).toBe(true);
        expect(payload.mode).toBe("simulate");
        expect(payload.newlyTriggeringCount).toBe(1);
        expect(payload.stoppedTriggeringCount).toBe(0);
        expect(payload.estimatedFeeStroops).toBe(45000);
        expect(payload.entries[0].transition).toBe("newly_triggers");
    });

    it("exits with code 1 when threshold >= target-ttl", async () => {
        await expect(
            parseAsync([
                "guard",
                "simulate",
                CONTRACT_ID,
                "--target-ttl",
                "20000",
                "--threshold",
                "20000",
            ]),
        ).rejects.toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining("--threshold must be less than --target-ttl"),
        );
    });
});
