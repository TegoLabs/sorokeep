# Lumens Vault — Technical Specification

**Status:** DRAFT — first consolidated pass, pending your review before we
move to architecture-pattern research. Every requirement below is tagged:

- **DECIDED** — settled, with the reasoning; change it deliberately, not by drift.
- **VERIFIED** — decided AND independently confirmed against a primary source (not secondhand docs, not memory).
- **OPEN** — a real decision that hasn't been made yet. Do not build against these silently.

This document describes *what* the system must do. `SYSTEM_DESIGN.md`
describes *how* the pieces are arranged.

---

## 1. Product Summary

A time-locked, multi-asset savings vault on Stellar Soroban. Users deposit
a whitelisted asset, choose a lock period within admin-set bounds, and
cannot withdraw until it expires. No yield, no fees in v1, no emergency
unlock. Built to be genuinely usable, and deliberately structured so its
storage profile (many persistent entries, one per vault) is a real showcase
for Sorokeep's lifecycle monitoring — not a toy built to make a demo look
good.

---

## 2. Functional Requirements

### 2.1 Vault Core

- **FR-1 (DECIDED).** Users may deposit any admin-whitelisted asset.
- **FR-2 (DECIDED, in progress).** Users select a lock period per deposit,
  within admin-configured `[min_lock_ledgers, max_lock_ledgers]` bounds.
  This restores the original design after it was lost during an earlier
  implementation pass; see epic E02 in the issue backlog.
  **Decided model, recorded here so it does not have to be derived from
  code (sub-questions DECIDED 2026-09-28):**
  - `lock_ledgers` is *always* required on `deposit` — there is no
    default-fallback path.
  - Bounds are *global* across all whitelisted assets, not per-asset. The
    single `default_timelock_ledgers` config field is replaced by
    `min_lock_ledgers` and `max_lock_ledgers`.
  - The range is inclusive at both ends: a deposit with
    `lock_ledgers == min_lock_ledgers` or `lock_ledgers == max_lock_ledgers`
    is accepted. A period outside the range is rejected with
    `Error::InvalidLockPeriod = 8` (appended after the existing variants;
    existing error codes keep their numbers).
  - Changing the bounds never affects vaults that already exist: their
    `unlock_ledger` was fixed at deposit time, so a bounds change is
    forward-looking only.
  **Status (2026-09-29):** this is the specified model, not yet shipped.
  The contract still carries the single `default_timelock_ledgers` field
  (`storage.rs`, `contract.rs`); `Error::InvalidLockPeriod` does not exist
  yet. E02-02 through E02-12 must land, with the boundary tests, before
  this tag may move to VERIFIED — until then, do not cite FR-2 as
  describing deployed behavior.
- **FR-3 (DECIDED).** Withdrawal is single-step (deposit → wait → withdraw),
  not the two-step initiate/claim pattern considered earlier. Partial
  withdrawal is supported — a user may withdraw less than a vault's full
  balance, leaving the remainder locked under the same terms.
- **FR-4 (DECIDED).** A user may hold multiple vaults, including multiple
  vaults of the same asset with different lock periods. Vault IDs
  auto-increment per user.
- **FR-5 (DECIDED).** No emergency withdrawal bypass. A lock is a real
  commitment. The only relief valve is the admin's `pause()`, which halts
  *new* deposits and withdrawals — it never unlocks existing funds early.
- **FR-6 (DECIDED).** No protocol fees in v1.
- **FR-7 (VERIFIED).** `amount` must be strictly positive on both deposit
  and withdraw. (Found and fixed: a negative `amount` on withdraw could
  inflate a caller's recorded balance rather than debit it, since the
  vault cannot assume every whitelisted token's own `transfer` rejects
  negative amounts.)

### 2.2 Admin & Governance

- **FR-8 (DECIDED, with a verified caveat that changes how it must be set
  up).** A single `admin` address in contract storage. In production this
  is intended to be a Stellar-native multisig account — the contract
  itself has no multisig logic; it just requires `admin.require_auth()`.
  **The caveat:** when `admin` is a classic Stellar account (G-address)
  configured with multiple signers, `require_auth()` checks that account's
  **medium threshold specifically** — not high, not "whatever multisig you
  set up in general." Stellar accounts have three separate threshold
  levels gating different operation categories. If the medium threshold
  isn't deliberately set to match the intended signer policy, this
  contract's `admin.require_auth()` could pass with far fewer signatures
  than the team believes it requires — a real, quiet way for a "multisig
  admin" to actually be a 1-of-N in practice. Whoever configures the
  production admin account must explicitly verify the medium threshold,
  not just add signers and assume it's covered.
  **OPEN, related:** there is a second, legitimate path — a Soroban smart
  contract account (a C-address implementing its own `__check_auth`,
  the pattern OpenZeppelin's Stellar contracts and similar projects use)
  instead of a classic multisig G-account. It's more flexible but
  Stellar's own docs explicitly flag it as needing "rigorous testing and
  review," with client-side simulation support still maturing. Classic
  G-account multisig (with the medium-threshold caveat above handled
  correctly) is the safer default for this project's current scale;
  revisit only if a concrete need for custom authorization policy arises.
- **FR-9 (VERIFIED).** Initialization is atomic with deployment via
  Soroban's `__constructor` mechanism. (Found and fixed: the original
  `initialize()` function had no auth check and was callable by anyone as
  a separate transaction after deploy — a real front-running vulnerability,
  not a theoretical one; confirmed as a known pattern across multiple
  independent Soroban projects.)
- **FR-10 (DECIDED).** Admin can `pause()`/`unpause()` the contract,
  halting/resuming new deposits and withdrawals.
- **FR-11 (VERIFIED).** Admin can whitelist/delist assets. Delisting must
  never block withdrawal of funds deposited while the asset was still
  whitelisted — the vault must reject *new* deposits of a delisted asset
  but always allow withdrawal of existing balances. (Found and fixed: this
  was backwards in an earlier version, which would have permanently
  trapped funds on delisting.)
- **FR-12 (DECIDED).** Admin can `transfer_admin` to a new address.
- **FR-13 (DECIDED).** Admin can `update_config` to change the lock-period
  bounds (FR-2) without a full contract upgrade.
- **FR-14 (VERIFIED).** The contract supports native WASM upgrade
  (`upgrade()`, admin-gated), with all persisted structs wrapped in
  versioned enums (`VaultEntry::V1(...)`, etc.) so a future version can add
  variants without breaking deserialization of existing data. Verified
  with a real two-binary upgrade test — not just a same-binary storage
  round-trip, which is what every earlier version of this test actually
  proved (see `SYSTEM_DESIGN.md` for why that distinction matters).

### 2.3 Lifecycle Safety & Observability (Sorokeep Integration)

- **FR-15 (DECIDED).** The deployed contract is registered with the real
  Sorokeep tool (`github.com/TegoLabs/sorokeep`, installed as an npm
  dependency where the app needs its exported functions) for TTL
  monitoring and guard-based auto-extension of instance storage, the WASM
  entry, and — ideally — individual per-user `Vault(...)` entries.
  **OPEN:** exact CLI flags for guard policies and storage-key tracking
  need verification against Sorokeep's current `--help` output at
  implementation time, not assumed from its README.
- **FR-16 (DECIDED).** Sorokeep's alert webhooks are received, signature-
  verified (`verifyWebhookSignature`), and stored for display. Sorokeep is
  the source of truth for TTL/lifecycle health — this project does not
  reimplement TTL polling or auto-extension anywhere else.

### 2.4 Application Data

- **FR-17 (DECIDED).** Because the contract has no native way to enumerate
  a user's vaults (see NFR-6), an application-level component
  reconstructs per-user vault lists and balances by reading contract
  events (`DepositEvent`, `WithdrawEvent`, etc.).
- **FR-18 (DECIDED).** The same (or an adjacent) component detects and
  surfaces admin actions — `pause`/`unpause`/`upgrade`/`whitelist`/
  `delist`/`transfer_admin` — since Sorokeep has no concept of
  application-level events, only storage TTL health. This is the *only*
  place these actions are monitored.
- **FR-19 (DECIDED).** USD valuation for dashboard display uses the
  Reflector oracle (Stellar's actual production price oracle, SEP-40
  interface — verified against Stellar's own developer docs, not assumed).
  Reads are simulation-only (no signing, no transaction fees). Includes a
  staleness guard and a deviation guard — not optional additions, standard
  practice in every real Reflector integration found during verification.
  **DECIDED, important:** this lives entirely off-chain. Nothing in the
  vault's on-chain logic depends on price, so the oracle is never called
  from the Soroban contract itself.

### 2.5 Frontend

- **FR-20 (DECIDED).** Freighter wallet connection for transaction signing.
- **FR-21 (DECIDED).** Deposit flow includes the lock-period picker (FR-2),
  reading live min/max bounds from the contract rather than hardcoding them.
- **FR-22 (DECIDED).** A "my vaults" view backed by FR-17.
- **FR-23 (DECIDED).** An operations/health page showing real Sorokeep
  data (FR-15/16) — this is a genuine showcase page, not a mockup.
- **FR-24 (DECIDED, process requirement).** No frontend implementation
  begins before wireframes/mockups exist and are explicitly approved. This
  rule already existed once and was broken twice (a Next.js scaffold and a
  set of mockups were both generated without sign-off earlier in this
  project's history) — restated here as a hard gate, not a suggestion.

---

## 3. Non-Functional Requirements

- **NFR-1 (Security).** No known critical vulnerability may exist before
  any mainnet deployment. Closed so far: unauthenticated initializer
  (FR-9), unchecked deposit/withdraw amounts (FR-7), a persistent counter
  (`UserVaultCount`) that was never having its TTL extended and would have
  silently locked active users out of future deposits. Open: the upgrade
  path has been proven mechanically (FR-14) but not yet dry-run on a live
  testnet deployment with two genuinely independent deployments.
- **NFR-2 (Testability).** Every variant of the contract's `Error` enum
  must be exercised by at least one test that actually triggers it, not
  just declared.
- **NFR-3 (Event schema limits).** All contract events must stay within
  Soroban's practical topic limit (treated as a hard 4-topic ceiling,
  confirmed via dedicated static-analysis tooling built specifically to
  catch violations of it, even though the SDK's type system doesn't
  enforce this itself). High-cardinality fields (`vault_id`, `amount`) go
  in event data, not topics.
- **NFR-4 (Dashboard availability).** The application-data layer (FR-17,
  FR-18, FR-19) is a best-effort cache serving UI display, not a source of
  truth for fund safety. If it's down or wrong, the worst outcome is a
  stale number on screen — actual withdraw eligibility is always
  determined by a live on-chain check, never by this layer. This
  deliberately bounds how much reliability engineering this layer needs.
- **NFR-5 (Storage cost discipline).** Contract functions extend the TTL
  only of the specific entries they touch. Sorokeep's guard is the
  backstop for entries nobody is actively interacting with (e.g. a
  long-dormant vault) — the contract does not attempt to solve that
  problem itself by extending TTLs speculatively.
- **NFR-6 (No on-chain enumeration).** The contract intentionally exposes
  point lookups (`get_vault(user, asset, id)`) rather than any
  "list everything" function — Soroban has no native collection-scan
  primitive that's both safe and cheap at scale, so enumeration is an
  application-layer concern (FR-17), not a contract concern.
- **NFR-7 (Decision hygiene).** Every architectural or scope decision
  gets recorded with its status (Decided / Verified / Open) and, where a
  factual claim underlies it, its source. This document and
  `SYSTEM_DESIGN.md` are the enforcement mechanism for that.

---

## 4. Explicit Non-Goals (v1)

- No yield, staking, or interest of any kind.
- No emergency withdrawal / lock bypass.
- No protocol fees.
- No on-chain price awareness anywhere in the Soroban contract.
- No multi-oracle aggregation — Reflector alone.
- No PagerDuty/Postgres/audit-log-grade infrastructure for the application-
  data layer — it's a display cache, sized accordingly (see NFR-4).
- No in-contract multisig implementation — that's an account-level
  protocol concern (FR-8), not contract code.

---

## 5. Open Questions Requiring a Decision Before Implementation

1. ~~Does `deposit` require an explicit `lock_ledgers` on every call, or is
   there a "default" fallback path?~~ **DECIDED 2026-09-28:** always
   required, no fallback. See FR-2.
2. ~~Are lock-period bounds global across all whitelisted assets, or
   per-asset?~~ **DECIDED 2026-09-28:** global. The case for per-asset
   bounds (a volatile asset and a stablecoin plausibly want different
   minimums) is real but not yet worth the config complexity; recorded in
   an ADR under epic E02 along with what would justify revisiting it.
3. Exact Sorokeep CLI surface for guard policies and per-entry storage-key
   tracking (FR-15) — needs a live check, not a README read.
4. Admin account model: classic multisig G-account (with medium threshold
   deliberately configured — see FR-8) vs. a Soroban smart contract
   account. Default assumption is the former; not yet formally decided.
5. Event-ingestion retention assumption for FR-17/18: Stellar's own docs
   state the network can support querying up to 7 days back via
   `getEvents`, but public RPC nodes retain only 24 hours by default.
   Design the ingestion cadence and outage-recovery behavior against
   whichever RPC provider is actually used, verified directly — not
   against either number in isolation.
6. ~~One component or several?~~ **DECIDED:** one `backend/` modular
   monolith with hexagonal internals. See `SYSTEM_DESIGN.md` §3.
