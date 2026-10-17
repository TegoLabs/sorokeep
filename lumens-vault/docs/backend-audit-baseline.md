# Backend Dependency Audit Baseline (`E06-16`)

This document records the dependency audit policy, severity threshold, and baseline advisory judgements for `lumens-vault/backend`, enforced by `.github/workflows/lumens-vault-backend.yml`.

## Policy & Severity Threshold

- **Production dependency gate (`npm audit --omit=dev`):**
  - Any `critical` advisory or any **unreviewed `high` advisory** in production dependencies (`dependencies`) fails the CI job immediately.
  - Known upstream advisories without an available upstream release are explicitly recorded in the baseline table below with a concrete reachability and risk judgement rather than quietly raising the severity threshold to ignore all `high` findings.
- **Dev-only dependencies (`devDependencies`):**
  - Dev-only advisories are audited in a separate CI step (`npm audit --audit-level=high || true`) and do not block production builds because test-runner packages (`vitest`, `@vitest/mocker`, `tinypool`) are excluded from production installs (`--omit=dev`) and only execute trusted repository test files in local development and CI.

## Current Baseline Advisories

### 1. Production Dependencies (`npm audit --omit=dev`)

| Package | Path | Advisory | Severity | Fix Available? | Judgement |
|---|---|---|---|---|---|
| `axios` (`1.0.0 - 1.19.0`) | `sorokeep > @stellar/stellar-sdk > axios` | `GHSA-vh66-26gq-q6x8`, `GHSA-9fr6-4gfg-395g`, `GHSA-c29m-xwm3-cm6r`, `GHSA-mghh-pgcx-3jjj`, `GHSA-x97p-jq2g-jp4f`, `GHSA-3pq3-5fj3-cg6v`, `GHSA-542g-h47m-68v8`, `GHSA-j8rh-479h-cp32`, `GHSA-4hqw-qxg8-jxx2`, `GHSA-m8m8-qj5v-23w3`, `GHSA-44g4-m2mj-wpvx`, `GHSA-r4gj-5m52-g5wh` | `high` | Yes (via `overrides`) | **Resolved via `"overrides": { "axios": "1.20.0" }`** in `lumens-vault/backend/package.json` (matching the parent `sorokeep` repository's override). |
| `toml` (`<=4.1.2`) | `@stellar/stellar-sdk > toml` | `GHSA-82x6-q7mm-w9cf` (Uncontrolled Recursion), `GHSA-v5mp-jgw5-2x6j` (Prototype Pollution via `__proto__`) | `high` | No upstream fix | **Accepted / Unreachable in production:** `toml` is pulled in transitively by `@stellar/stellar-sdk` solely for `StellarToml.Resolver` (SEP-0001 `stellar.toml` domain lookup). `lumens-vault-backend` never calls `StellarToml.Resolver` or parses any TOML input; it only invokes Soroban JSON-RPC methods (`getEvents`, `getHealth`, `simulateTransaction`) and `verifyWebhookSignature`. |

### 2. Development-Only Dependencies (`devDependencies`)

| Package | Path | Advisory | Severity | Judgement |
|---|---|---|---|---|
| `@vitest/mocker` (`2.1.0 - 4.1.10`) | `vitest > @vitest/mocker` | `GHSA-82fw-gwwq-j7x9` | `moderate` | **Dev-only (not shipped in production):** Only loaded by the Vitest test runner during `npm test`. No untrusted code or external user input is passed to module mocking. |
| `tinypool` (`<=2.1.1`) | `vitest > tinypool` | `GHSA-5gmw-xhrv-c9v3`, `GHSA-85c8-ppgw-ccpr` | `critical` | **Dev-only (not shipped in production):** Worker pool used internally by `vitest@3.x` (pinned to match `sorokeep` per `SCAFFOLD_BRIEF.md`). Worker options are never populated from external input. |
