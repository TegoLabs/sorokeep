# lumens-vault contract interface

> **DRAFT / PROVISIONAL.** Written from the source in the pre-E02 snapshot, **not** from a built wasm and **not** after the E02 lock-period changes. It must be regenerated against the built wasm once #843, #808 and #822 (and the E02 work) are merged. Items marked `[CHANGES WITH E02]` are known to differ in the final interface.

- Wasm hash described: `<FILL after build>`
- Wasm size: `<FILL after build>`
- Commit: `<FILL>`
- Verified against `stellar contract inspect`: **no** (fill in when done)

## Functions

All fallible functions return `Result<_, Error>`. "Auth" is the address that must authorize the call.

### Constructor

| Function | Arguments | Auth | Errors |
|---|---|---|---|
| `__constructor` `[CHANGES WITH E02]` | `admin: Address, default_timelock_ledgers: u32` (E02-03: becomes `admin, min_lock_ledgers: u32, max_lock_ledgers: u32`) | `admin` | none currently |

Runs atomically at deploy; cannot be called again.

### Admin

| Function | Arguments | Returns | Auth | Errors |
|---|---|---|---|---|
| `pause` | — | `()` | admin | NotInitialized |
| `unpause` | — | `()` | admin | NotInitialized |
| `add_asset` | `asset: Address` | `()` | admin | NotInitialized |
| `remove_asset` | `asset: Address` | `()` | admin | NotInitialized |
| `transfer_admin` | `new_admin: Address` | `()` | admin | NotInitialized |
| `update_config` `[CHANGES WITH E02]` | `new_timelock_ledgers: u32` (E02-08: becomes `min_lock_ledgers, max_lock_ledgers`) | `()` | admin | NotInitialized (E02-08 adds bounds rejection) |
| `upgrade` | `new_wasm_hash: BytesN<32>` | `()` | admin | NotInitialized |

### Vault operations

| Function | Arguments | Returns | Auth | Errors |
|---|---|---|---|---|
| `deposit` `[CHANGES WITH E02]` | `from: Address, asset: Address, amount: i128` (E02: gains caller-supplied `lock_ledgers`) | `u32` (new vault id, starting at 1 per user) | `from` | InvalidAmount, Paused, AssetNotWhitelisted, NotInitialized (E02-05 adds InvalidLockPeriod) |
| `withdraw` | `to: Address, asset: Address, vault_id: u32, amount: i128` | `()` | `to` | InvalidAmount, Paused, VaultNotFound, InsufficientBalance, TimelockNotExpired, NotInitialized |

Semantics the frontend and backend depend on:

- `withdraw` checks, in order: `amount > 0`, not paused, vault exists, `amount <= balance`, then `ledger sequence >= unlock_ledger`. A vault is withdrawable **at** `unlock_ledger` (comparison is `sequence < unlock_ledger` → TimelockNotExpired).
- `withdraw` does **not** check the whitelist; a delisted asset never traps funds.
- Partial withdrawals are allowed; the vault entry remains with reduced `amount`.
- Token transfer failures surface as host traps from the token contract, not as `Error` variants.

### Views

| Function | Arguments | Returns | Errors |
|---|---|---|---|
| `version` | — | `u32` (currently 1) | none |
| `get_vault` | `user: Address, asset: Address, vault_id: u32` | `VaultEntryV1` | VaultNotFound |
| `get_user_vault_count` | `user: Address` | `u32` (0 if none) | none |
| `is_paused` | — | `bool` | NotInitialized |
| `is_whitelisted` | `asset: Address` | `bool` (false if never added) | none |
| `get_admin_address` | — | `Address` | NotInitialized |
| `get_lock_bounds` `[NOT PRESENT IN SNAPSHOT]` | expected after E02 | expected after E02 | — |

Enumerating a user's vaults is not possible on-chain; the backend must replay events.

## Types

```
VaultEntryV1 { amount: i128, unlock_ledger: u32 }
```

Also exported in the spec as `contracttype`s (storage shapes): `DataKey`, `VaultConfig`/`VaultConfigV1 { default_timelock_ledgers: u32 }` `[CHANGES WITH E02]`, `VaultEntry`, `VaultState`/`VaultStateV1 { is_paused: bool }`.

## Error codes

Append-only. Never renumber.

| Code | Variant |
|---|---|
| 1 | NotInitialized |
| 2 | Paused |
| 3 | AssetNotWhitelisted |
| 4 | InsufficientBalance |
| 5 | TimelockNotExpired |
| 6 | VaultNotFound |
| 7 | InvalidAmount |
| 8 | InvalidLockPeriod `[NOT PRESENT IN SNAPSHOT — added by E02-05]` |

## Events

**UNVERIFIED topic layout.** `events.rs` records that no event sets `#[contractevent(topics = [...])]`, so the macro's default naming applies and whether an implicit name topic is prepended has not been checked. Fill the "Topics as emitted" column from the E05-08 test / a real emission before freezing. The "declared" columns below come from source.

| Event | Declared `#[topic]` fields | Data fields | Emitted by | Topics as emitted |
|---|---|---|---|---|
| PauseEvent | admin: Address | — | pause | `<FILL>` |
| UnpauseEvent | admin: Address | — | unpause | `<FILL>` |
| WhitelistEvent | admin: Address | asset: Address | add_asset | `<FILL>` |
| DelistEvent | admin: Address | asset: Address | remove_asset | `<FILL>` |
| NewAdminEvent | admin: Address | new_admin: Address | transfer_admin | `<FILL>` |
| DepositEvent | from: Address, asset: Address | vault_id: u32, amount: i128 | deposit | `<FILL>` |
| WithdrawEvent | to: Address, asset: Address | vault_id: u32, amount: i128 | withdraw | `<FILL>` |
| UpgradeEvent | admin: Address | new_wasm_hash: BytesN<32> | upgrade | `<FILL>` |
| ConfigUpdatedEvent `[NOT PRESENT IN SNAPSHOT — E02-09]` | admin | min_lock_ledgers, max_lock_ledgers | update_config | `<FILL>` |

Consequence for the backend: `asset` is data (not a topic) on WhitelistEvent and DelistEvent, so the current whitelist must be derived by decoding every such event; it cannot be filtered by topic. `update_config` emits nothing in the snapshot.
