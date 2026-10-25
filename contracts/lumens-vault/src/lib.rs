#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockBounds {
    pub min_amount: i128,
    pub max_amount: i128,
    pub min_duration: u64,
    pub max_duration: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    LockBounds,
}

#[contract]
pub struct LumensVault;

#[contractimpl]
impl LumensVault {
    /// Initializes the vault with an admin and default lock bounds.
    pub fn initialize(env: Env, admin: Address, bounds: LockBounds) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if bounds.min_amount < 0 || bounds.min_amount > bounds.max_amount {
            panic!("invalid amount bounds");
        }
        if bounds.min_duration > bounds.max_duration {
            panic!("invalid duration bounds");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::LockBounds, &bounds);
    }

    /// Returns the currently configured lock bounds.
    pub fn get_lock_bounds(env: Env) -> LockBounds {
        env.storage()
            .instance()
            .get(&DataKey::LockBounds)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    /// Updates the lock bounds. Only callable by the admin.
    pub fn set_lock_bounds(env: Env, bounds: LockBounds) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("not initialized"));
        admin.require_auth();
        if bounds.min_amount < 0 || bounds.min_amount > bounds.max_amount {
            panic!("invalid amount bounds");
        }
        if bounds.min_duration > bounds.max_duration {
            panic!("invalid duration bounds");
        }
        env.storage().instance().set(&DataKey::LockBounds, &bounds);
    }

    /// Returns the admin address.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    /// Returns a version symbol for build verification.
    pub fn version(_env: Env) -> Symbol {
        symbol_short!("v1")
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn sample_bounds() -> LockBounds {
        LockBounds {
            min_amount: 1,
            max_amount: 1_000_000,
            min_duration: 1,
            max_duration: 31_536_000,
        }
    }

    #[test]
    fn initialize_and_read_bounds() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(LumensVault, ());
        let client = LumensVaultClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &sample_bounds());
        assert_eq!(client.get_lock_bounds(), sample_bounds());
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    fn set_lock_bounds_updates_storage() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(LumensVault, ());
        let client = LumensVaultClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &sample_bounds());
        let updated = LockBounds {
            min_amount: 10,
            max_amount: 500,
            min_duration: 5,
            max_duration: 100,
        };
        client.set_lock_bounds(&updated);
        assert_eq!(client.get_lock_bounds(), updated);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn double_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(LumensVault, ());
        let client = LumensVaultClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &sample_bounds());
        client.initialize(&admin, &sample_bounds());
    }
}
