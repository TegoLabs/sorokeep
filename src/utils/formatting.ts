import chalk from "chalk";
import { StrKey } from "@stellar/stellar-sdk";
import { AVG_LEDGER_CLOSE_SECONDS } from "./ledger.js";

export function convertLedgerCloseTimeToSeconds(ledgerCloseTime: number): number {
    return ledgerCloseTime * AVG_LEDGER_CLOSE_SECONDS;
}

export function printOutput(data: unknown, jsonFlag = false): void {
    if (!jsonFlag) {
        return;
    }
    console.log(JSON.stringify(data, (_key, value) => {
        if (typeof value === "bigint") {
            return value.toString();
        }
        return value;
    }, 2));
}

export function formatTimeToCloseLedger(ledgers: number): string {
  if (ledgers <= 0) {
    return "Ledger Expired";
  }

  const totalSeconds = convertLedgerCloseTimeToSeconds(ledgers);
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

    if (days > 0) 
        return `~${days}d ${hours % 24}h`;
    else if (hours > 0) 
        return `~${hours}h ${minutes % 60}m`;
    else return `~${minutes}m ${totalSeconds % 60}s`;
}

export type TTLStatus = "ok" | "warning" | "critical" | "expired";

export function classifyTTL(remainingLedgers: number): TTLStatus {
    if (remainingLedgers <= 0) return "expired";
    if (remainingLedgers < 5000) return "critical";
    if (remainingLedgers < 20000) return "warning";
    return "ok";
}

export function statusIndicator(status: TTLStatus): string {
  switch (status) {
    case "ok": return chalk.bold.green("OK");
    case "warning": return chalk.bold.yellow("WARNING");
    case "critical": return chalk.bold.red("CRITICAL");
    case "expired": return chalk.bold.magenta("EXPIRED");
  }
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const isNegative = bytes < 0;
    const absBytes = Math.abs(bytes);
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(absBytes) / Math.log(k));
    const result = parseFloat((absBytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    return isNegative ? "-" + result : result;
}

export function formatCpuInsns(insns: number): string {
    if (insns < 1000) return `${insns}`;
    if (insns < 1000000) return `${(insns / 1000).toFixed(2)}k`;
    return `${(insns / 1000000).toFixed(2)}m`;
}

export function formatContractID(contractID: string, maxLength: number = 16): string {
    if (contractID.length <= maxLength) return contractID;
    return `${contractID.slice(0, 8)}...${contractID.slice(-4)}`;
}
export function formatSecretKey(key: string | null): string | null {
    if (!key || key.startsWith("env:")) return key;
    if (key.startsWith("S") && key.length >= 8) {
        return `${key.slice(0, 4)}...${key.slice(-4)}`;
    }
    return key;
}

// ── Contract ID Validation ──────────────────────────────────────────────────

export type ValidationResult =
    | { valid: true }
    | { valid: false; reason: string };

/**
 * Validate a Stellar contract ID string before any RPC/DB work.
 *
 * Checks performed (in order):
 * 1. Must be a non-empty string starting with 'C'
 * 2. Must be exactly 56 characters (base32-encoded 32-byte hash with checksum)
 * 3. Must pass Stellar SDK StrKey checksum validation
 *
 * Returns a specific reason on failure so CLI commands can surface
 * actionable error messages.
 */
export function validateContractId(id: string): ValidationResult {
    if (!id || typeof id !== "string") {
        return { valid: false, reason: "Contract ID is empty or missing" };
    }

    if (!id.startsWith("C")) {
        return {
            valid: false,
            reason: `Contract ID must start with 'C' — got "${id.slice(0, 1)}" instead. Did you paste an account address (starts with 'G') by mistake?`,
        };
    }

    if (id.length !== 56) {
        return {
            valid: false,
            reason: `Contract ID must be 56 characters (base32-encoded 32 bytes + checksum), but got ${id.length} characters`,
        };
    }

    if (!StrKey.isValidContract(id)) {
        return {
            valid: false,
            reason: `Contract ID "${id.slice(0, 8)}...${id.slice(-4)}" has an invalid Stellar checksum — check for typos`,
        };
    }

    return { valid: true };
}

export interface PaginationMeta {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
}

export interface PaginationResult<T> {
    items: T[];
    meta: PaginationMeta;
}

/**
 * Paginate an already-fetched, in-memory list. Out-of-range page numbers are
 * clamped to the nearest valid page rather than returning an empty slice —
 * callers get valid, non-empty output instead of having to special-case
 * out-of-range requests.
 */
export function paginateList<T>(
    items: T[],
    page: number,
    pageSize: number = 25,
): PaginationResult<T> {
    const totalItems = items.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const start = (safePage - 1) * pageSize;

    return {
        items: items.slice(start, start + pageSize),
        meta: {
            page: safePage,
            pageSize,
            totalItems,
            totalPages,
        },
    };
}

export function formatPaginationFooter(meta: PaginationMeta): string {
    return `Page ${meta.page} of ${meta.totalPages} (${meta.totalItems} total)`;
}

// ── Fleet CSV Export ────────────────────────────────────────────────────────

export interface FleetCSVRow {
    contractId: string;
    contractName: string | null;
    entryKeyXdr: string;
    entryType: string;
    remainingTTL: number;
    status: string;
}

/**
 * Escape a single CSV field per RFC 4180.
 * Fields containing commas, double-quotes, or newlines are wrapped in
 * double-quotes; any embedded double-quotes are doubled.
 */
function escapeCSVField(value: string): string {
    if (value.includes(",") || value.includes('"') || value.includes("\n")) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

/**
 * Format fleet health data as CSV with a header row.
 *
 * Output columns: contract_id, contract_name, entry_key_xdr, entry_type,
 * remaining_ttl, status — one row per tracked entry across all contracts.
 */
export function formatFleetCSV(rows: FleetCSVRow[]): string {
    const header = "contract_id,contract_name,entry_key_xdr,entry_type,remaining_ttl,status";

    const dataLines = rows.map((row) => {
        const name = row.contractName ?? formatContractID(row.contractId);
        return [
            escapeCSVField(row.contractId),
            escapeCSVField(name),
            escapeCSVField(row.entryKeyXdr),
            escapeCSVField(row.entryType),
            String(row.remainingTTL),
            escapeCSVField(row.status),
        ].join(",");
    });

    return [header, ...dataLines].join("\n");
}