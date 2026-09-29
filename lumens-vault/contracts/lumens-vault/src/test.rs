#![cfg(test)]
#![allow(deprecated)]

use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{
    testutils::{storage::Persistent, Address as _, Ledger},
    Address, BytesN, Env,
};

use crate::storage::{DataKey, VaultConfig, VaultConfigV1, VaultState};
use crate::{LumensVault, LumensVaultClient};

// Build requirements:
//
// - Rust 1.85 or later. soroban-sdk 28's dependency tree needs edition2024,
//   and an older toolchain fails on a transitive dependency before reaching
//   this crate's own code.
// - The `wasm32v1-none` target, for `stellar contract build`.
//
// `test_real_upgrade_and_state_migration` needs the v2 fixture compiled
// first — see the comment above it for why and for the build order.

fn create_token_contract<'a>(env: &Env, admin: &Address) -> (TokenClient<'a>, StellarAssetClient<'a>) {
    let contract_address = env.register_stellar_asset_contract_v2(admin.clone());
    (
        TokenClient::new(env, &contract_address.address()),
        StellarAssetClient::new(env, &contract_address.address()),
    )
}

/// `env.register` now takes constructor args directly, since `initialize`
/// was replaced by `__constructor` (see contract.rs change log item 1).
fn setup(env: &Env, admin: &Address, default_timelock_ledgers: u32) -> LumensVaultClient<'static> {
    let vault_id = env.register(LumensVault, (admin, default_timelock_ledgers));
    LumensVaultClient::new(env, &vault_id)
}

#[test]
fn test_deposit_and_withdraw() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);

    vault_client.add_asset(&token_client.address);

    let returned_vault_id = vault_client.deposit(&user, &token_client.address, &100);
    assert_eq!(returned_vault_id, 1);

    assert_eq!(token_client.balance(&user), 900);
    assert_eq!(token_client.balance(&vault_client.address), 100);

    // Timelock not yet expired.
    let res = vault_client.try_withdraw(&user, &token_client.address, &1, &50);
    assert!(res.is_err());

    env.ledger().with_mut(|l| l.sequence_number += 11);

    vault_client.withdraw(&user, &token_client.address, &1, &50);

    assert_eq!(token_client.balance(&user), 950);
    assert_eq!(token_client.balance(&vault_client.address), 50);

    // New: the view function this pass added actually reflects the state.
    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 50);
}

#[test]
fn test_deposit_rejects_non_positive_amount() {
    // NEW — covers the fix in contract.rs change log item 2. Before this
    // fix, neither of these guarded at all.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    let zero_res = vault_client.try_deposit(&user, &token_client.address, &0);
    assert!(zero_res.is_err());

    let negative_res = vault_client.try_deposit(&user, &token_client.address, &-100);
    assert!(negative_res.is_err());
}

#[test]
fn test_withdraw_rejects_non_positive_amount() {
    // NEW — this is the more important half of the fix: without the guard,
    // a negative `amount` here would have skipped the insufficient-balance
    // check and *inflated* the caller's recorded balance via
    // `entry_v1.amount -= amount`. See contract.rs change log item 2 for
    // the full walkthrough.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    vault_client.deposit(&user, &token_client.address, &500);
    env.ledger().with_mut(|l| l.sequence_number += 11);

    let res = vault_client.try_withdraw(&user, &token_client.address, &1, &-200);
    assert!(res.is_err());

    // Balance must be exactly what was deposited — not inflated.
    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 500);
}

#[test]
fn test_user_vault_count_ttl_is_extended_on_deposit() {
    // NEW — covers contract.rs change log item 3. Before this fix,
    // `UserVaultCount` was written once on a user's first deposit and never
    // touched again, so it would archive on its own default schedule
    // regardless of how active the user was — silently blocking every
    // future deposit from that user once it did.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    vault_client.deposit(&user, &token_client.address, &100);

    let count_key = DataKey::UserVaultCount(user.clone());
    let ttl_after_first_deposit =
        env.as_contract(&vault_client.address, || env.storage().persistent().get_ttl(&count_key));

    // Advance close to (but not past) the extension threshold and deposit
    // again — the TTL should be bumped back up, not left decaying.
    env.ledger()
        .with_mut(|l| l.sequence_number += ttl_after_first_deposit - 1000);

    vault_client.deposit(&user, &token_client.address, &50);

    let ttl_after_second_deposit =
        env.as_contract(&vault_client.address, || env.storage().persistent().get_ttl(&count_key));

    assert!(
        ttl_after_second_deposit > 1000,
        "UserVaultCount TTL was not refreshed on the second deposit — it would archive soon"
    );
}

// ---------------------------------------------------------------------
// The real upgrade test.
//
// This is a genuine cross-binary upgrade test, and the distinction matters:
// earlier versions of it wrote data through the V1 contract and read it back
// through the SAME running V1 binary, which proves storage round-trips and
// nothing about upgrades. Built the way Stellar's own docs build it:
// https://developers.stellar.org/docs/build/guides/conventions/upgrading-contracts
//
// It needs a second, genuinely separate crate — contracts/lumens-vault-v2-fixture/
// in the folder next to this one — compiled to wasm BEFORE this test runs,
// because `contractimport!` reads the compiled .wasm file at compile time,
// not at test time. Build order:
//
//   cd contracts/lumens-vault-v2-fixture && stellar contract build
//   cd ../lumens-vault && cargo test
//
// If your workspace layout puts these crates somewhere else, fix the path
// in the `contractimport!` call below to match.
// ---------------------------------------------------------------------

mod new_contract {
    soroban_sdk::contractimport!(
        file = "../lumens-vault-v2-fixture/target/wasm32v1-none/release/lumens_vault_v2_fixture.wasm"
    );
}

fn install_new_wasm(env: &Env) -> BytesN<32> {
    env.deployer().upload_contract_wasm(new_contract::WASM)
}

#[test]
fn test_real_upgrade_and_state_migration() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 1000);

    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    // 1. Write real state through the OLD contract's own deposit logic —
    //    not a raw storage poke.
    let returned_vault_id = vault_client.deposit(&user, &token_client.address, &500);
    assert_eq!(returned_vault_id, 1);
    assert_eq!(vault_client.version(), 1);

    // 2. Install a SECOND, genuinely different compiled binary and swap the
    //    SAME contract address over to it.
    let new_wasm_hash = install_new_wasm(&env);
    vault_client.upgrade(&new_wasm_hash);

    // 3. Prove the running bytecode actually changed. The V1 client type
    //    has no way to lie about this — `version()` only returns 2 if the
    //    call is genuinely being served by the new binary.
    assert_eq!(vault_client.version(), 2);

    // 4. The real claim: data written by the OLD binary as
    //    `VaultEntry::V1(..)` is read correctly by the NEW binary's own
    //    code, through a function (`get_vault` returning the V2 shape)
    //    that only exists post-upgrade. This has to go through a client
    //    typed against the NEW contract's interface — the old
    //    `LumensVaultClient` binding has no `get_vault` method to call.
    let new_client = new_contract::Client::new(&env, &vault_client.address);
    let migrated = new_client.get_vault(&user, &token_client.address, &1);

    assert_eq!(migrated.amount, 500);
    // `last_touched_ledger` only exists on VaultEntryV2 — its presence at
    // all is part of the proof that migration, not just a raw byte
    // round-trip, actually happened.
    assert!(migrated.last_touched_ledger > 0);
}

// ---------------------------------------------------------------------
// E05-18: admin state must survive an upgrade.
//
// Vault balances are the obvious thing to check across an upgrade (done
// above), but admin, pause state and config live in *instance* storage and
// are equally load-bearing — an upgrade that silently reset the admin would
// hand the contract to nobody, or to whoever the new binary's constructor
// names.
//
// What this test proves, and why each piece matters:
//
// 1. Every instance-storage key the OLD binary wrote (Admin, State,
//    Config, AssetWhitelist) is still there with its pre-upgrade value
//    after the SAME address has been swapped to a genuinely different
//    binary — proven while `version() == 2` shows the new wasm is the one
//    serving calls.
//
// 2. The new binary's constructor does NOT run on upgrade. `upgrade()` is
//    `update_current_contract`: a bytecode swap that supplies no
//    constructor arguments, and Soroban runs `__constructor` only at
//    deploy time. The fixture binary deliberately defines no constructor
//    at all. The evidence is the assertions below: V1's constructor always
//    writes `is_paused: false` and overwrites Admin/Config with its args,
//    so if anything had re-run at upgrade time, `paused_after` would be
//    false and/or the admin/config keys would differ. They don't.
//
// Post-upgrade reads go through `env.as_contract` rather than a client
// because the fixture binary intentionally exports only `version` and
// `get_vault`. `env.as_contract` reads exactly the same ledger entries the
// new binary itself would read — this is the harness reading chain state,
// not the test poking values in.
// ---------------------------------------------------------------------

#[test]
fn test_admin_state_survives_upgrade() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 1000);

    let admin = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);
    let asset_c = Address::generate(&env); // never whitelisted — must stay that way

    // Set the state through the contract's own admin paths, not raw
    // storage pokes: whatever survives the upgrade has to be state the
    // contract itself wrote.
    vault_client.add_asset(&asset_a);
    vault_client.add_asset(&asset_b);
    vault_client.pause();

    // V1's own views agree before the swap.
    assert_eq!(vault_client.get_admin_address(), admin);
    assert!(vault_client.is_paused());
    assert!(vault_client.is_whitelisted(&asset_a));
    assert!(vault_client.is_whitelisted(&asset_b));
    assert!(!vault_client.is_whitelisted(&asset_c));
    assert_eq!(vault_client.version(), 1);

    // Snapshot every instance-storage key the new binary will inherit.
    let admin_before: Address = env
        .as_contract(&vault_client.address, || {
            env.storage().instance().get(&DataKey::Admin)
        })
        .expect("__constructor must have stored the admin in instance storage");
    let paused_before: bool = env.as_contract(&vault_client.address, || {
        let state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .expect("__constructor must have stored the pause state");
        match state {
            VaultState::V1(s) => s.is_paused,
        }
    });
    let config_before: VaultConfig = env
        .as_contract(&vault_client.address, || {
            env.storage().instance().get(&DataKey::Config)
        })
        .expect("__constructor must have stored the config");
    let wl_a_before: bool = env
        .as_contract(&vault_client.address, || {
            env.storage()
                .instance()
                .get(&DataKey::AssetWhitelist(asset_a.clone()))
        })
        .unwrap_or(false);
    let wl_b_before: bool = env
        .as_contract(&vault_client.address, || {
            env.storage()
                .instance()
                .get(&DataKey::AssetWhitelist(asset_b.clone()))
        })
        .unwrap_or(false);
    let wl_c_before: bool = env
        .as_contract(&vault_client.address, || {
            env.storage()
                .instance()
                .get(&DataKey::AssetWhitelist(asset_c.clone()))
        })
        .unwrap_or(false);

    // Swap the SAME contract address over to a genuinely different binary.
    let new_wasm_hash = install_new_wasm(&env);
    vault_client.upgrade(&new_wasm_hash);

    // Prove the bytecode actually changed before asserting anything about
    // state: `version()` returns 2 only if this call is genuinely served
    // by the fixture wasm.
    assert_eq!(vault_client.version(), 2);

    // 1. Admin is identical before and after the upgrade.
    let admin_after: Address = env
        .as_contract(&vault_client.address, || {
            env.storage().instance().get(&DataKey::Admin)
        })
        .expect("admin key must still exist in instance storage after the upgrade");
    assert_eq!(
        admin_after, admin_before,
        "admin changed across the upgrade"
    );
    assert_eq!(
        admin_after, admin,
        "admin is no longer the address that was named at deploy time"
    );

    // 2. Pause survives: we paused BEFORE the upgrade; the contract is
    //    still paused AFTER it. If the constructor had re-run, this would
    //    be false — V1's constructor unconditionally writes is_paused:
    //    false.
    let paused_after: bool = env.as_contract(&vault_client.address, || {
        let state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .expect("pause state key must still exist after the upgrade");
        match state {
            VaultState::V1(s) => s.is_paused,
        }
    });
    assert_eq!(
        paused_after, paused_before,
        "pause state did not survive the upgrade"
    );
    assert!(
        paused_after,
        "contract is no longer paused after the upgrade — instance storage was reset"
    );

    // 3. Config survives, byte-identical to what the constructor wrote.
    let config_after: VaultConfig = env
        .as_contract(&vault_client.address, || {
            env.storage().instance().get(&DataKey::Config)
        })
        .expect("config key must still exist after the upgrade");
    assert_eq!(
        config_after, config_before,
        "config changed across the upgrade"
    );
    assert_eq!(
        config_after,
        VaultConfig::V1(VaultConfigV1 {
            default_timelock_ledgers: 10,
        })
    );

    // 4. Whitelist entries survive — both whitelisted assets stay
    //    whitelisted, and the asset that was never whitelisted did not
    //    silently become one.
    let wl_a_after: bool = env
        .as_contract(&vault_client.address, || {
            env.storage()
                .instance()
                .get(&DataKey::AssetWhitelist(asset_a.clone()))
        })
        .unwrap_or(false);
    let wl_b_after: bool = env
        .as_contract(&vault_client.address, || {
            env.storage()
                .instance()
                .get(&DataKey::AssetWhitelist(asset_b.clone()))
        })
        .unwrap_or(false);
    let wl_c_after: bool = env
        .as_contract(&vault_client.address, || {
            env.storage()
                .instance()
                .get(&DataKey::AssetWhitelist(asset_c.clone()))
        })
        .unwrap_or(false);

    assert_eq!(wl_a_after, wl_a_before, "asset A whitelist entry changed");
    assert!(wl_a_after, "asset A is no longer whitelisted");
    assert_eq!(wl_b_after, wl_b_before, "asset B whitelist entry changed");
    assert!(wl_b_after, "asset B is no longer whitelisted");
    assert_eq!(wl_c_after, wl_c_before, "asset C's whitelist entry changed");
    assert!(!wl_c_after, "asset C became whitelisted across the upgrade");
}
