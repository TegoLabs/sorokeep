# Lumens Vault - Mainnet Deployment Runbook

> **STATUS: NOT YET EXECUTED**
> This runbook defines the gated, standalone procedure for deploying the Lumens Vault Soroban contract to Stellar Mainnet (`Public Global Stellar Network ; September 2015`). It has **not** been executed against mainnet.

---

## Why Mainnet Is a Separate, Gated Procedure

Mainnet deployment is intentionally **not** exposed as a `--network mainnet` flag on `lumens-vault/scripts/deploy.ps1`. Keeping mainnet as a separate, manual, sign-off-gated procedure prevents an accidental mainnet deployment caused by a mistyped CLI flag or environment variable, and forces the pre-mainnet security checklist to be completed and countersigned before any transaction is broadcast.

---

## Critical Operational Warning: No Emergency Withdrawal Path

> **IMPORTANT (NFR-1 / FR-8):** The Lumens Vault contract has **no emergency withdrawal function** (`emergency_withdraw` does not exist by design so that admin keys can never sweep or confiscate user principal).
>
> Consequently, **if a contract bug is discovered after user funds arrive on mainnet, locked funds cannot be rescued by an admin unlock or sweep.** The **only** operational lever available to responders is:
> 1. Immediately invoke `pause(admin)` to halt new `deposit` and `withdraw` operations.
> 2. Prepare, review, and rehearse a patched WASM binary on testnet.
> 3. Execute `upgrade(admin, new_wasm_hash)` under the multisig admin policy, followed by `unpause(admin)`.

---

## Section 1 - Hard Gate: Pre-Mainnet Checklist (from E04-14)

Deployment **must not proceed** past this section until every item in [`lumens-vault/docs/pre-mainnet-checklist.md`](./pre-mainnet-checklist.md) has been satisfied and signed off by a named reviewer.

| # | Gate Item | Reference | Pass Condition | Named Sign-Off | Date (UTC) | Evidence / Link |
| - | --------- | --------- | -------------- | -------------- | ---------- | --------------- |
| 1 | Live testnet upgrade dry-run with two independent deployments | `#817` / `#858` | Two independent testnet deployments upgraded to v2 with identical post-upgrade on-chain state | _Pending_ | _Pending_ | _Pending_ |
| 2 | Production admin account with verified medium threshold | `#818` / [admin-setup.md](./admin-setup.md) | Mainnet G-account configured as N-of-M multisig, `master_weight = 0`, `med_threshold = N`, `high_threshold = N` verified on-chain | _Pending_ | _Pending_ | _Pending_ |
| 3 | Event topic counts verified against a real emission | `#819` | Every contract event (`deposit`, `withdraw`, `paused`, `unpaused`, `asset_add`, `asset_rm`, `cfg_upd`, `adm_xfer`, `upgraded`) verified on-chain to match documented topic counts and stay within the 4-topic ceiling | _Pending_ | _Pending_ | _Pending_ |
| 4 | Sorokeep monitoring flags & alert sinks verified live | [observability.md](../../docs/observability.md) | Sorokeep watcher connected to live RPC, contract rules loaded, and alert delivery verified end-to-end | _Pending_ | _Pending_ | _Pending_ |
| 5 | Independent security review completed | [pre-mainnet-checklist.md](./pre-mainnet-checklist.md) | Independent security review finalized with all Critical/High findings resolved or explicitly accepted in writing | _Pending_ | _Pending_ | _Pending_ |

---

## Section 2 - Authorization & Roles

### Who Is Authorized to Execute This Runbook

- **Release Coordinator (Deployer):** Must be a designated Lumens Vault core maintainer holding hardware-backed deployer credentials for WASM upload/instantiation.
- **Admin Multisig Signers (N-of-M):** At least **N** distinct authorized keyholders from the production admin signer set must be online simultaneously to countersign the admin verification, initial asset whitelist, and Sorokeep registration.
- **Incident Observer:** A second maintainer verifying CLI outputs, WASM SHA-256 digests, and Horizon/RPC read-backs in real time.

---

## Section 3 - Mandatory Pre-Deploy Verification: Admin Account Medium Threshold

As documented in [`admin-setup.md`](./admin-setup.md), Soroban `require_auth()` (`__check_auth()`) on a classic Stellar G-account evaluates the account's **medium** threshold (`med_threshold`), **not** its high threshold.

Before uploading or deploying the contract, query the production admin account on mainnet and paste the exact output below:

```powershell
$MAINNET_ADMIN_PUBLIC_KEY = "G..." # Replace with production multisig G-address
stellar account show --network mainnet --public-key $MAINNET_ADMIN_PUBLIC_KEY
```

### Required Pasted Verification Output (Hard Gate)

```text
# PASTE OUTPUT OF `stellar account show --network mainnet --public-key $MAINNET_ADMIN_PUBLIC_KEY` HERE BEFORE PROCEEDING:
#
# Status: [NOT YET EXECUTED]
# Signers:
#   <PENDING>
# Thresholds:
#   low: <PENDING>, medium: <PENDING>, high: <PENDING>
# Master weight:
#   <PENDING - MUST BE 0>
```

**Stop Criteria:** Do **not** proceed if:
1. `Master weight` is non-zero.
2. `medium` threshold is less than the required N-of-M policy (`>= 2`).
3. `high` threshold is less than the `medium` threshold.
4. Any listed signer public key does not match the hardware keys held by the active signer ceremony participants.

Deployer Sign-Off: `____________________`  Countersigner Sign-Off: `____________________`

---

## Section 4 - Mainnet Deployment Steps

### 4.1 Verify Deterministic Release WASM Digest

```powershell
Push-Location lumens-vault/contracts/lumens-vault
stellar contract build
$wasmPath = "target/wasm32v1-none/release/lumens_vault.wasm"
Get-FileHash -Path $wasmPath -Algorithm SHA256
Pop-Location
```

Confirm the SHA-256 hash matches the hash from the signed release tag and the `#858` testnet rehearsal.

### 4.2 Install WASM and Instantiate Contract on Mainnet

```powershell
$MAINNET_RPC_URL = "https://mainnet.sorobanrpc.com" # Or dedicated production RPC endpoint
$MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015"
$MIN_LOCK_LEDGERS = 17280   # ~24 hours at 5s/ledger
$MAX_LOCK_LEDGERS = 6307200 # ~1 year at 5s/ledger

$CONTRACT_ID = stellar contract deploy `
  --wasm lumens-vault/contracts/lumens-vault/target/wasm32v1-none/release/lumens_vault.wasm `
  --rpc-url $MAINNET_RPC_URL `
  --network-passphrase $MAINNET_PASSPHRASE `
  --source-account $DEPLOYER_IDENTITY `
  -- `
  --admin $MAINNET_ADMIN_PUBLIC_KEY `
  --min_lock_ledgers $MIN_LOCK_LEDGERS `
  --max_lock_ledgers $MAX_LOCK_LEDGERS

Write-Host "Deployed Mainnet Contract ID: $CONTRACT_ID"
```

---

## Section 5 - Immediate Post-Deployment Verification Checks

Immediately after `stellar contract deploy` returns `$CONTRACT_ID`, the Release Coordinator and Incident Observer must verify all four read-backs before whitelisting any asset or announcing the contract address:

1. **Verify `get_admin()` matches `$MAINNET_ADMIN_PUBLIC_KEY`:**
   ```powershell
   stellar contract invoke --id $CONTRACT_ID --rpc-url $MAINNET_RPC_URL --network-passphrase $MAINNET_PASSPHRASE --source-account $DEPLOYER_IDENTITY -- get_admin
   ```
2. **Verify `get_lock_bounds()` matches `($MIN_LOCK_LEDGERS, $MAX_LOCK_LEDGERS)`:**
   ```powershell
   stellar contract invoke --id $CONTRACT_ID --rpc-url $MAINNET_RPC_URL --network-passphrase $MAINNET_PASSPHRASE --source-account $DEPLOYER_IDENTITY -- get_lock_bounds
   ```
3. **Verify `is_paused()` returns `false` (or `true` if deploying in a paused state prior to asset whitelisting):**
   ```powershell
   stellar contract invoke --id $CONTRACT_ID --rpc-url $MAINNET_RPC_URL --network-passphrase $MAINNET_PASSPHRASE --source-account $DEPLOYER_IDENTITY -- is_paused
   ```
4. **Verify Instance Storage TTL and Sorokeep Watcher Attachment:**
   - Confirm the contract instance ledger entry is live and its TTL meets the minimum archival threshold.
   - Register `$CONTRACT_ID` in the production Sorokeep monitoring configuration and trigger a test heartbeat check.

---

## Execution Log

- **Execution Status:** `NOT YET EXECUTED`
- **Mainnet Contract ID:** `N/A (Not Deployed)`
- **Executed By:** `N/A`
- **Execution Timestamp (UTC):** `N/A`