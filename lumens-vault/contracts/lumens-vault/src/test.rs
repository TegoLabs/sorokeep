#![cfg(test)]
#![allow(deprecated)]

use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{
    testutils::{storage::Persistent, Address as _, Ledger},
    Address, BytesN, Env,
};

use crate::contract::Error;
use crate::storage::DataKey;
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
// Error variant coverage (NFR-2).
//
// Each test below triggers exactly one Error variant and asserts the
// variant, not just that a call failed. The set is deliberately complete
// for the variants this issue owns; `Paused` and `NotInitialized` are
// covered by E05-06 and E04-09 respectively.
// ---------------------------------------------------------------------

#[test]
fn test_deposit_rejects_non_whitelisted_asset() {
    // AssetNotWhitelisted — the asset was never added via `add_asset`, so
    // `check_whitelisted` fails before any token movement happens.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);

    // Deliberately do NOT call `vault_client.add_asset`.
    let res = vault_client.try_deposit(&user, &token_client.address, &100);
    assert_eq!(res, Err(Ok(Error::AssetNotWhitelisted)));

    // No vault was created, and no tokens moved.
    assert_eq!(vault_client.get_user_vault_count(&user), 0);
    assert_eq!(token_client.balance(&user), 1000);
    assert_eq!(token_client.balance(&vault_client.address), 0);
}

#[test]
fn test_withdraw_rejects_insufficient_balance() {
    // InsufficientBalance — attempt to withdraw more than the vault holds.
    // The stored balance must be unchanged afterwards: the failed withdraw
    // must not partially apply.
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
    // Advance past the lock so the failure cannot be attributed to
    // TimelockNotExpired.
    env.ledger().with_mut(|l| l.sequence_number += 11);

    let res = vault_client.try_withdraw(&user, &token_client.address, &1, &600);
    assert_eq!(res, Err(Ok(Error::InsufficientBalance)));

    // Balance unchanged — 500, not 0 or 500-600.
    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 500);
    assert_eq!(token_client.balance(&vault_client.address), 500);
    assert_eq!(token_client.balance(&user), 500);
}

#[test]
fn test_withdraw_timelock_boundary_is_inclusive() {
    // TimelockNotExpired — the comparison is `sequence < unlock_ledger`,
    // so withdrawal at exactly `unlock_ledger` is allowed and one ledger
    // earlier is not. Flipping the comparison to `<=` is a one-character
    // change no mid-range test would catch, so both sides are pinned.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    // lock period of 10 ledgers.
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    // Ledger starts at 0; deposit → unlock_ledger = 10.
    vault_client.deposit(&user, &token_client.address, &500);
    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.unlock_ledger, 10);

    // One before the boundary: must fail.
    env.ledger().with_mut(|l| l.sequence_number = 9);
    let res = vault_client.try_withdraw(&user, &token_client.address, &1, &100);
    assert_eq!(res, Err(Ok(Error::TimelockNotExpired)));

    // At the boundary: must succeed. This is the deliberate inclusive
    // semantic of `sequence < unlock_ledger`; the check is not `<=`.
    env.ledger().with_mut(|l| l.sequence_number = 10);
    vault_client.withdraw(&user, &token_client.address, &1, &100);
    assert_eq!(token_client.balance(&user), 600);
}

#[test]
fn test_get_vault_rejects_nonexistent_vault() {
    // VaultNotFound — get_vault on an id that was never issued.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, _token_asset) = create_token_contract(&env, &token_admin);

    let res = vault_client.try_get_vault(&user, &token_client.address, &999);
    assert_eq!(res, Err(Ok(Error::VaultNotFound)));
}

#[test]
fn test_withdraw_rejects_nonexistent_vault() {
    // VaultNotFound — withdraw on an id that was never issued. Distinct
    // from the get_vault path in the code (a different call site resolves
    // the entry), so both are pinned.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, _token_asset) = create_token_contract(&env, &token_admin);

    // Past the lock period, so the failure cannot be attributed to
    // TimelockNotExpired if the id lookup ever regresses.
    env.ledger().with_mut(|l| l.sequence_number += 11);

    let res = vault_client.try_withdraw(&user, &token_client.address, &999, &100);
    assert_eq!(res, Err(Ok(Error::VaultNotFound)));
}

#[test]
fn test_withdraw_rejects_zero_amount() {
    // InvalidAmount — zero on withdraw. The existing
    // `test_withdraw_rejects_non_positive_amount` covers the negative
    // half; this pins the zero half so the pair is complete for NFR-2.
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

    let res = vault_client.try_withdraw(&user, &token_client.address, &1, &0);
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));

    // Balance unchanged.
    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 500);
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
