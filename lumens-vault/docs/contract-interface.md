# lumens-vault contract interface

The wasm's exported function list is the real interface every client binds to.
This document records it once, with the build it came from, so the frontend and
backend have an authoritative reference and any accidental removal shows up in a
later diff.

> **Provenance — read this first.** This reference is generated from a real
> optimized wasm built from the FR-2 lock-period implementation (epic E02). **That
> implementation is not merged to `main` yet**, so this document describes the
> post-E02 interface, not the interface currently on `main`. The build's source
> commit is recorded below so the claim can be checked.

| | |
|---|---|
| Wasm sha256 | `d240cfb0e9eecb6de9441200aa02f9ca5f473c10ebd82c8b184285479a9d889c` |
| Wasm size | 10,087 bytes optimized (12,026 bytes unoptimized) |
| Exported functions | 17 |
| Source commit | `83be447950251938ae6c35e5864e901495b4e88a` — "feat: implement FR-2 lock periods & configuration (E02)", the head of PR #1084; **not on `main`** |
| Build command | `stellar contract build`, run in `lumens-vault/contracts/lumens-vault` |
| Toolchain | `rustc 1.98.1 (48a229cea 2026-09-01)`, `cargo 1.98.1 (797e8a9bc 2026-08-05)`, `stellar-cli 28.1.0 (c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd)` |
| soroban-sdk | 28.0.0 (from `Cargo.toml` / `Cargo.lock`) |
| Date | 2026-09-29 |

## Staleness

This document is accurate **only** for the wasm hash above. Any of the following
makes it stale, and it must be regenerated in the same PR that causes it:

- the E02 lock-period work merges to `main` in a different form (the merged wasm
  will have a different hash — regenerate and replace the hash, size and commit);
- a later E02 issue changes the surface (see *Not present in this build* below);
- any change to `contract.rs`, `storage.rs` or `events.rs` that alters an
  exported signature, an error code, an event shape or a persisted shape.

To check, rebuild and compare:

```powershell
cd contracts\lumens-vault
stellar contract build
stellar contract info hash --wasm target\wasm32v1-none\release\lumens_vault.wasm
```

A different hash than the one above means this document no longer describes the
current code. This is also the hook the deployment check in a later issue uses:
the deployed hash must match the reviewed hash here.

## Build output

Verbatim `stellar contract build` output for the build above:

```
    Finished `release` profile [optimized] target(s) in 1m 07s
ℹ️  Build Summary:
    Wasm File: target/wasm32v1-none/release/lumens_vault.wasm (10087 bytes optimized (original size was 12026 bytes))
    Wasm Hash: d240cfb0e9eecb6de9441200aa02f9ca5f473c10ebd82c8b184285479a9d889c
    Wasm Size: 10087 bytes optimized (original size was 12026 bytes)
    Exported Functions: 17 found
      • __constructor
      • add_asset
      • deposit
      • get_admin_address
      • get_lock_bounds
      • get_user_vault_count
      • get_vault
      • is_paused
      • is_whitelisted
      • pause
      • remove_asset
      • transfer_admin
      • unpause
      • update_config
      • upgrade
      • version
      • withdraw
✅ Build Complete
```

For reference, the pre-E02 interface documented in `README.md` had 16 exported
functions and a wasm around 11.4 KB; this build has 17 functions (`get_lock_bounds`
is new) and a smaller optimized artifact.

## Which E02 changes this build contains

Present:

- `__constructor` takes `min_lock_ledgers` and `max_lock_ledgers` (E02-03) and
  validates them.
- `VaultConfigV1` holds `min_lock_ledgers` / `max_lock_ledgers`; `default_timelock_ledgers`
  no longer exists (E02-02).
- `deposit` takes a caller-supplied `lock_ledgers` (E02-10, E02-11).
- `Error::InvalidLockPeriod = 8`, returned by `deposit` and `update_config` (E02-05).
- `update_config` takes and validates bounds (E02-08).
- `get_lock_bounds` exists (E02-10).

**Not present in this build** — later E02 work that will change the surface again:

- E02-09 `ConfigUpdatedEvent`, emitted by `update_config`. In this build
  `update_config` emits nothing, so a client cannot observe a bounds change from
  events alone.
- E02-07 checked arithmetic for the per-user vault-id counter. In this build
  `deposit` computes `current_count + 1`; the release profile sets
  `overflow-checks = true`, so overflow traps rather than wrapping.
- Any error variant beyond `InvalidLockPeriod = 8`.

## Conventions

- All fallible functions return `Result<T, Error>`. `Error` is the
  `#[contracterror]` enum below; its codes are append-only and never renumbered.
- "Auth" is the address that must authorize the call via `require_auth()`.
- The contract exposes point lookups only. There is no on-chain way to enumerate a
  user's vaults, so listing them is an off-chain, event-replay concern.
- Function argument names below are the names in the contract spec, which is what
  generated clients use.

## Functions

### Constructor

| Function | Arguments | Returns | Auth | Errors |
|---|---|---|---|---|
| `__constructor` | `admin: Address, min_lock_ledgers: u32, max_lock_ledgers: u32` | none (no `Result`) | `admin` | traps with `InvalidLockPeriod` (8) |

Runs atomically as part of deployment and cannot be called again. There is no
separate `initialize` entry point, and no successful path to calling this twice.

Validation happens inside but is **not** expressed in the return type: the spec
declares `__constructor` as infallible. It traps (`panic_with_error!`) with
`InvalidLockPeriod` if `min_lock_ledgers == 0` or `max_lock_ledgers < min_lock_ledgers`.
A client therefore sees a failed deployment rather than a decoded `Error` value,
and `min_lock_ledgers` must be non-zero.

### Admin

| Function | Arguments | Returns | Auth | Errors |
|---|---|---|---|---|
| `pause` | — | `()` | admin | NotInitialized |
| `unpause` | — | `()` | admin | NotInitialized |
| `add_asset` | `asset: Address` | `()` | admin | NotInitialized |
| `remove_asset` | `asset: Address` | `()` | admin | NotInitialized |
| `transfer_admin` | `new_admin: Address` | `()` | admin | NotInitialized |
| `update_config` | `min_lock_ledgers: u32, max_lock_ledgers: u32` | `()` | admin | NotInitialized, InvalidLockPeriod |
| `upgrade` | `new_wasm_hash: BytesN<32>` | `()` | admin | NotInitialized |

- `update_config` rejects `min_lock_ledgers == 0` and
  `max_lock_ledgers < min_lock_ledgers` with `InvalidLockPeriod`. Changing the
  bounds never affects vaults that already exist: each vault's `unlock_ledger` was
  fixed at deposit time.
- `update_config` does **not** emit an event in this build (see E02-09 above).
- `upgrade` swaps the current contract's executable to `new_wasm_hash`.

### Vault operations

| Function | Arguments | Returns | Auth | Errors |
|---|---|---|---|---|
| `deposit` | `from: Address, asset: Address, amount: i128, lock_ledgers: u32` | `u32` — assigned vault id | `from` | InvalidAmount, Paused, AssetNotWhitelisted, InvalidLockPeriod, NotInitialized |
| `withdraw` | `to: Address, asset: Address, vault_id: u32, amount: i128` | `()` | `to` | InvalidAmount, Paused, VaultNotFound, InsufficientBalance, TimelockNotExpired, NotInitialized |

Semantics the frontend and backend depend on:

- `deposit` evaluates in this order: `amount > 0`, not paused, asset whitelisted,
  token `transfer(from → contract)`, vault-id counter increment, then the
  `lock_ledgers` bounds check. Because a Soroban transaction is atomic, returning
  `InvalidLockPeriod` after the transfer rolls the whole call back — no tokens
  move on a rejected deposit. The check is documented in as-built order because the
  transfer sub-call happens before the rejection.
- The bounds check is inclusive at both ends: `lock_ledgers == min_lock_ledgers`
  and `lock_ledgers == max_lock_ledgers` are both accepted. `InvalidLockPeriod` is
  returned only when `lock_ledgers < min_lock_ledgers` or `lock_ledgers > max_lock_ledgers`.
- `unlock_ledger = current ledger sequence + lock_ledgers`, computed with
  `checked_add`. On overflow the call returns `InvalidLockPeriod`.
- Vault ids auto-increment per user and start at 1. `deposit` returns the new id.
- `withdraw` evaluates in this order: `amount > 0`, not paused, vault exists,
  `amount <= stored amount`, then `ledger sequence >= unlock_ledger`.
- A vault becomes withdrawable **at** `unlock_ledger`: the rejection condition is
  `sequence < unlock_ledger`, so `sequence == unlock_ledger` succeeds. The frontend
  must use the same boundary or it will show a vault as locked for one ledger after
  the contract would allow the withdrawal.
- `withdraw` does **not** check the whitelist. A delisted asset never traps funds
  that were deposited while it was valid.
- Partial withdrawal is allowed; the vault entry remains with a reduced `amount`
  and the same `unlock_ledger`.
- Token transfer failures surface as host traps from the token contract, not as
  `Error` variants.

### Views

| Function | Arguments | Returns | Auth | Errors |
|---|---|---|---|---|
| `version` | — | `u32` (currently `1`) | — | none |
| `get_vault` | `user: Address, asset: Address, vault_id: u32` | `VaultEntryV1` | — | VaultNotFound |
| `get_user_vault_count` | `user: Address` | `u32` (`0` if none) | — | none |
| `get_lock_bounds` | — | `(u32, u32)` — `(min, max)` | — | NotInitialized |
| `is_paused` | — | `bool` | — | NotInitialized |
| `is_whitelisted` | `asset: Address` | `bool` (`false` if never added) | — | none |
| `get_admin_address` | — | `Address` | — | NotInitialized |

- `get_lock_bounds` returns the stored `(min_lock_ledgers, max_lock_ledgers)`. It
  returns exactly the values a subsequent `deposit` validates against, so a client
  can read the live limits instead of hardcoding them (see the E02-10 test that
  asserts this).
- `version` is a compile-time constant (`VERSION = 1`). FR-2 did not change it; a
  future binary that changes logic should return 2.

## Types

Only one `contracttype` appears in the exported spec of this build, because it is
the only user-defined type an exported signature mentions:

```
VaultEntryV1 { amount: i128, unlock_ledger: u32 }
```

The other persisted types do **not** appear in the exported spec — no exported
function's signature names them — but they determine the on-chain storage layout
and are part of the de-facto interface:

```
DataKey::Admin
DataKey::State                       -> VaultState
DataKey::Config                      -> VaultConfig
DataKey::Vault(Address, Address, u32)-> VaultEntry        // (user, asset, vault_id)
DataKey::AssetWhitelist(Address)     -> bool
DataKey::UserVaultCount(Address)     -> u32

VaultConfig::V1(VaultConfigV1 { min_lock_ledgers: u32, max_lock_ledgers: u32 })
VaultEntry::V1(VaultEntryV1  { amount: i128, unlock_ledger: u32 })
VaultState::V1(VaultStateV1  { is_paused: bool })
```

`Admin`, `Config` and `State` live in instance storage; `Vault`,
`AssetWhitelist` and `UserVaultCount` live in persistent storage and are
TTL-extended to keep them alive. Anything that reads storage directly (an indexer,
a storage-diff tool) depends on these shapes, so treat them as part of the
interface even though the spec does not export them. See
[`adr/0002-config-v1-in-place.md`](adr/0002-config-v1-in-place.md) for why the V1
shapes may still be edited in place today.

## Error codes

`#[contracterror]`, append-only. Never renumber an existing code.

| Code | Variant | Returned by |
|---|---|---|
| 1 | `NotInitialized` | any function reading admin/config/state before they exist |
| 2 | `Paused` | `deposit`, `withdraw` |
| 3 | `AssetNotWhitelisted` | `deposit` |
| 4 | `InsufficientBalance` | `withdraw` |
| 5 | `TimelockNotExpired` | `withdraw` |
| 6 | `VaultNotFound` | `withdraw`, `get_vault` |
| 7 | `InvalidAmount` | `deposit`, `withdraw` (amount ≤ 0) |
| 8 | `InvalidLockPeriod` | `deposit`, `update_config`; traps from `__constructor` |

## Events

Topic layout is **verified from the built spec** in this build, not inferred from
source. Each event is declared with `topics = ["<name>"]`, which places that
symbol first, followed by each `#[topic]`-annotated field; remaining fields are the
data payload. So a client filters on the leading symbol topic plus the `#[topic]`
fields.

| Event | Topics as emitted | Data fields | Emitted by |
|---|---|---|---|
| `PauseEvent` | `pause_event`, `admin` | — | `pause` |
| `UnpauseEvent` | `unpause_event`, `admin` | — | `unpause` |
| `WhitelistEvent` | `whitelist_event`, `admin` | `asset: Address` | `add_asset` |
| `DelistEvent` | `delist_event`, `admin` | `asset: Address` | `remove_asset` |
| `NewAdminEvent` | `new_admin_event`, `admin` | `new_admin: Address` | `transfer_admin` |
| `DepositEvent` | `deposit_event`, `from`, `asset` | `vault_id: u32`, `amount: i128` | `deposit` |
| `WithdrawEvent` | `withdraw_event`, `to`, `asset` | `vault_id: u32`, `amount: i128` | `withdraw` |
| `UpgradeEvent` | `upgrade_event`, `admin` | `new_wasm_hash: BytesN<32>` | `upgrade` |

Consequences for the backend:

- `asset` is a **topic** on `DepositEvent` and `WithdrawEvent`, so a user's vault
  history can be filtered by asset directly. (This differs from the pre-E02 draft
  reference, which recorded `asset` as data on the whitelist events only — here it
  is data, not a topic, on `WhitelistEvent` and `DelistEvent`, so the current
  whitelist must be derived by decoding every such event.)
- `update_config` emits **nothing** in this build. Bounds changes are only
  observable by calling `get_lock_bounds` (E02-09 adds an event for this).
- No event exceeds the four-topic limit.

## Appendix: spec as exported by the wasm

Verbatim output of
`stellar contract info interface --wasm target/wasm32v1-none/release/lumens_vault.wasm`,
minus the leading "Loading contract spec from file..." line. This is what a
generated client binds to.

```rust
#[soroban_sdk::contractargs(name = "Args")]
#[soroban_sdk::contractclient(name = "Client")]
pub trait Contract {
    fn pause(env: soroban_sdk::Env) -> Result<(), Error>;
    fn deposit(
        env: soroban_sdk::Env,
        from: soroban_sdk::Address,
        asset: soroban_sdk::Address,
        amount: i128,
        lock_ledgers: u32,
    ) -> Result<u32, Error>;
    fn unpause(env: soroban_sdk::Env) -> Result<(), Error>;
    fn upgrade(
        env: soroban_sdk::Env,
        new_wasm_hash: soroban_sdk::BytesN<32>,
    ) -> Result<(), Error>;
    fn version(env: soroban_sdk::Env) -> u32;
    fn withdraw(
        env: soroban_sdk::Env,
        to: soroban_sdk::Address,
        asset: soroban_sdk::Address,
        vault_id: u32,
        amount: i128,
    ) -> Result<(), Error>;
    fn add_asset(
        env: soroban_sdk::Env,
        asset: soroban_sdk::Address,
    ) -> Result<(), Error>;
    fn get_vault(
        env: soroban_sdk::Env,
        user: soroban_sdk::Address,
        asset: soroban_sdk::Address,
        vault_id: u32,
    ) -> Result<VaultEntryV1, Error>;
    fn is_paused(env: soroban_sdk::Env) -> Result<bool, Error>;
    fn remove_asset(
        env: soroban_sdk::Env,
        asset: soroban_sdk::Address,
    ) -> Result<(), Error>;
    fn __constructor(
        env: soroban_sdk::Env,
        admin: soroban_sdk::Address,
        min_lock_ledgers: u32,
        max_lock_ledgers: u32,
    );
    fn update_config(
        env: soroban_sdk::Env,
        min_lock_ledgers: u32,
        max_lock_ledgers: u32,
    ) -> Result<(), Error>;
    fn is_whitelisted(env: soroban_sdk::Env, asset: soroban_sdk::Address) -> bool;
    fn transfer_admin(
        env: soroban_sdk::Env,
        new_admin: soroban_sdk::Address,
    ) -> Result<(), Error>;
    fn get_lock_bounds(env: soroban_sdk::Env) -> Result<(u32, u32), Error>;
    fn get_admin_address(env: soroban_sdk::Env) -> Result<soroban_sdk::Address, Error>;
    fn get_user_vault_count(env: soroban_sdk::Env, user: soroban_sdk::Address) -> u32;
}
#[soroban_sdk::contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct VaultEntryV1 {
    pub amount: i128,
    pub unlock_ledger: u32,
}
#[soroban_sdk::contracterror]
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub enum Error {
    NotInitialized = 1,
    Paused = 2,
    AssetNotWhitelisted = 3,
    InsufficientBalance = 4,
    TimelockNotExpired = 5,
    VaultNotFound = 6,
    InvalidAmount = 7,
    InvalidLockPeriod = 8,
}
#[soroban_sdk::contractevent(topics = ["pause_event"])]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct PauseEvent {
    #[topic]
    pub admin: soroban_sdk::Address,
}
#[soroban_sdk::contractevent(topics = ["delist_event"])]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct DelistEvent {
    #[topic]
    pub admin: soroban_sdk::Address,
    pub asset: soroban_sdk::Address,
}
#[soroban_sdk::contractevent(topics = ["deposit_event"])]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct DepositEvent {
    #[topic]
    pub from: soroban_sdk::Address,
    #[topic]
    pub asset: soroban_sdk::Address,
    pub vault_id: u32,
    pub amount: i128,
}
#[soroban_sdk::contractevent(topics = ["unpause_event"])]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct UnpauseEvent {
    #[topic]
    pub admin: soroban_sdk::Address,
}
#[soroban_sdk::contractevent(topics = ["upgrade_event"])]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct UpgradeEvent {
    #[topic]
    pub admin: soroban_sdk::Address,
    pub new_wasm_hash: soroban_sdk::BytesN<32>,
}
#[soroban_sdk::contractevent(topics = ["new_admin_event"])]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct NewAdminEvent {
    #[topic]
    pub admin: soroban_sdk::Address,
    pub new_admin: soroban_sdk::Address,
}
#[soroban_sdk::contractevent(topics = ["withdraw_event"])]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct WithdrawEvent {
    #[topic]
    pub to: soroban_sdk::Address,
    #[topic]
    pub asset: soroban_sdk::Address,
    pub vault_id: u32,
    pub amount: i128,
}
#[soroban_sdk::contractevent(topics = ["whitelist_event"])]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct WhitelistEvent {
    #[topic]
    pub admin: soroban_sdk::Address,
    pub asset: soroban_sdk::Address,
}
```
