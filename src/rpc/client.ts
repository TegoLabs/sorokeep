import {
    Contract,
    rpc,
    xdr,
    Transaction,
    TransactionBuilder,
    Networks,
    Account,
    Operation,
    Keypair,
    SorobanDataBuilder,
    FeeBumpTransaction,
    Asset,
} from "@stellar/stellar-sdk";
import chalk from "chalk";
import { getLogger } from "../logging/index.js";
import * as undici from "undici";
import * as crypto from "node:crypto";
// CostSummary removed — no longer exported from costs.js

// ── Local helper types to replace `any` casts ──────────────────────────────

/** Error-like shape accessed in catch blocks. */
interface ErrorLike {
    code?: string;
    message?: string;
    response?: { status?: number };
    cause?: unknown;
}

/** Thrown when a network-level failure (connection refused, timeout, DNS, etc.)
 * is detected talking to the configured RPC endpoint, so callers can print an
 * actionable message instead of a raw fetch/SDK error. */
export class RpcUnreachableError extends Error {
    public readonly url: string;

    constructor(url: string, options?: { cause?: unknown }) {
        super(`RPC endpoint at ${url} is unreachable`, options);
        this.name = "RpcUnreachableError";
        this.url = url;
    }
}

const NETWORK_ERROR_CODES = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EADDRNOTAVAIL",
    "ECONNRESET",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
]);

const NETWORK_ERROR_MESSAGE_PATTERNS = [
    "fetch failed",
    "econnrefused",
    "enotfound",
    "etimedout",
    "econnreset",
    "timeout",
    "unreachable",
    "network error",
];

/** Detects whether an error (or its cause chain) looks like a network-level failure. */
export function isNetworkError(error: unknown, seen = new Set<unknown>()): boolean {
    if (!error || typeof error !== "object" || seen.has(error)) return false;
    seen.add(error);

    const err = error as ErrorLike;
    if (typeof err.code === "string" && NETWORK_ERROR_CODES.has(err.code)) return true;

    const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
    if (NETWORK_ERROR_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern))) return true;

    return isNetworkError(err.cause, seen);
}

const RPC_UNREACHABLE_MESSAGE_PATTERN = /RPC endpoint at (https?:\/\/\S+) is unreachable/;

/**
 * Prints an actionable message for an unreachable-RPC failure and returns
 * true if it recognized one. Accepts a plain string as well as an Error,
 * since some call sites (e.g. core/watch.ts's structured WatchResult) already
 * stringify errors to `.message` before returning, losing the original type.
 */
export function handleRpcUnreachableError(error: unknown): boolean {
    let url: string | undefined;

    if (error instanceof RpcUnreachableError) {
        url = error.url;
    } else if (typeof error === "string") {
        url = error.match(RPC_UNREACHABLE_MESSAGE_PATTERN)?.[1];
    } else if (error instanceof Error) {
        url = error.message.match(RPC_UNREACHABLE_MESSAGE_PATTERN)?.[1];
    }

    if (!url) return false;

    console.error(chalk.red(`\nError: RPC endpoint is unreachable: ${url}`));
    console.error(chalk.yellow("Suggestions:"));
    console.error(`  - Check that the URL is correct and the endpoint is online.`);
    console.error(`  - Use the ${chalk.bold("--rpc-url")} flag to specify a different endpoint.`);
    console.error(`  - Verify your configuration in ${chalk.bold("~/.sorokeep/config.yaml")}.`);
    console.error(`  - Check Stellar network status: ${chalk.cyan("https://status.stellar.org")}\n`);
    return true;
}

/**
 * Wraps every method on an `rpc.Server` instance so a network-level failure
 * (connection refused, timeout, DNS, etc.) surfaces as a `RpcUnreachableError`
 * carrying the endpoint URL, with the original error preserved as `.cause`.
 *
 * A Proxy is used rather than editing each `StellarRpcClient` method
 * individually, since callers reach the SDK server both directly
 * (`this.server.getLedgerEntries(...)`) and via `withRateLimit`, and every
 * path needs the same detection without duplicating it at each call site.
 */
function wrapServerWithUnreachableDetection(server: rpc.Server, url: string): rpc.Server {
    return new Proxy(server, {
        get(target, prop, receiver) {
            const value: unknown = Reflect.get(target, prop, receiver);
            if (typeof value !== "function") return value;

            return function (this: unknown, ...args: unknown[]): unknown {
                const toRpcError = (error: unknown): unknown =>
                    isNetworkError(error) ? new RpcUnreachableError(url, { cause: error }) : error;

                try {
                    const result: unknown = Reflect.apply(value, target, args);
                    if (result instanceof Promise) {
                        return result.catch((error: unknown) => {
                            throw toRpcError(error);
                        });
                    }
                    return result;
                } catch (error) {
                    throw toRpcError(error);
                }
            };
        },
    });
}

/** Soroban meta with optional resource-counter accessors. */
interface SorobanMetaLike {
    cpuInstructions?: () => unknown;
    memoryBytes?: () => unknown;
}

/** Cost fields present on raw (unparsed) simulation responses. */
interface SimulateTransactionCost {
    cpuInsns?: string | number;
    memBytes?: string | number;
    readBytes?: string | number;
    writeBytes?: string | number;
}

/** Simulation success response that may carry raw cost fields. */
interface SimulateWithCost extends rpc.Api.SimulateTransactionSuccessResponse {
    cost?: SimulateTransactionCost;
}

/** Send-transaction error response with raw diagnostic fields. */
interface SendTransactionErrorResult {
    errorResult?: unknown;
    diagnosticEventsXdr?: string;
}

/** Get-transaction response with raw (string-based) fields.
 *
 * The SDK types parse `resultMetaXdr` as `xdr.TransactionMeta`, but at runtime
 * the RPC may still return a base64 string. The `as unknown as
 * GetTransactionRawFields` casts in `pollTransaction` handle this mismatch
 * intentionally — `extractResourceCosts` expects a raw base64 string. */
interface GetTransactionRawFields {
    resultMetaXdr?: string;
    feeCharged?: string | number;
    ledger?: number;
    latestLedger?: number;
}

export function assertSimulationSuccess(sim: rpc.Api.SimulateTransactionResponse): asserts sim is rpc.Api.SimulateTransactionSuccessResponse {
    if (rpc.Api.isSimulationError(sim)) {
        if (sim.error?.includes("txBadSeq")) {
            throw new Error("Simulation failed: Expired sequence number");
        }
        if (sim.error?.includes("txInsufficientBalance")) {
            throw new Error("Simulation failed: Insufficient wallet balance");
        }
        if (sim.error?.includes("invalid footprint")) {
            throw new Error("Simulation failed: Invalid footprint key");
        }
        throw new Error(`Simulation failed: ${sim.error ?? "unknown error"}`);
    }
}


/**
 * Executes an RPC action with exponential backoff on network timeouts or 429/5xx errors.
 * Starts at 1 second, doubling up to 3 retries (max 4 attempts).
 */
export async function executeWithRetry<T>(action: () => Promise<T>): Promise<T> {
    const MAX_RETRIES = 3;
    let delayMs = 1000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await action();
        } catch (error: unknown) {
            const err = error as ErrorLike;
            const cause = (err.cause ?? err) as ErrorLike;
            const isTimeout = cause.code === "ETIMEDOUT" || cause.code === "ECONNRESET" || cause.message?.includes("timeout");
            const status = cause.response?.status ?? err.response?.status ?? 0;
            const isRetryableHttp = status === 429 || (status >= 500 && status < 600);

            if ((isTimeout || isRetryableHttp) && attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
                delayMs *= 2;
                continue;
            }

            throw error;
        }
    }
    throw new Error("Unreachable");
}

const logger = getLogger().child({ component: "StellarRpcClient" });

const RPC_URLS: Record<string, string> = {
    testnet: "https://soroban-testnet.stellar.org",
    mainnet: "https://mainnet.sorobanrpc.com",
};

export interface SorokeepLedgerEntryResult {
    entryKeyXdr: string;
    latestLedger: number;
    liveUntilLedgerSeq: number;
    lastModifiedLedgerSeq: number;
    remainingTTL: number;
}

export interface ContractInstanceResult extends SorokeepLedgerEntryResult {
    executableType: string;
    wasmHash: string | null;
}

export interface EntryTTLsResult {
    latestLedger: number;
    entries: SorokeepLedgerEntryResult[];
}

export interface ContractStorageEntryResult extends SorokeepLedgerEntryResult {
    valXdr?: string;
}

export interface SimulateExtensionResult {
    minResourceFee: number;
    success: boolean;
    error?: string;
    /** CPU instructions consumed by the transaction. */
    cpuInstructions?: number;
    /** Memory bytes consumed by the transaction. */
    memoryBytes?: number;
    /** Read footprint size in bytes. */
    readBytes?: number;
    /** Write footprint size in bytes. */
    writeBytes?: number;
}

/**
 * Structured resource usage estimate extracted from a simulateTransaction response.
 * Used for budget safety checks before executing auto-extensions (issue #133).
 */
export interface ResourceEstimate {
    /** CPU instructions estimated for the transaction. */
    cpuInstructions: number;
    /** Memory bytes estimated for the transaction. */
    memoryBytes: number;
    /** Minimum resource fee in stroops estimated by the RPC node. */
    minResourceFee: number;
}

/**
 * Parse a simulateTransaction RPC response into a structured ResourceEstimate.
 *
 * Extracts `cpuInstructions` from `response.cost.cpuInsns`,
 * `memoryBytes` from `response.cost.memBytes`, and
 * `minResourceFee` from `response.minResourceFee`.
 *
 * Returns `null` when:
 *   - The input is null, undefined, or not a plain object.
 *   - The response contains an `error` field (simulation failed).
 *   - Neither `cost` nor `minResourceFee` fields are present.
 *
 * Missing numeric fields default to `0` rather than `NaN`.
 *
 * @param response - The raw simulation response object (or null/undefined).
 * @returns A ResourceEstimate on success, or null on failure.
 */
export function parseResourceEstimate(response: unknown): ResourceEstimate | null {
    if (response === null || response === undefined) return null;
    if (typeof response !== "object" || Array.isArray(response)) return null;

    const sim = response as Record<string, unknown>;

    // Simulation error responses have an `error` field — always return null.
    if (typeof sim["error"] === "string" && sim["error"].length > 0) return null;

    // Need at least one useful field to return a meaningful estimate.
    const hasCost = sim["cost"] !== undefined && sim["cost"] !== null;
    const hasFee = sim["minResourceFee"] !== undefined && sim["minResourceFee"] !== null;
    if (!hasCost && !hasFee) return null;

    // Parse minResourceFee (may be a string or number in the Soroban RPC response)
    const rawFee = sim["minResourceFee"];
    const minResourceFee = rawFee !== undefined && rawFee !== null
        ? safeParseNumber(rawFee)
        : 0;

    // Parse cost fields
    let cpuInstructions = 0;
    let memoryBytes = 0;

    if (hasCost && typeof sim["cost"] === "object" && !Array.isArray(sim["cost"])) {
        const cost = sim["cost"] as Record<string, unknown>;
        cpuInstructions = safeParseNumber(cost["cpuInsns"]);
        memoryBytes = safeParseNumber(cost["memBytes"]);
    }

    return { cpuInstructions, memoryBytes, minResourceFee };
}

/** Parse a value to a non-negative finite integer, defaulting to 0. */
function safeParseNumber(value: unknown): number {
    if (value === undefined || value === null) return 0;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export interface FeeStatsResult {
    latestLedger?: number;
    baseFeeStroops: number;
    surgeFeeStroops: number;
    surgePricingMultiplier: number;
}

export interface SubmitTransactionResult {
    success: boolean;
    txHash: string;
    ledger: number;
    cpuInsns?: number;
    memBytes?: number;
    error?: string;
    cpuInstructions?: number;
    memoryBytes?: number;
    minResourceFee?: number;
    /** Actual fee charged in stroops, parsed from the transaction result. */
    feeCharged?: number;
}

export function extractResourceCosts(resultMetaXdrBase64: string): { cpuInstructions: number, memoryBytes: number } | null {
    if (!resultMetaXdrBase64) return null;
    try {
        const meta = xdr.TransactionMeta.fromXDR(resultMetaXdrBase64, "base64");
        const v3 = typeof meta.v3 === 'function' ? meta.v3() : undefined;
        
        if (v3) {
            const sorobanMeta = typeof v3.sorobanMeta === 'function' ? v3.sorobanMeta() : undefined;
            if (sorobanMeta) {
                const meta = sorobanMeta as SorobanMetaLike;
                const cpuInstructions = typeof meta.cpuInstructions === 'function' ? Number(meta.cpuInstructions()) : undefined;
                const memoryBytes = typeof meta.memoryBytes === 'function' ? Number(meta.memoryBytes()) : undefined;

                if (cpuInstructions !== undefined && memoryBytes !== undefined) {
                    return { cpuInstructions, memoryBytes };
                }
            }
        }
    } catch (error) {
        logger.debug("Failed to decode resultMetaXdr for resource costs", { error: String(error) });
    }
    return null;
}

const NETWORK_PASSPHRASES: Record<string, string> = {
    testnet: Networks.TESTNET,
    mainnet: Networks.PUBLIC,
};

export interface StellarRpcClientOptions {
    maxRequestsPerSecond?: number;
    rpcCertificateFingerprint?: string;
}

/** How long a repeatedly-failing endpoint is skipped before being retried (issue #496). */
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

interface RpcEndpoint {
    url: string;
    /** Already wrapped with wrapServerWithUnreachableDetection. */
    server: rpc.Server;
    circuitBrokenUntil: number;
}

/**
 * Whether an error from one endpoint should trigger a failover attempt
 * against the next configured endpoint, rather than surfacing immediately.
 * Network-level failures and rate-limit/server-error HTTP statuses are
 * endpoint problems worth retrying elsewhere; anything else (a simulation
 * error, a bad request) would just fail identically on any endpoint.
 */
function isFailoverEligible(error: unknown): boolean {
    if (error instanceof RpcUnreachableError) return true;
    const err = error as ErrorLike;
    const status = err?.response?.status;
    if (status === 429 || (typeof status === "number" && status >= 500 && status < 600)) return true;
    return isNetworkError(error);
}

export class StellarRpcClient {
    private readonly network: string;
    private readonly endpoints: RpcEndpoint[];
    private readonly maxRequestsPerSecond: number;
    private readonly requestIntervalMs: number;
    private recentRequestTimes: number[] = [];

    /**
     * A Proxy standing in for a single rpc.Server, transparently retrying
     * every method call against subsequent configured endpoints when the
     * active one fails with a network-level or rate-limit/server error
     * (issue #496). Built once and kept as a stable, reassignable property —
     * not a getter that synthesizes a new object per access — so tests can
     * still `vi.spyOn(client["server"], "methodName")` (spying overrides the
     * proxy's own get/set trap for that one property, bypassing failover for
     * it) or replace `.server` wholesale with a bare mock, exactly as before
     * this issue. With a single configured URL this behaves exactly as
     * before — one endpoint, no failover possible or attempted.
     */
    private server: rpc.Server;

    constructor(network: string, customUrl?: string | string[], options: StellarRpcClientOptions = {}) {
        this.network = network;
        const configured = options.maxRequestsPerSecond ?? 5;
        this.maxRequestsPerSecond = configured > 0 ? configured : 5;
        this.requestIntervalMs = Math.ceil(1000 / this.maxRequestsPerSecond);

        let urls: string[];
        if (Array.isArray(customUrl)) {
            urls = customUrl.map((u) => u.trim()).filter(Boolean);
        } else if (typeof customUrl === "string" && customUrl.length > 0) {
            urls = customUrl.split(",").map((u) => u.trim()).filter(Boolean);
        } else {
            const defaultUrl = RPC_URLS[network];
            if (!defaultUrl) {
                throw new Error(`Unknown network "${network}". Use "testnet", "mainnet", or provide a custom URL.`);
            }
            urls = [defaultUrl];
        }
        if (urls.length === 0) {
            throw new Error("No RPC URLs provided.");
        }

        this.endpoints = urls.map((url) => ({
            url,
            server: wrapServerWithUnreachableDetection(
                new rpc.Server(url, { allowHttp: url.startsWith("http://") }),
                url,
            ),
            circuitBrokenUntil: 0,
        }));

        const target = {} as Record<string | symbol, unknown>;
        this.server = new Proxy(target as unknown as rpc.Server, {
            get: (t, prop) => {
                const raw = t as unknown as Record<string | symbol, unknown>;
                if (Object.prototype.hasOwnProperty.call(raw, prop)) {
                    return raw[prop];
                }
                return (...args: unknown[]): unknown => this.callWithFailover(prop as string, args);
            },
            set: (t, prop, value) => {
                (t as unknown as Record<string | symbol, unknown>)[prop] = value;
                return true;
            },
            has: () => true,
            // Synthesizes a real property descriptor for any method name so
            // Object.getOwnPropertyDescriptor (and therefore vi.spyOn) sees a
            // normal, spy-able function rather than "does not exist" — the
            // target object itself only gains own properties once something
            // is actually get/set through the proxy.
            getOwnPropertyDescriptor: (t, prop) => {
                const raw = t as unknown as Record<string | symbol, unknown>;
                if (Object.prototype.hasOwnProperty.call(raw, prop)) {
                    return Object.getOwnPropertyDescriptor(raw, prop);
                }
                return {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: (...args: unknown[]): unknown => this.callWithFailover(prop as string, args),
                };
            },
        });
    }

    private getOrderedEndpoints(): RpcEndpoint[] {
        const now = Date.now();
        const available = this.endpoints.filter((ep) => now >= ep.circuitBrokenUntil);
        // If every endpoint is currently in its cooldown window, attempt them
        // anyway rather than hard-failing — better to try a "known-bad"
        // endpoint than to refuse to make any request at all.
        return available.length > 0 ? available : this.endpoints;
    }

    private markEndpointFailed(endpoint: RpcEndpoint, error: unknown): void {
        logger.warn("RPC endpoint failed, skipping for cooldown period", {
            url: endpoint.url,
            error: error instanceof Error ? error.message : String(error),
        });
        endpoint.circuitBrokenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    }

    private async callWithFailover(methodName: string, args: unknown[]): Promise<unknown> {
        const endpoints = this.getOrderedEndpoints();
        let lastError: unknown;

        for (const endpoint of endpoints) {
            try {
                const server = endpoint.server as unknown as Record<string, (...a: unknown[]) => unknown>;
                const method = server[methodName];
                if (typeof method !== "function") {
                    return method;
                }
                return await Reflect.apply(method, endpoint.server, args);
            } catch (error) {
                lastError = error;
                if (!isFailoverEligible(error) || endpoints.length === 1) {
                    throw error;
                }
                this.markEndpointFailed(endpoint, error);
            }
        }

        throw lastError;
    }

    getNetwork(): string {
        return this.network;
    }

    async checkHealth() {
        return await this.withRateLimit(() => this.server.getHealth());
    }

    async getCurrentLedger(): Promise<number> {
        if (typeof this.server.getLatestLedger === "function") {
            try {
                const response = await this.withRateLimit(() => this.server.getLatestLedger());
                const seq = response?.sequence;
                if (typeof seq === "number" && seq > 0) return seq;
            } catch (error) {
                logger.debug("getLatestLedger failed, falling back to getHealth", error);
            }
        }

        const health = await this.withRateLimit(() => this.server.getHealth());
        if (health && typeof health.latestLedger === "number") {
            return health.latestLedger;
        }

        throw new Error("Unable to determine latest ledger from RPC server");
    }

    async getFeeStats(): Promise<FeeStatsResult> {
        return await this.withRateLimit(async () => {
            if (typeof this.server.getFeeStats !== "function") {
                throw new Error("RPC server does not support getFeeStats");
            }

            const response = await this.server.getFeeStats();
            const inclusionFee = response.sorobanInclusionFee ?? response.inclusionFee;
            if (!inclusionFee) {
                throw new Error("RPC fee stats response did not include inclusion fee data");
            }

            const baseFeeStroops = parseFeeStat(inclusionFee.p50 ?? inclusionFee.mode ?? inclusionFee.min);
            const surgeFeeStroops = parseFeeStat(
                inclusionFee.p95 ?? inclusionFee.p90 ?? inclusionFee.max ?? baseFeeStroops,
            );
            const surgePricingMultiplier = baseFeeStroops > 0
                ? Math.max(surgeFeeStroops / baseFeeStroops, 1)
                : 1;

            return {
                latestLedger: typeof response.latestLedger === "number" ? response.latestLedger : undefined,
                baseFeeStroops,
                surgeFeeStroops,
                surgePricingMultiplier,
            };
        });
    }

    async getContractInstanceEntry(contractId: string): Promise<ContractInstanceResult | null> {
        const contract = new Contract(contractId);
        const instanceKey = contract.getFootprint();
        const entryKeyXdr = instanceKey.toXDR("base64");

        const response = await this.server.getLedgerEntries(instanceKey);

        if (!response.entries || response.entries.length === 0) return null;

        const entry = response.entries[0]!;
        const latestLedger = response.latestLedger;
        const liveUntilLedgerSeq = entry.liveUntilLedgerSeq ?? 0;
        const lastModifiedLedgerSeq = entry.lastModifiedLedgerSeq ?? 0;
        const remainingTTL = liveUntilLedgerSeq - latestLedger;

        let executableType = "unknown";
        let wasmHash: string | null = null;

        try {
            const contractData = entry.val.contractData();
            const instance = contractData.val().instance();
            const executable = instance.executable();
            executableType = executable.switch().name;

            if (executableType === "contractExecutableWasm") {
                wasmHash = executable.wasmHash().toString("hex");
            }
        } catch (error) {
            logger.error("Error extracting executable info from contract instance entry", error);
        }

        return {
            entryKeyXdr,
            executableType,
            latestLedger,
            liveUntilLedgerSeq,
            lastModifiedLedgerSeq,
            remainingTTL,
            wasmHash,
        };
    }

    async getWasmCodeEntry(
        wasmHashHex: string
    ): Promise<SorokeepLedgerEntryResult | null> {
        const wasmHash = Buffer.from(wasmHashHex, "hex");
        const wasmKey = xdr.LedgerKey.contractCode(
            new xdr.LedgerKeyContractCode({ hash: wasmHash })
        );
        const entryKeyXdr = wasmKey.toXDR("base64");

        const response = await this.server.getLedgerEntries(wasmKey);
        if (!response.entries || response.entries.length === 0) return null;

        const entry = response.entries[0]!;
        const latestLedger = response.latestLedger;
        const liveUntilLedgerSeq = entry.liveUntilLedgerSeq ?? 0;
        const lastModifiedLedgerSeq = entry.lastModifiedLedgerSeq ?? 0;

        return {
            entryKeyXdr,
            latestLedger,
            liveUntilLedgerSeq,
            lastModifiedLedgerSeq,
            remainingTTL: liveUntilLedgerSeq - latestLedger,
        };
    }

    async getEntryTTLs(entryKeyXdrs: string[]): Promise<EntryTTLsResult> {
        const keys = entryKeyXdrs.map((xdrStr) =>
            xdr.LedgerKey.fromXDR(xdrStr, "base64")
        );

        const response = await this.server.getLedgerEntries(...keys);
        const latestLedger = response.latestLedger;

        const entries = (response.entries ?? []).map((entry) => {
            const liveUntilLedgerSeq = entry.liveUntilLedgerSeq ?? 0;
            const lastModifiedLedgerSeq = entry.lastModifiedLedgerSeq ?? 0;
            return {
                entryKeyXdr: entry.key.toXDR("base64"),
                latestLedger,
                liveUntilLedgerSeq,
                lastModifiedLedgerSeq,
                remainingTTL: liveUntilLedgerSeq - latestLedger,
            };
        });

        return { latestLedger, entries };
    }

    async getContractStorageEntries(entryKeyXdrs: string[]): Promise<ContractStorageEntryResult[]> {
        if (entryKeyXdrs.length === 0) return [];
        const keys = entryKeyXdrs.map((xdrStr) =>
            xdr.LedgerKey.fromXDR(xdrStr, "base64")
        );

        const response = await this.server.getLedgerEntries(...keys);
        const latestLedger = response.latestLedger;

        return (response.entries ?? []).map((entry) => {
            const liveUntilLedgerSeq = entry.liveUntilLedgerSeq ?? 0;
            const lastModifiedLedgerSeq = entry.lastModifiedLedgerSeq ?? 0;
            let valXdr: string | undefined;
            try {
                if (entry.val && entry.val.switch().name === "contractData") {
                    valXdr = entry.val.contractData().val().toXDR("base64");
                }
            } catch {
                // ignore
            }
            return {
                entryKeyXdr: entry.key.toXDR("base64"),
                latestLedger,
                liveUntilLedgerSeq,
                lastModifiedLedgerSeq,
                remainingTTL: liveUntilLedgerSeq - latestLedger,
                valXdr,
            };
        });
    }

    async getSacDecimals(contractId: string): Promise<number> {
        try {
            const passphrase = await this.getNetworkPassphrase();
            const contract = new Contract(contractId);
            const op = contract.call("decimals");
            const account = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");

            const tx = new TransactionBuilder(account, {
                fee: "100",
                networkPassphrase: passphrase,
            })
                .addOperation(op)
                .setTimeout(30)
                .build();

            const sim = await this.server.simulateTransaction(tx);
            if (!rpc.Api.isSimulationError(sim)) {
                const successSim = sim as rpc.Api.SimulateTransactionSuccessResponse;
                if (successSim.result?.retval) {
                    const retval = successSim.result.retval;
                    if (retval.switch().name === "scvU32") {
                        return retval.u32();
                    }
                }
            }
        } catch {
            // fallback below
        }
        return 7; // standard SAC / XLM asset decimals
    }

    /**
     * Call the 'get_monitored_keys' view method on a contract.
     * Returns an array of XDR strings for the keys.
     */
    async getMonitoredKeys(contractId: string): Promise<string[]> {
        const passphrase = await this.getNetworkPassphrase();
        const contract = new Contract(contractId);
        const op = contract.call("get_monitored_keys");

        const account = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");

        const tx = new TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: passphrase,
        })
            .addOperation(op)
            .setTimeout(30)
            .build();

        const sim = await this.server.simulateTransaction(tx);

        assertSimulationSuccess(sim);

        const successSim = sim;
        
        const scv = successSim.result!.retval;
        if (scv.switch().name === "scvVec") {
            const vec = scv.vec()!;
            return vec.map(val => val.toXDR("base64"));
        }
        
        return [];
    }

    async simulateExtension(
        entryKeyXdrs: string[],
        extendToLedgers: number,
        sourcePublicKey: string,
    ): Promise<SimulateExtensionResult> {
        const passphrase = await this.getNetworkPassphrase();

        const accountResponse = await this.server.getAccount(sourcePublicKey);
        const account = new Account(sourcePublicKey, accountResponse.sequenceNumber());

        const keys = entryKeyXdrs.map(k => xdr.LedgerKey.fromXDR(k, "base64"));

        const tx = new TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: passphrase,
        })
            .addOperation(
                Operation.extendFootprintTtl({
                    extendTo: extendToLedgers,
                }),
            )
            .setTimeout(30)
            .setSorobanData(
                new SorobanDataBuilder()
                    .setReadOnly(keys)
                    .build(),
            )
            .build();

        const sim = await this.server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(sim)) {
            return {
                success: false,
                minResourceFee: 0,
                error: sim.error ?? "Simulation failed",
            };
        }

        const successSim = sim;
        return {
            success: true,
            minResourceFee: Number(successSim.minResourceFee ?? 0),
            cpuInstructions: Number((successSim as SimulateWithCost).cost?.cpuInsns ?? 0),
            memoryBytes: Number((successSim as SimulateWithCost).cost?.memBytes ?? 0),
            readBytes: Number((successSim as SimulateWithCost).cost?.readBytes ?? 0),
            writeBytes: Number((successSim as SimulateWithCost).cost?.writeBytes ?? 0),
        };
    }

    async simulateRestore(
        entryKeyXdrs: string[],
        sourcePublicKey: string,
    ): Promise<SimulateExtensionResult> {
        const passphrase = await this.getNetworkPassphrase();
        const accountResponse = await this.server.getAccount(sourcePublicKey);
        const account = new Account(sourcePublicKey, accountResponse.sequenceNumber());

        const keys = entryKeyXdrs.map(k => xdr.LedgerKey.fromXDR(k, "base64"));

        const tx = new TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: passphrase,
        })
            .addOperation(Operation.restoreFootprint({}))
            .setTimeout(30)
            .setSorobanData(
                new SorobanDataBuilder()
                    .setReadWrite(keys)
                    .build(),
            )
            .build();

        const sim = await this.server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(sim)) {
            return {
                success: false,
                minResourceFee: 0,
                error: sim.error ?? "Simulation failed",
            };
        }

        const successSim = sim as rpc.Api.SimulateTransactionSuccessResponse;
        return {
            success: true,
            minResourceFee: Number(successSim.minResourceFee ?? 0),
        };
    }


    /**
     * Build, sign, and submit an ExtendFootprintTTLOp transaction.
     * Uses simulation to prepare the transaction with correct resource parameters.
     * Recovers once from txBadSeq errors by refreshing the account sequence.
     */
    async submitExtension(
        entryKeyXdrs: string[],
        extendToLedgers: number,
        secretKey: string,
    ): Promise<SubmitTransactionResult> {
        const passphrase = await this.getNetworkPassphrase();
        const keypair = Keypair.fromSecret(secretKey);
        const publicKey = keypair.publicKey();

        const keys = entryKeyXdrs.map(k => xdr.LedgerKey.fromXDR(k, "base64"));

        const buildTx = async () => {
            const accountResponse = await this.server.getAccount(publicKey);
            const account = new Account(publicKey, accountResponse.sequenceNumber());
            return new TransactionBuilder(account, { fee: "100", networkPassphrase: passphrase })
                .addOperation(Operation.extendFootprintTtl({ extendTo: extendToLedgers }))
                .setTimeout(30)
                .setSorobanData(new SorobanDataBuilder().setReadOnly(keys).build())
                .build();
        };

        const tx = await buildTx();
        const sim = await this.server.simulateTransaction(tx);

        assertSimulationSuccess(sim);

        const prepared = rpc.assembleTransaction(tx, sim).build();
        prepared.sign(keypair);
        const sendResult = await this.server.sendTransaction(prepared);

        if (sendResult.status === "ERROR") {
            if (this.isBadSeqError(sendResult)) {
                logger.warn("Sequence mismatch detected on ExtendFootprintTTL — refreshing account sequence and retrying");
                const retryTx = await buildTx();
                const retrySim = await this.server.simulateTransaction(retryTx);
                if (rpc.Api.isSimulationError(retrySim)) {
                    return { success: false, txHash: "", ledger: 0, cpuInsns: 0, memBytes: 0, error: retrySim.error ?? "Simulation failed on retry" };
                }
                const retryPrepared = rpc.assembleTransaction(retryTx, retrySim).build();
                retryPrepared.sign(keypair);
                const retrySendResult = await this.server.sendTransaction(retryPrepared);
                if (retrySendResult.status === "ERROR") {
                    const diagnostics = (retrySendResult as SendTransactionErrorResult).errorResult ?? (retrySendResult as SendTransactionErrorResult).diagnosticEventsXdr ?? "";
                    return { success: false, txHash: retrySendResult.hash, ledger: 0, cpuInsns: Number((retrySim as SimulateWithCost).cost?.cpuInsns ?? 0), memBytes: Number((retrySim as SimulateWithCost).cost?.memBytes ?? 0), error: `Transaction send error: ${diagnostics || retrySendResult.status}` };
                }
                const txResult = await this.pollTransaction(retrySendResult.hash);
                return txResult.success ? this.addResourcesToSuccess(txResult, retrySim as rpc.Api.SimulateTransactionSuccessResponse) : txResult;
            }
            const diagnostics = (sendResult as SendTransactionErrorResult).errorResult ?? (sendResult as SendTransactionErrorResult).diagnosticEventsXdr ?? "";
            return {
                success: false,
                txHash: sendResult.hash,
                ledger: 0,
                cpuInsns: Number((sim as SimulateWithCost).cost?.cpuInsns ?? 0),
                memBytes: Number((sim as SimulateWithCost).cost?.memBytes ?? 0),
                error: `Transaction send error: ${diagnostics || sendResult.status}`,
            };
        }

        const txResult = await this.pollTransaction(sendResult.hash);
        return txResult.success ? this.addResourcesToSuccess(txResult, sim as rpc.Api.SimulateTransactionSuccessResponse) : txResult;
    }

    // Helper to add resource usage to a successful transaction result
    private addResourcesToSuccess(result: SubmitTransactionResult, sim: rpc.Api.SimulateTransactionSuccessResponse): SubmitTransactionResult {
        return { ...result, cpuInsns: Number((sim as SimulateWithCost).cost?.cpuInsns ?? 0), memBytes: Number((sim as SimulateWithCost).cost?.memBytes ?? 0) };
    }

    /**
     * Build an ExtendFootprintTTLOp transaction, wrap it in a FeeBumpTransaction
     * signed by the sponsor keypair, and submit. The sponsor account pays all fees
     * while the inner transaction's source account provides the sequence number.
     */
    async submitExtensionWithFeeBump(
        entryKeyXdrs: string[],
        extendToLedgers: number,
        secretKey: string,
        sponsorSecretKey: string,
    ): Promise<SubmitTransactionResult> {
        const passphrase = await this.getNetworkPassphrase();
        const keypair = Keypair.fromSecret(secretKey);
        const sponsorKeypair = Keypair.fromSecret(sponsorSecretKey);
        const publicKey = keypair.publicKey();
        const keys = entryKeyXdrs.map(k => xdr.LedgerKey.fromXDR(k, "base64"));

        const buildTx = async () => {
            const accountResponse = await this.server.getAccount(publicKey);
            const account = new Account(publicKey, accountResponse.sequenceNumber());
            return new TransactionBuilder(account, { fee: "100", networkPassphrase: passphrase })
                .addOperation(Operation.extendFootprintTtl({ extendTo: extendToLedgers }))
                .setTimeout(30)
                .setSorobanData(new SorobanDataBuilder().setReadOnly(keys).build())
                .build();
        };

        const tx = await buildTx();
        const sim = await this.server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(sim)) {
            return { success: false, txHash: "", ledger: 0, cpuInsns: 0, memBytes: 0, error: sim.error ?? "Simulation failed" };
        }

        const buildAndSignFeeBump = (innerTx: Transaction, simResult: rpc.Api.SimulateTransactionSuccessResponse) => {
            const prepared = rpc.assembleTransaction(innerTx, simResult).build();
            prepared.sign(keypair);
            const feeBump = TransactionBuilder.buildFeeBumpTransaction(
                sponsorKeypair,
                (parseInt(prepared.fee, 10) + 10000).toString(),
                prepared,
                passphrase
            );
            feeBump.sign(sponsorKeypair);
            return feeBump;
        };

        const feeBump = buildAndSignFeeBump(tx, sim);
        const sendResult = await this.server.sendTransaction(feeBump);

        if (sendResult.status === "ERROR") {
            if (this.isBadSeqError(sendResult)) {
                logger.warn("Sequence mismatch detected on feeBump ExtendFootprintTTL — refreshing account sequence and retrying");
                const retryTx = await buildTx();
                const retrySim = await this.server.simulateTransaction(retryTx);
                if (rpc.Api.isSimulationError(retrySim)) {
                    return { success: false, txHash: "", ledger: 0, cpuInsns: 0, memBytes: 0, error: retrySim.error ?? "Simulation failed on retry" };
                }
                const retryFeeBump = buildAndSignFeeBump(retryTx, retrySim);
                const retrySendResult = await this.server.sendTransaction(retryFeeBump);
                if (retrySendResult.status === "ERROR") {
                    const diagnostics = (retrySendResult as SendTransactionErrorResult).errorResult ?? (retrySendResult as SendTransactionErrorResult).diagnosticEventsXdr ?? "";
                    return { success: false, txHash: retrySendResult.hash, ledger: 0, cpuInsns: Number((retrySim as SimulateWithCost).cost?.cpuInsns ?? 0), memBytes: Number((retrySim as SimulateWithCost).cost?.memBytes ?? 0), error: `Transaction send error: ${diagnostics || retrySendResult.status}` };
                }
                const txResult = await this.pollTransaction(retrySendResult.hash);
                return txResult.success ? this.addResourcesToSuccess(txResult, retrySim as rpc.Api.SimulateTransactionSuccessResponse) : txResult;
            }
            const diagnostics = (sendResult as SendTransactionErrorResult).errorResult ?? (sendResult as SendTransactionErrorResult).diagnosticEventsXdr ?? "";
            return {
                success: false,
                txHash: sendResult.hash,
                ledger: 0,
                cpuInsns: Number((sim as SimulateWithCost).cost?.cpuInsns ?? 0),
                memBytes: Number((sim as SimulateWithCost).cost?.memBytes ?? 0),
                error: `Transaction send error: ${diagnostics || sendResult.status}`,
            };
        }

        const txResult = await this.pollTransaction(sendResult.hash);
        return txResult.success ? this.addResourcesToSuccess(txResult, sim as rpc.Api.SimulateTransactionSuccessResponse) : txResult;
    }

    /**
     * Build, sign, and submit a RestoreFootprintOp transaction to restore archived entries.
     * Recovers once from txBadSeq errors by refreshing the account sequence.
     */
    async submitRestore(
        entryKeyXdrs: string[],
        secretKey: string,
    ): Promise<SubmitTransactionResult> {
        const passphrase = await this.getNetworkPassphrase();
        const keypair = Keypair.fromSecret(secretKey);
        const publicKey = keypair.publicKey();
        const keys = entryKeyXdrs.map(k => xdr.LedgerKey.fromXDR(k, "base64"));

        const buildTx = async () => {
            const accountResponse = await this.server.getAccount(publicKey);
            const account = new Account(publicKey, accountResponse.sequenceNumber());
            return new TransactionBuilder(account, { fee: "100", networkPassphrase: passphrase })
                .addOperation(Operation.restoreFootprint({}))
                .setTimeout(30)
                .setSorobanData(new SorobanDataBuilder().setReadWrite(keys).build())
                .build();
        };

        const tx = await buildTx();
        const sim = await this.server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(sim)) {
            return {
                success: false,
                txHash: "",
                ledger: 0,
                cpuInsns: 0,
                memBytes: 0,
                error: sim.error ?? "Simulation failed",
            };
        }

        const prepared = rpc.assembleTransaction(tx, sim).build();
        prepared.sign(keypair);
        const sendResult = await this.server.sendTransaction(prepared);        if (sendResult.status === "ERROR") {
            if (this.isBadSeqError(sendResult)) {
                logger.warn("Sequence mismatch detected on RestoreFootprint — refreshing account sequence and retrying");
                const retryTx = await buildTx();
                const retrySim = await this.server.simulateTransaction(retryTx);
                if (rpc.Api.isSimulationError(retrySim)) {
                    return { success: false, txHash: "", ledger: 0, cpuInsns: 0, memBytes: 0, error: retrySim.error ?? "Simulation failed on retry" };
                }
                const retryPrepared = rpc.assembleTransaction(retryTx, retrySim).build();
                retryPrepared.sign(keypair);
                const retrySendResult = await this.server.sendTransaction(retryPrepared);
                if (retrySendResult.status === "ERROR") {
                    const diagnostics = (retrySendResult as SendTransactionErrorResult).errorResult ?? (retrySendResult as SendTransactionErrorResult).diagnosticEventsXdr ?? "";
                    return { success: false, txHash: retrySendResult.hash, ledger: 0, cpuInsns: Number((retrySim as SimulateWithCost).cost?.cpuInsns ?? 0), memBytes: Number((retrySim as SimulateWithCost).cost?.memBytes ?? 0), error: `Transaction send error: ${diagnostics || retrySendResult.status}` };
                }
                const txResult = await this.pollTransaction(retrySendResult.hash);
                return txResult.success ? this.addResourcesToSuccess(txResult, retrySim as rpc.Api.SimulateTransactionSuccessResponse) : txResult;
            }
            const diagnostics = (sendResult as SendTransactionErrorResult).errorResult ?? (sendResult as SendTransactionErrorResult).diagnosticEventsXdr ?? "";
            return {
                success: false,
                txHash: sendResult.hash,
                ledger: 0,
                cpuInsns: Number((sim as SimulateWithCost).cost?.cpuInsns ?? 0),
                memBytes: Number((sim as SimulateWithCost).cost?.memBytes ?? 0),
                error: `Transaction send error: ${diagnostics || sendResult.status}`,
            };
        }

        const txResult = await this.pollTransaction(sendResult.hash);
        return txResult.success ? this.addResourcesToSuccess(txResult, sim as rpc.Api.SimulateTransactionSuccessResponse) : txResult;
    }

    async sendPayments(
        destinations: { publicKey: string; amountXlm: string }[],
        secretKey: string,
    ): Promise<SubmitTransactionResult> {
        if (destinations.length === 0) {
            return { success: true, txHash: "", ledger: 0 };
        }

        const passphrase = await this.getNetworkPassphrase();
        const keypair = Keypair.fromSecret(secretKey);
        const publicKey = keypair.publicKey();

        const accountResponse = await this.server.getAccount(publicKey);
        const account = new Account(publicKey, accountResponse.sequenceNumber());

        const builder = new TransactionBuilder(account, {
            fee: String(100 * destinations.length),
            networkPassphrase: passphrase,
        });

        for (const dest of destinations) {
            builder.addOperation(
                Operation.payment({
                    destination: dest.publicKey,
                    asset: Asset.native(),
                    amount: dest.amountXlm,
                }),
            );
        }

        const tx = builder.setTimeout(30).build();
        tx.sign(keypair);

        const sendResult = await this.server.sendTransaction(tx);

        if (sendResult.status === "ERROR") {
            const diagnostics = (sendResult as SendTransactionErrorResult).errorResult ?? "";
            return {
                success: false,
                txHash: sendResult.hash,
                ledger: 0,
                error: `Transaction send error: ${diagnostics || sendResult.status}`,
            };
        }

        return this.pollTransaction(sendResult.hash);
    }


    /**
     * Returns true if the sendTransaction ERROR response indicates a txBadSeq result code.
     * The SDK parses errorResultXdr into `errorResult` as an xdr.TransactionResult.
     */
    private isBadSeqError(sendResult: SendTransactionErrorResult): boolean {
        try {
            const errorResult = sendResult.errorResult;
            if (!errorResult) return false;
            // errorResult may be a base64 string or a pre-parsed xdr.TransactionResult
            const parsed = typeof errorResult === "string"
                ? xdr.TransactionResult.fromXDR(errorResult, "base64")
                : (errorResult as xdr.TransactionResult);
            return parsed.result().switch().name === "txBadSeq";
        } catch {
            return false;
        }
    }

    private _cachedPassphrase: string | undefined;

    private async getNetworkPassphrase(): Promise<string> {
        if (this._cachedPassphrase) return this._cachedPassphrase;

        return await this.withRateLimit(async () => {
            // Try fetching from the RPC server first
            try {
                const networkInfo = await this.server.getNetwork();
                if (networkInfo.passphrase) {
                    this._cachedPassphrase = networkInfo.passphrase;
                    return networkInfo.passphrase;
                }
            } catch {
                // Fall through to hardcoded table
            }

            const passphrase = NETWORK_PASSPHRASES[this.network];
            if (!passphrase) {
                throw new Error(
                    `No network passphrase for "${this.network}". Use "testnet" or "mainnet".`,
                );
            }
            this._cachedPassphrase = passphrase;
            return passphrase;
        });
    }

    private async pollTransaction(
        txHash: string,
        maxAttempts = 30,
        intervalMs = 1000,
    ): Promise<SubmitTransactionResult> {
        for (let i = 0; i < maxAttempts; i++) {
            const txResponse = await this.withRateLimit(() => this.server.getTransaction(txHash));

            if (txResponse.status === "SUCCESS") {
                const resultMetaXdr = (txResponse as unknown as GetTransactionRawFields).resultMetaXdr;
                let cpuInstructions: number | undefined = undefined;
                let memoryBytes: number | undefined = undefined;

                if (resultMetaXdr) {
                    const costs = extractResourceCosts(resultMetaXdr);
                    if (costs) {
                        cpuInstructions = costs.cpuInstructions;
                        memoryBytes = costs.memoryBytes;

                        logger.info(
                            "Extracted transaction resource costs successfully",
                            { txHash, cpuInstructions, memoryBytes }
                        );
                    }
                }

                const rawFee = (txResponse as unknown as GetTransactionRawFields).feeCharged;
                const feeCharged = rawFee !== undefined ? Number(rawFee) : undefined;

                return {
                    success: true,
                    txHash,
                    ledger: (txResponse as unknown as GetTransactionRawFields).ledger ?? txResponse.latestLedger,
                    cpuInstructions,
                    memoryBytes,
                    feeCharged,
                };
            }

            if (txResponse.status === "FAILED") {
                return {
                    success: false,
                    txHash,
                    ledger: (txResponse as unknown as GetTransactionRawFields).ledger ?? txResponse.latestLedger,
                    error: "Transaction failed on-chain",
                };
            }

            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }

        return {
            success: false,
            txHash,
            ledger: 0,
            error: `Transaction polling timed out after ${maxAttempts} attempts`,
        };
    }

    private async withRateLimit<T>(operation: () => Promise<T>): Promise<T> {
        const waitMs = this.acquireSlot();
        if (waitMs > 0) {
            await this.sleep(waitMs);
        }
        return operation();
    }

    private acquireSlot(): number {
        const now = Date.now();
        const windowStart = now - 1000;
        this.recentRequestTimes = this.recentRequestTimes.filter(t => t > windowStart);

        if (this.recentRequestTimes.length < this.maxRequestsPerSecond) {
            this.recentRequestTimes.push(now);
            return 0;
        }

        // Wait until the slot-blocking request in the window falls out
        const blockingRequest = this.recentRequestTimes[this.recentRequestTimes.length - this.maxRequestsPerSecond]!;
        const waitMs = blockingRequest + 1000 - now;
        this.recentRequestTimes.push(now + waitMs);
        return waitMs;
    }

    /** @deprecated Use acquireSlot-based withRateLimit instead. Kept for compatibility. */
    private calculateWaitMs(): number {
        const now = Date.now();
        const windowStart = now - 1000;
        const recent = this.recentRequestTimes.filter(t => t > windowStart);
        if (recent.length < this.maxRequestsPerSecond) return 0;
        const oldest = recent[0]!;
        return Math.max(0, oldest + 1000 - now);
    }

    private async sleep(ms: number): Promise<void> {
        if (ms <= 0) return;
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }
}

function parseFeeStat(value: string | number | bigint | undefined): number {
    if (value === undefined) return 0;
    if (typeof value === "bigint") return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
