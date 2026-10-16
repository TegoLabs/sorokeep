import React from "react";

export type StellarNetworkName = "testnet" | "mainnet" | "futurenet" | string;

export interface LockBoundsInfo {
  minLockLedgers: number;
  maxLockLedgers: number;
}

export interface PauseStateInfo {
  paused: boolean;
  changedAtLedger?: number | null;
}

export interface ContractInfoProps {
  /** Contract ID reported by the backend API */
  backendContractId: string;
  /** Contract ID configured in the frontend environment (NEXT_PUBLIC_CONTRACT_ID) */
  frontendContractId?: string;
  /** Active Stellar network (e.g., "testnet" or "mainnet") */
  network: StellarNetworkName;
  /** Current admin address of the contract */
  admin: string;
  /** Current minimum and maximum lock bounds in ledgers */
  lockBounds: LockBoundsInfo;
  /** Current pause state and the ledger at which it last changed */
  pauseState: PauseStateInfo;
  /** Running contract version returned by version(), if available */
  version?: string | number | null;
}

/**
 * Resolves the Stellar Expert block explorer URL for a contract ID on the given network.
 */
export function getContractExplorerUrl(
  contractId: string,
  network: StellarNetworkName,
): string {
  const normalized = network.toLowerCase().trim();
  const segment =
    normalized === "mainnet" || normalized === "public" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${segment}/contract/${encodeURIComponent(contractId)}`;
}

/**
 * Operations page panel displaying the live contract deployment metadata:
 * - Contract ID with a network-aware block explorer link
 * - Network, current admin, and lock bounds
 * - Paused status along with the ledger at which it changed
 * - Prominent mismatch warning when frontend and backend contract IDs diverge
 * - Running contract version from `version()` when available
 */
export function ContractInfo({
  backendContractId,
  frontendContractId,
  network,
  admin,
  lockBounds,
  pauseState,
  version,
}: ContractInfoProps) {
  const configuredFrontendId =
    frontendContractId ?? process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
  const hasMismatch =
    Boolean(configuredFrontendId) &&
    Boolean(backendContractId) &&
    configuredFrontendId.trim() !== backendContractId.trim();

  const explorerUrl = getContractExplorerUrl(backendContractId, network);

  return (
    <section
      aria-labelledby="contract-info-heading"
      data-testid="contract-info-panel"
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <h2
          id="contract-info-heading"
          className="text-base font-semibold text-slate-900"
        >
          Contract Information
        </h2>
        <span
          data-testid="contract-network-badge"
          className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-slate-800"
        >
          {network}
        </span>
      </div>

      {hasMismatch && (
        <div
          role="alert"
          data-testid="contract-mismatch-warning"
          className="mt-3 rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950"
        >
          <p className="font-semibold">
            Configuration Mismatch Detected: Frontend and Backend Contract IDs
            Differ
          </p>
          <p className="mt-1 text-xs">
            The frontend is configured for{" "}
            <code className="font-mono font-semibold">
              {configuredFrontendId}
            </code>
            , while the backend is indexing{" "}
            <code className="font-mono font-semibold">{backendContractId}</code>
            . Verify both deployments point to the same contract before trusting
            displayed balances.
          </p>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Contract ID
          </dt>
          <dd className="mt-1 font-mono text-xs break-all text-slate-900">
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="contract-explorer-link"
              className="underline decoration-slate-400 hover:text-blue-700"
            >
              {backendContractId}
            </a>
          </dd>
        </div>

        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Current Admin
          </dt>
          <dd
            data-testid="contract-admin"
            className="mt-1 font-mono text-xs break-all text-slate-900"
          >
            {admin}
          </dd>
        </div>

        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Lock Bounds (Ledgers)
          </dt>
          <dd
            data-testid="contract-lock-bounds"
            className="mt-1 font-mono text-xs text-slate-900"
          >
            {lockBounds.minLockLedgers.toLocaleString("en-US")} –{" "}
            {lockBounds.maxLockLedgers.toLocaleString("en-US")} ledgers
          </dd>
        </div>

        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Pause State
          </dt>
          <dd data-testid="contract-pause-state" className="mt-1 text-slate-900">
            <span
              className={
                pauseState.paused
                  ? "font-semibold text-red-700"
                  : "font-medium text-emerald-700"
              }
            >
              {pauseState.paused ? "Paused" : "Active (Unpaused)"}
            </span>
            {pauseState.changedAtLedger != null && (
              <span
                data-testid="contract-pause-ledger"
                className="ml-2 text-xs text-slate-600"
              >
                (since ledger #{pauseState.changedAtLedger})
              </span>
            )}
          </dd>
        </div>

        {version !== undefined && version !== null && String(version) !== "" && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Contract Version
            </dt>
            <dd
              data-testid="contract-version"
              className="mt-1 font-mono text-xs text-slate-900"
            >
              v{String(version).replace(/^v/i, "")}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

export default ContractInfo;
