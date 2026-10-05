/**
 * Soroban rent cost projection model — Issue #168.
 *
 * Implements the canonical Stellar Soroban rent formula from
 * stellar/rs-soroban-env (soroban-env-host/src/fees.rs):
 *
 *   rent_stroops = ceil(
 *     entry_size_bytes × fee_per_rent_1kb × rent_ledgers
 *     / (1024 × rent_rate_denominator)
 *   )
 *
 * Where:
 *   - entry_size_bytes: in-memory size of the ledger entry
 *   - fee_per_rent_1kb: effective rent write fee per 1 KB (in stroops),
 *     computed from the current Soroban state size via
 *     `compute_rent_write_fee_per_1kb`. For projections, treated as an
 *     input (use network defaults or a fetched value).
 *   - rent_ledgers: number of ledger increments being projected
 *   - rent_rate_denominator: persistent_rent_rate_denominator or
 *     temporary_rent_rate_denominator (network configuration)
 *
 * Code entries (WASM) receive a 1/3 discount
 * (CODE_ENTRY_RENT_DISCOUNT_FACTOR = 3).
 *
 * Network default values from stellar/rs-soroban-env and Stellar Lab
 * resource configuration as of mid-2026.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

// Imported for local use and re-exported so existing importers keep working;
// the canonical definition lives in utils/ledger.ts because four modules
// needed it and had drifted to two different values.
import { AVG_LEDGER_CLOSE_SECONDS, LEDGERS_PER_DAY } from "../utils/ledger.js";
export { AVG_LEDGER_CLOSE_SECONDS, LEDGERS_PER_DAY };

/** One XLM = 10,000,000 stroops. */
export const STROOPS_PER_XLM = 10_000_000;

/**
 * DATA_SIZE_1KB_INCREMENT from fees.rs — the byte increment used in the
 * fee calculation denominator.
 */
export const DATA_SIZE_1KB_INCREMENT = 1024;

/**
 * CODE_ENTRY_RENT_DISCOUNT_FACTOR from fees.rs.
 * WASM code entry rent fees are divided (ceiling) by this value.
 */
export const CODE_ENTRY_RENT_DISCOUNT_FACTOR = 3;

/**
 * Default effective rent write fee per 1 KB in stroops.
 *
 * This is the `fee_per_rent_1kb` value, which in production is computed
 * by `compute_rent_write_fee_per_1kb` based on the current Soroban state
 * size. The default here (1000 stroops/KB) corresponds to the minimum
 * floor `MINIMUM_RENT_WRITE_FEE_PER_1KB` defined in fees.rs and is a
 * reasonable baseline for projections when live network data is unavailable.
 *
 * Callers should override this with a freshly-fetched value for production
 * accuracy.
 */
export const DEFAULT_FEE_PER_RENT_1KB = 1000;

/**
 * Default denominator for persistent / instance entry rent rate.
 *
 * Source: Stellar network configuration (ConfigSettingsEntry).
 * Current mainnet value is 2103 ledgers, meaning 1 KB of persistent state
 * is charged `fee_per_rent_1kb / 2103` stroops per ledger.
 */
export const DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR = 2103;

/**
 * Default denominator for temporary entry rent rate.
 *
 * Temporary entries are cheaper — the network uses a larger denominator.
 * Current mainnet value is 1000 ledgers.
 */
export const DEFAULT_TEMPORARY_RENT_RATE_DENOMINATOR = 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Input parameters for a single rent cost projection. */
export interface RentProjectionInput {
    /** Size of the ledger entry in bytes. */
    entrySizeBytes: number;
    /** Number of days to project over. */
    days: number;
    /**
     * Effective rent write fee per 1 KB in stroops (fee_per_rent_1kb).
     * Defaults to DEFAULT_FEE_PER_RENT_1KB if not provided.
     */
    feePerRent1kb?: number;
    /**
     * Rent rate denominator for this entry type.
     * Use DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR for persistent/instance.
     * Use DEFAULT_TEMPORARY_RENT_RATE_DENOMINATOR for temporary.
     */
    rentRateDenominator?: number;
    /**
     * Whether this is a persistent (or instance) entry.
     * Determines which denominator default to apply if rentRateDenominator
     * is not explicitly provided.
     */
    isPersistent: boolean;
    /**
     * Whether this is a WASM code entry.
     * Code entries receive a 1/3 rent discount per CODE_ENTRY_RENT_DISCOUNT_FACTOR.
     */
    isCodeEntry?: boolean;
}

/** Result of a single rent projection. */
export interface RentProjectionResult {
    /** Number of days projected. */
    days: number;
    /** Approximate number of ledgers for this duration. */
    ledgerCount: number;
    /** Estimated rent cost in stroops. */
    estimatedFeeStroops: number;
    /** Estimated rent cost in XLM (stroops / 10_000_000). */
    estimatedFeeXlm: number;
}

/** A single window result within a multi-window projection. */
export type RentWindowProjection = RentProjectionResult;

/** Result of a 30/60/90-day multi-window projection. */
export interface RentWindowsResult {
    /** Entry size used for this projection. */
    entrySizeBytes: number;
    /** Fee per rent 1 KB used for this projection. */
    feePerRent1kb: number;
    /** Whether this is a persistent entry. */
    isPersistent: boolean;
    /** Whether this is a code entry. */
    isCodeEntry: boolean;
    /** The three projection windows: 30, 60, and 90 days. */
    windows: [RentWindowProjection, RentWindowProjection, RentWindowProjection];
}

// ─── Core projection logic ────────────────────────────────────────────────────

/**
 * Project the rent cost for a single ledger entry over a given number of days.
 *
 * Uses the canonical Soroban rent formula from fees.rs:
 *
 *   rent_stroops = ceil(
 *     entry_size_bytes × fee_per_rent_1kb × rent_ledgers
 *     / (1024 × rent_rate_denominator)
 *   )
 *
 * Code entries receive a discount: `ceil(full_fee / CODE_ENTRY_RENT_DISCOUNT_FACTOR)`.
 *
 * @param input - Projection parameters.
 * @returns Cost estimate for the given duration.
 */
export function projectRentCost(input: RentProjectionInput): RentProjectionResult {
    const {
        entrySizeBytes,
        days,
        isPersistent,
        isCodeEntry = false,
    } = input;

    const feePerRent1kb = input.feePerRent1kb ?? DEFAULT_FEE_PER_RENT_1KB;
    const rentRateDenominator =
        input.rentRateDenominator ??
        (isPersistent
            ? DEFAULT_PERSISTENT_RENT_RATE_DENOMINATOR
            : DEFAULT_TEMPORARY_RENT_RATE_DENOMINATOR);

    // Zero-input fast paths
    if (entrySizeBytes <= 0 || days <= 0 || feePerRent1kb <= 0) {
        return {
            days,
            ledgerCount: days <= 0 ? 0 : Math.ceil(days * LEDGERS_PER_DAY),
            estimatedFeeStroops: 0,
            estimatedFeeXlm: 0,
        };
    }

    // Convert days to ledger count (ceiling to avoid underestimating)
    const ledgerCount = Math.ceil(days * LEDGERS_PER_DAY);

    // Canonical rent formula from fees.rs: rent_fee_for_size_and_ledgers
    //   num   = entry_size_bytes × fee_per_rent_1kb × rent_ledgers
    //   denom = DATA_SIZE_1KB_INCREMENT × rent_rate_denominator
    //   fee   = ceil(num / denom)
    const denom = DATA_SIZE_1KB_INCREMENT * rentRateDenominator;
    let estimatedFeeStroops = Math.ceil(
        (entrySizeBytes * feePerRent1kb * ledgerCount) / denom,
    );

    // Apply code entry discount: ceil(fee / CODE_ENTRY_RENT_DISCOUNT_FACTOR)
    if (isCodeEntry) {
        estimatedFeeStroops = Math.ceil(
            estimatedFeeStroops / CODE_ENTRY_RENT_DISCOUNT_FACTOR,
        );
    }

    const estimatedFeeXlm = estimatedFeeStroops / STROOPS_PER_XLM;

    return {
        days,
        ledgerCount,
        estimatedFeeStroops,
        estimatedFeeXlm,
    };
}

/**
 * Project rent costs for the standard 30, 60, and 90-day windows.
 *
 * Convenience wrapper around `projectRentCost` that returns all three
 * windows in a single call.
 *
 * @param input - Base projection parameters (without `days`).
 * @returns Multi-window projection result with 30, 60, and 90-day estimates.
 */
export function projectRentWindows(
    input: Omit<RentProjectionInput, "days">,
): RentWindowsResult {
    const resolvedFeePerRent1kb = input.feePerRent1kb ?? DEFAULT_FEE_PER_RENT_1KB;
    const isCodeEntry = input.isCodeEntry ?? false;

    const windows = ([30, 60, 90] as const).map(days =>
        projectRentCost({ ...input, days }),
    ) as [RentWindowProjection, RentWindowProjection, RentWindowProjection];

    return {
        entrySizeBytes: input.entrySizeBytes,
        feePerRent1kb: resolvedFeePerRent1kb,
        isPersistent: input.isPersistent,
        isCodeEntry,
        windows,
    };
}
