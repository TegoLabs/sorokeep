/**
 * Ledger timing constants.
 *
 * This lives in one place deliberately. The average ledger close time was
 * previously defined four separate times with two different values — 5 s in
 * `core/monitor.ts` and `core/status.ts`, 5.5 s in `core/rent_projection.ts`
 * and `utils/formatting.ts`. `getEntryStatus` used both at once, so a single
 * returned object reported `projectedCrossingAt` on a 5 s basis and
 * `approximateTimeRemaining` on a 5.5 s basis: a 10% disagreement, roughly
 * three days apart on a 30-day TTL, describing the same moment.
 *
 * 5.5 is the value with a provenance — it comes from the network defaults in
 * stellar/rs-soroban-env and the Stellar Lab resource configuration. The two
 * 5 s copies were undocumented local literals.
 *
 * Anything converting between ledgers and wall-clock time must import from
 * here rather than redeclaring a local constant.
 */

/** Average Stellar ledger close time in seconds. */
export const AVG_LEDGER_CLOSE_SECONDS = 5.5;

/** Approximate number of ledgers per day (86400s ÷ 5.5s/ledger). */
export const LEDGERS_PER_DAY = 86400 / AVG_LEDGER_CLOSE_SECONDS;

/**
 * Wall-clock milliseconds a span of ledgers is expected to take.
 *
 * Callers previously open-coded `deltaLedgers * SECONDS_PER_LEDGER * 1000`,
 * which is where the drift crept in.
 */
export function ledgersToMilliseconds(ledgers: number): number {
    return ledgers * AVG_LEDGER_CLOSE_SECONDS * 1000;
}
