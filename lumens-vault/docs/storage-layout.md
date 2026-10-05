# Lumens Vault Storage Layout

This document authoritatively describes the storage layout for the Lumens Vault contract, satisfying the requirements for Sorokeep's registration and guard services.

## DataKey Variants

The `DataKey` enum defines the keys for all stored values. Every persisted value is wrapped in a versioned enum (e.g., `VaultEntry::V1`) to allow for safe in-place upgrades.

### `DataKey::Admin`
*   **Storage Class**: Instance
*   **Holds**: `Address` (the admin's address)
*   **Functions that touch it**: `__constructor`, `transfer_admin`, `get_admin_address`, `pause`, `unpause`, `add_asset`, `remove_asset`, `update_config`, `upgrade` (all admin actions).

### `DataKey::State`
*   **Storage Class**: Instance
*   **Holds**: `VaultState::V1 { is_paused: bool }`
*   **Functions that touch it**: `__constructor`, `pause`, `unpause`, `is_paused`, `deposit`, `withdraw` (via `check_paused`).

### `DataKey::Config`
*   **Storage Class**: Instance
*   **Holds**: `VaultConfig::V1 { default_timelock_ledgers: u32 }`
*   **Functions that touch it**: `__constructor`, `update_config`, `deposit` (via `get_config`).

### `DataKey::AssetWhitelist(Address)`
*   **Storage Class**: Instance
*   **Holds**: `bool` (whether the asset is allowed)
*   **Functions that touch it**: `add_asset`, `remove_asset`, `is_whitelisted`, `deposit` (via `check_whitelisted`).

### `DataKey::UserVaultCount(Address)`
*   **Storage Class**: Persistent
*   **Holds**: `u32` (auto-incrementing counter for the last used vault ID)
*   **Functions that touch it**: `deposit`, `get_user_vault_count`.

### `DataKey::Vault(Address, Address, u32)`
*   **Storage Class**: Persistent
*   **Holds**: `VaultEntry::V1 { amount: i128, unlock_ledger: u32 }`
*   **Functions that touch it**: `deposit`, `withdraw`, `get_vault`.

## TTL Constants

The contract uses the following TTL constants, calculated at 5 seconds per ledger (`DAY_IN_LEDGERS = 17,280`):

*   **Instance Data**:
    *   `INSTANCE_LIFETIME_THRESHOLD`: 14 days (241,920 ledgers)
    *   `INSTANCE_BUMP_AMOUNT`: 30 days (518,400 ledgers)
*   **Persistent Data**:
    *   `PERSISTENT_LIFETIME_THRESHOLD`: 14 days (241,920 ledgers)
    *   `PERSISTENT_BUMP_AMOUNT`: 30 days (518,400 ledgers)

## Sorokeep Guard Requirements (Dormant Vaults)

Sorokeep's guard **must cover persistent entries** (`DataKey::Vault` and `DataKey::UserVaultCount`). 

If a user deposits funds and goes dormant (e.g., waiting for a long timelock to expire before withdrawing), no natural contract calls will refresh their persistent storage entries. If these entries are not externally refreshed by a guard service, they will archive, which would prevent the user from withdrawing their funds (or even depositing to a new vault, due to the archived `UserVaultCount` halting execution).

Instance entries, on the other hand, are refreshed by virtually every interaction with the contract (e.g., any deposit, withdrawal, or admin action extends the instance TTL), so they are at low risk of archiving on an active contract.

## Why Locks Use `unlock_ledger` Rather Than TTL

Timelocks are enforced by comparing the current ledger sequence against the `unlock_ledger` stored in `VaultEntry::V1`, rather than relying on the storage entry's TTL. 

This is because **TTL is permissionless** on Soroban—anyone can extend the TTL of any storage entry. If TTL were used to gate withdrawals, a third party could arbitrarily extend a user's lock by bumping the TTL, preventing them from accessing their funds. By using an explicit `unlock_ledger` value, the lock time is immutable once set and independent of the storage layer's archiving mechanism.
