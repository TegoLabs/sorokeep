import React from "react";

export interface SorokeepSourceStatus {
  /** Whether the live Sorokeep TTL/guard source is currently reachable */
  available: boolean;
  /** Optional diagnostic message when unreachable */
  reason?: string;
  /** ISO timestamp of the last successful live Sorokeep check */
  lastCheckedAt?: string;
}

export interface OperationsLayoutProps {
  /** Live Sorokeep telemetry availability status */
  sorokeepStatus: SorokeepSourceStatus;
  /** Optional header/banner slot for ingestion data freshness (stored backend cache) */
  freshnessSlot?: React.ReactNode;
  /** Optional slot for contract deployment info (stored/RPC-backed) */
  contractInfoSlot?: React.ReactNode;
  /** Live Sorokeep-backed TTL health section */
  ttlHealthSlot?: React.ReactNode;
  /** Live Sorokeep-backed Guard status & auto-extension section */
  guardStatusSlot?: React.ReactNode;
  /** Stored webhook-backed Sorokeep alert timeline section */
  alertTimelineSlot?: React.ReactNode;
  /** Stored event-backed contract admin action history section */
  adminActivitySlot?: React.ReactNode;
}

/**
 * Operations page layout that cleanly separates live Sorokeep telemetry
 * (TTL Health, Guard Policy) from stored backend history (Alert Timeline,
 * Admin Activity, Data Freshness).
 *
 * When the live Sorokeep source is unreachable:
 * - Sections depending on live Sorokeep data render an explicit Unavailable
 *   state instead of partial or stale figures that could be mistaken for
 *   complete data.
 * - Sections backed by stored database records continue to render normally,
 *   with an explanatory banner clarifying the distinction to the visitor.
 */
export function OperationsLayout({
  sorokeepStatus,
  freshnessSlot,
  contractInfoSlot,
  ttlHealthSlot,
  guardStatusSlot,
  alertTimelineSlot,
  adminActivitySlot,
}: OperationsLayoutProps) {
  const isLiveAvailable = sorokeepStatus.available;

  return (
    <main
      aria-labelledby="operations-page-title"
      data-testid="operations-layout"
      className="mx-auto max-w-6xl space-y-6 px-4 py-6"
    >
      <header className="space-y-2 border-b border-slate-200 pb-4">
        <h1
          id="operations-page-title"
          className="text-2xl font-bold tracking-tight text-slate-900"
        >
          Storage Lifecycle &amp; Operations
        </h1>
        <p className="text-sm text-slate-600">
          System-wide TTL monitoring, Sorokeep guard activity, stored alert
          incidents, and on-chain admin actions.
        </p>
      </header>

      {freshnessSlot && (
        <div data-testid="operations-freshness-region">{freshnessSlot}</div>
      )}

      {contractInfoSlot && (
        <div data-testid="operations-contract-info-region">
          {contractInfoSlot}
        </div>
      )}

      {!isLiveAvailable && (
        <div
          role="status"
          aria-live="polite"
          data-testid="sorokeep-degraded-explanation"
          className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="font-semibold">
            Live Sorokeep Telemetry Currently Unreachable
          </p>
          <p className="mt-1 text-xs leading-relaxed">
            Real-time TTL health and live guard status require direct reachability
            to the Sorokeep source and have been hidden below so partial figures
            are never mistaken for complete live metrics. Stored alert history
            and indexed on-chain admin actions remain available from the local
            database cache.
          </p>
          {sorokeepStatus.reason && (
            <p
              data-testid="sorokeep-unavailable-reason"
              className="mt-1 font-mono text-xs text-amber-900"
            >
              Reason: {sorokeepStatus.reason}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section
          aria-labelledby="live-ttl-heading"
          data-testid="operations-live-ttl-section"
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2
              id="live-ttl-heading"
              className="text-base font-semibold text-slate-900"
            >
              Entry TTL Health
            </h2>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
              Source: Live Sorokeep
            </span>
          </div>

          {isLiveAvailable ? (
            ttlHealthSlot ?? (
              <p className="text-sm text-slate-500">
                No monitored entries reported.
              </p>
            )
          ) : (
            <div
              data-testid="ttl-health-unavailable"
              className="rounded border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-700"
            >
              <p className="font-medium text-slate-900">
                Live TTL Health Unavailable
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Live per-entry TTL measurements cannot be fetched while the
                Sorokeep telemetry source is unreachable. Partial or cached TTL
                figures are intentionally omitted.
              </p>
            </div>
          )}
        </section>

        <section
          aria-labelledby="live-guard-heading"
          data-testid="operations-live-guard-section"
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2
              id="live-guard-heading"
              className="text-base font-semibold text-slate-900"
            >
              Guard Policy &amp; Auto-Extension
            </h2>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
              Source: Live Sorokeep
            </span>
          </div>

          {isLiveAvailable ? (
            guardStatusSlot ?? (
              <p className="text-sm text-slate-500">
                No guard policy configured.
              </p>
            )
          ) : (
            <div
              data-testid="guard-status-unavailable"
              className="rounded border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-700"
            >
              <p className="font-medium text-slate-900">
                Live Guard Status Unavailable
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Active guard thresholds and live extension counters are
                unavailable until the Sorokeep source reconnects.
              </p>
            </div>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section
          aria-labelledby="stored-alerts-heading"
          data-testid="operations-stored-alerts-section"
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2
              id="stored-alerts-heading"
              className="text-base font-semibold text-slate-900"
            >
              Sorokeep Alert Timeline
            </h2>
            <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
              Source: Stored Webhook History
            </span>
          </div>
          <div data-testid="stored-alerts-content">
            {alertTimelineSlot ?? (
              <p className="text-sm text-slate-500">
                No alerts have fired in stored history.
              </p>
            )}
          </div>
        </section>

        <section
          aria-labelledby="stored-admin-heading"
          data-testid="operations-stored-admin-section"
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2
              id="stored-admin-heading"
              className="text-base font-semibold text-slate-900"
            >
              Admin Action History
            </h2>
            <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
              Source: Stored Contract Events
            </span>
          </div>
          <div data-testid="stored-admin-content">
            {adminActivitySlot ?? (
              <p className="text-sm text-slate-500">
                No admin actions have occurred in stored history.
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

export default OperationsLayout;
