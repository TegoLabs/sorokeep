use soroban_sdk::{
    contract, contracterror, contractimpl, panic_with_error, token, Address, BytesN, Env,
};

use crate::events::*;
use crate::storage::{
    DataKey, VaultConfig, VaultConfigV1, VaultEntry, VaultEntryV1, VaultState, VaultStateV1,
};

// Design invariants worth knowing before changing anything here:
//
// - Error codes are part of the public interface. Clients decode them by
//   number, so append new variants at the end and never renumber existing
//   ones once the contract has been deployed anywhere.
// - Persisted values are wrapped in versioned enums (`VaultEntry::V1`).
//   A future version adds a variant and leaves V1 byte-identical, which is
//   what makes `upgrade()` safe. See `test_real_upgrade_and_state_migration`.
// - Locks are enforced by comparing against `unlock_ledger`, never by TTL.
//   TTL is permissionless — anyone can extend any entry — so it cannot gate
//   a withdrawal.
// - The contract exposes point lookups only. Enumerating a user's vaults is
//   an application-layer concern, because Soroban has no collection scan that
//   is both safe and cheap at scale.

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    NotInitialized = 1,
    Paused = 2,
    AssetNotWhitelisted = 3,
    InsufficientBalance = 4,
    TimelockNotExpired = 5,
    VaultNotFound = 6,
    InvalidAmount = 7,
    // Code 8 belongs to InvalidLockPeriod in E02-05; keep it available.
    InvalidLockBounds = 9,
}

const DAY_IN_LEDGERS: u32 = 17280; // 86,400s / 5s-per-ledger

const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = 14 * DAY_IN_LEDGERS;

const PERSISTENT_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 14 * DAY_IN_LEDGERS;

/// Bumped only when the contract's actual logic changes across an upgrade.
/// A future V2 binary should return 2 here — this is how `test.rs` proves
/// the running bytecode really changed, not just that storage round-trips.
pub const VERSION: u32 = 1;

#[contract]
pub struct LumensVault;

#[contractimpl]
impl LumensVault {
    /// Runs atomically as part of deployment. Cannot be called again.
    //
    // Keep this a constructor; do not reintroduce a separate `initialize`
    // entry point. A separate initializer is callable by anyone in the window
    // between deploy and first call, and whoever calls it first takes the
    // admin role permanently — a real front-running vulnerability, not a
    // theoretical one. `admin.require_auth()` alone does not close it; only
    // atomic deploy-and-initialize does.
    //
    // The `require_auth()` below is needed for a separate reason: when the
    // deploying account and the intended admin differ, which is the production
    // case with a multisig admin, the admin must co-sign the deploy
    // transaction rather than being named without its consent.
    //
    // Note: `///` doc comments on contract functions are embedded in the wasm's
    // spec metadata and are paid for in rent forever. Keep them to one line and
    // put the reasoning in `//` comments like this one.
    pub fn __constructor(env: Env, admin: Address, min_lock_ledgers: u32, max_lock_ledgers: u32) {
        admin.require_auth();

        // A zero minimum or inverted range would make the vault unusable until
        // an upgrade. Reject it before any instance storage is written.
        if min_lock_ledgers == 0 || max_lock_ledgers < min_lock_ledgers {
            panic_with_error!(&env, Error::InvalidLockBounds);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);

        let config = VaultConfig::V1(VaultConfigV1 {
            min_lock_ledgers,
            max_lock_ledgers,
        });
        env.storage().instance().set(&DataKey::Config, &config);

        let state = VaultState::V1(VaultStateV1 { is_paused: false });
        env.storage().instance().set(&DataKey::State, &state);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    /// Compile-time constant identifying the currently-running bytecode.
    /// Bump this whenever you cut a new upgrade.
    pub fn version(_env: Env) -> u32 {
        VERSION
    }

    // --- Admin ---

    pub fn pause(env: Env) -> Result<(), Error> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        let state = VaultState::V1(VaultStateV1 { is_paused: true });
        env.storage().instance().set(&DataKey::State, &state);

        PauseEvent {
            admin: admin.clone(),
        }
        .publish(&env);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        let state = VaultState::V1(VaultStateV1 { is_paused: false });
        env.storage().instance().set(&DataKey::State, &state);

        UnpauseEvent {
            admin: admin.clone(),
        }
        .publish(&env);
        Ok(())
    }

    pub fn add_asset(env: Env, asset: Address) -> Result<(), Error> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::AssetWhitelist(asset.clone()), &true);
        WhitelistEvent {
            admin: admin.clone(),
            asset: asset.clone(),
        }
        .publish(&env);
        Ok(())
    }

    pub fn remove_asset(env: Env, asset: Address) -> Result<(), Error> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::AssetWhitelist(asset.clone()), &false);
        DelistEvent {
            admin: admin.clone(),
            asset: asset.clone(),
        }
        .publish(&env);
        Ok(())
    }

    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &new_admin);
        NewAdminEvent {
            admin: admin.clone(),
            new_admin: new_admin.clone(),
        }
        .publish(&env);
        Ok(())
    }

    pub fn update_config(env: Env, new_timelock_ledgers: u32) -> Result<(), Error> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        let config = VaultConfig::V1(VaultConfigV1 {
            default_timelock_ledgers: new_timelock_ledgers,
        });
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        env.deployer()
            .update_current_contract(soroban_sdk::ContractExecutable::Wasm(new_wasm_hash.clone()));

        UpgradeEvent {
            admin: admin.clone(),
            new_wasm_hash: new_wasm_hash.clone(),
        }
        .publish(&env);
        Ok(())
    }

    // --- Vault operations ---

    pub fn deposit(env: Env, from: Address, asset: Address, amount: i128) -> Result<u32, Error> {
        from.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        Self::check_paused(&env)?;
        Self::check_whitelisted(&env, &asset)?;

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&from, &env.current_contract_address(), &amount);

        let vault_count_key = DataKey::UserVaultCount(from.clone());
        let current_count: u32 = env
            .storage()
            .persistent()
            .get(&vault_count_key)
            .unwrap_or(0);
        let new_vault_id = current_count + 1;
        env.storage()
            .persistent()
            .set(&vault_count_key, &new_vault_id);
        // This counter is read on every future deposit by this user, so it
        // must be kept alive even when only the Vault entries are active.
        // If it archives, the next deposit fails outright: an archived
        // persistent entry in a transaction's footprint stops the whole
        // transaction executing until a RestoreFootprintOp runs — even
        // though the user's existing vaults are perfectly healthy.
        env.storage().persistent().extend_ttl(
            &vault_count_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let config = Self::get_config(&env)?;
        let unlock_ledger = env.ledger().sequence() + config.default_timelock_ledgers;

        let vault_entry = VaultEntry::V1(VaultEntryV1 {
            amount,
            unlock_ledger,
        });

        let vault_key = DataKey::Vault(from.clone(), asset.clone(), new_vault_id);
        env.storage().persistent().set(&vault_key, &vault_entry);
        env.storage().persistent().extend_ttl(
            &vault_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        DepositEvent {
            from: from.clone(),
            asset: asset.clone(),
            vault_id: new_vault_id,
            amount,
        }
        .publish(&env);

        Ok(new_vault_id)
    }

    pub fn withdraw(
        env: Env,
        to: Address,
        asset: Address,
        vault_id: u32,
        amount: i128,
    ) -> Result<(), Error> {
        to.require_auth();

        // This guard is load-bearing, not defensive boilerplate. Without it a
        // negative `amount` passes the insufficient-balance check below, and
        // then `entry_v1.amount -= amount` *increases* the stored balance
        // while issuing a negative transfer. Whether that is exploitable
        // end to end depends on the specific token's own `transfer`, which
        // this vault cannot assume anything about for every asset an admin
        // might whitelist in future.
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        Self::check_paused(&env)?;
        // Deliberately no `check_whitelisted` here — a delisted asset must
        // never trap funds that were deposited while it was still valid.

        let vault_key = DataKey::Vault(to.clone(), asset.clone(), vault_id);
        let vault_entry: VaultEntry = env
            .storage()
            .persistent()
            .get(&vault_key)
            .ok_or(Error::VaultNotFound)?;
        env.storage().persistent().extend_ttl(
            &vault_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let mut entry_v1 = match vault_entry {
            VaultEntry::V1(e) => e,
        };

        if entry_v1.amount < amount {
            return Err(Error::InsufficientBalance);
        }

        if env.ledger().sequence() < entry_v1.unlock_ledger {
            return Err(Error::TimelockNotExpired);
        }

        entry_v1.amount -= amount;
        env.storage()
            .persistent()
            .set(&vault_key, &VaultEntry::V1(entry_v1));

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&env.current_contract_address(), &to, &amount);

        WithdrawEvent {
            to: to.clone(),
            asset: asset.clone(),
            vault_id,
            amount,
        }
        .publish(&env);

        Ok(())
    }

    // --- Views ---
    //
    // Point lookups only, by design (see the invariants at the top of this
    // file). These let a client verify state directly against the chain, but
    // they are not a substitute for the off-chain reader: there is no on-chain
    // way to enumerate every asset a user has ever deposited, so listing a
    // user's vaults still requires replaying events.

    pub fn get_vault(
        env: Env,
        user: Address,
        asset: Address,
        vault_id: u32,
    ) -> Result<VaultEntryV1, Error> {
        let vault_key = DataKey::Vault(user, asset, vault_id);
        let entry: VaultEntry = env
            .storage()
            .persistent()
            .get(&vault_key)
            .ok_or(Error::VaultNotFound)?;
        match entry {
            VaultEntry::V1(e) => Ok(e),
        }
    }

    pub fn get_user_vault_count(env: Env, user: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::UserVaultCount(user))
            .unwrap_or(0)
    }

    pub fn is_paused(env: Env) -> Result<bool, Error> {
        let state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInitialized)?;
        match state {
            VaultState::V1(s) => Ok(s.is_paused),
        }
    }

    pub fn is_whitelisted(env: Env, asset: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::AssetWhitelist(asset))
            .unwrap_or(false)
    }

    pub fn get_admin_address(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    // --- Internal helpers ---

    fn get_admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    fn get_config(env: &Env) -> Result<VaultConfigV1, Error> {
        let config: VaultConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;
        match config {
            VaultConfig::V1(c) => Ok(c),
        }
    }

    fn check_paused(env: &Env) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        let state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInitialized)?;
        match state {
            VaultState::V1(s) => {
                if s.is_paused {
                    return Err(Error::Paused);
                }
            }
        }
        Ok(())
    }

    fn check_whitelisted(env: &Env, asset: &Address) -> Result<(), Error> {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        let is_whitelisted = env
            .storage()
            .instance()
            .get(&DataKey::AssetWhitelist(asset.clone()))
            .unwrap_or(false);
        if !is_whitelisted {
            return Err(Error::AssetNotWhitelisted);
        }
        Ok(())
    }
}
