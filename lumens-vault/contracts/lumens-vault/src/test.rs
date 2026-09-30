#![cfg(test)]
#![allow(deprecated)]

// The crate is #![no_std], but the test harness links std. Import it so the
// constructor-trap tests below can use std::panic::catch_unwind.
extern crate std;

use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{
    testutils::{storage::Persistent, Address as _, Events, Ledger},
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

fn create_token_contract<'a>(
    env: &Env,
    admin: &Address,
) -> (TokenClient<'a>, StellarAssetClient<'a>) {
    let contract_address = env.register_stellar_asset_contract_v2(admin.clone());
    (
        TokenClient::new(env, &contract_address.address()),
        StellarAssetClient::new(env, &contract_address.address()),
    )
}

/// `env.register` takes constructor args directly, since `initialize` was
/// replaced by `__constructor`. Bounds are (min, max); every test uses the
/// same [10, 1000] window unless it is specifically testing the bounds.
fn setup(
    env: &Env,
    admin: &Address,
    min_lock_ledgers: u32,
    max_lock_ledgers: u32,
) -> LumensVaultClient<'static> {
    let vault_id = env.register(LumensVault, (admin, min_lock_ledgers, max_lock_ledgers));
    LumensVaultClient::new(env, &vault_id)
}

/// Standard bounds for tests that don't care about them specifically.
const MIN_LOCK: u32 = 10;
const MAX_LOCK: u32 = 1000;

#[test]
fn test_deposit_and_withdraw() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    let vault_client = setup(&env, &admin, MIN_LOCK, MAX_LOCK);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);

    vault_client.add_asset(&token_client.address);

    let returned_vault_id = vault_client.deposit(&user, &token_client.address, &100, &10);
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

    // The view function actually reflects the state.
    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 50);
}

#[test]
fn test_deposit_rejects_non_positive_amount() {
    // Covers the non-positive-amount guard on deposit. Before that fix,
    // neither deposit nor withdraw guarded at all.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, MIN_LOCK, MAX_LOCK);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    let zero_res = vault_client.try_deposit(&user, &token_client.address, &0, &10);
    assert!(zero_res.is_err());

    let negative_res = vault_client.try_deposit(&user, &token_client.address, &-100, &10);
    assert!(negative_res.is_err());
}

#[test]
fn test_withdraw_rejects_non_positive_amount() {
    // The more important half of the guard: without it, a negative `amount`
    // here would have skipped the insufficient-balance check and *inflated*
    // the caller's recorded balance via `entry_v1.amount -= amount`.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, MIN_LOCK, MAX_LOCK);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    vault_client.deposit(&user, &token_client.address, &500, &10);
    env.ledger().with_mut(|l| l.sequence_number += 11);

    let res = vault_client.try_withdraw(&user, &token_client.address, &1, &-200);
    assert!(res.is_err());

    // Balance must be exactly what was deposited — not inflated.
    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 500);
}

#[test]
fn test_user_vault_count_ttl_is_extended_on_deposit() {
    // Before this was guarded, `UserVaultCount` was written once on a
    // user's first deposit and never touched again, so it would archive on
    // its own default schedule regardless of how active the user was —
    // silently blocking every future deposit from that user once it did.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, MIN_LOCK, MAX_LOCK);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    vault_client.deposit(&user, &token_client.address, &100, &10);

    let count_key = DataKey::UserVaultCount(user.clone());
    let ttl_after_first_deposit = env.as_contract(&vault_client.address, || {
        env.storage().persistent().get_ttl(&count_key)
    });

    // Advance close to (but not past) the extension threshold and deposit
    // again — the TTL should be bumped back up, not left decaying.
    env.ledger()
        .with_mut(|l| l.sequence_number += ttl_after_first_deposit - 1000);

    vault_client.deposit(&user, &token_client.address, &50, &10);

    let ttl_after_second_deposit = env.as_contract(&vault_client.address, || {
        env.storage().persistent().get_ttl(&count_key)
    });

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

    let vault_client = setup(&env, &admin, MIN_LOCK, MAX_LOCK);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    // 1. Write real state through the OLD contract's own deposit logic —
    //    not a raw storage poke.
    let returned_vault_id = vault_client.deposit(&user, &token_client.address, &500, &10);
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
// Lock-period tests (E02 series).
//
// Bounds are global, inclusive at both ends, required per deposit, and
// changeable by the admin without affecting existing vaults.
//
// Note on try_* assertions: a contract error surfaces from a try_ call as
// Err(Ok(Error::Variant)) — the outer layer is the invocation result, the
// inner one the contract's own error. The exact-match assertions below
// pin the specific variant, not just "some error".
// ---------------------------------------------------------------------

#[test]
fn test_constructor_rejects_min_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    // Constructors reject invalid bounds by trapping via panic_with_error!,
    // which aborts the deployment atomically — `register` panics here.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = env.register(LumensVault, (admin.clone(), 0u32, 100u32));
    }));
    assert!(result.is_err(), "min == 0 must be rejected at deploy time");
}

#[test]
fn test_constructor_rejects_max_below_min() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = env.register(LumensVault, (admin.clone(), 100u32, 50u32));
    }));
    assert!(result.is_err(), "max < min must be rejected at deploy time");
}

#[test]
fn test_constructor_accepts_inclusive_equal_bounds() {
    // min == max is legal: the bounds are a closed interval, so a contract
    // that only ever wants one fixed lock period is expressible.
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let vault_client = setup(&env, &admin, 50, 50);
    assert_eq!(vault_client.get_lock_bounds(), (50, 50));
}

#[test]
fn test_deposit_rejects_lock_period_outside_bounds() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, MIN_LOCK, MAX_LOCK);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    // Below min.
    let res = vault_client.try_deposit(&user, &token_client.address, &100, &(MIN_LOCK - 1));
    assert_eq!(res, Err(Ok(Error::InvalidLockPeriod)));
    // Above max.
    let res = vault_client.try_deposit(&user, &token_client.address, &100, &(MAX_LOCK + 1));
    assert_eq!(res, Err(Ok(Error::InvalidLockPeriod)));

    // Rejections roll back atomically — no funds moved.
    assert_eq!(token_client.balance(&user), 1000);
    assert_eq!(token_client.balance(&vault_client.address), 0);

    // Both boundary values are accepted: the range is inclusive at both
    // ends. This is the detail that silently drifts between contract and
    // UI, so it is pinned explicitly.
    let id_min = vault_client.deposit(&user, &token_client.address, &10, &MIN_LOCK);
    let id_max = vault_client.deposit(&user, &token_client.address, &10, &MAX_LOCK);
    assert_eq!(id_min, 1);
    assert_eq!(id_max, 2);

    // unlock_ledger derives from the caller's lock_ledgers, not from any
    // stored default — both deposits happened at the current sequence.
    let entry_min = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(
        entry_min.unlock_ledger,
        env.ledger().sequence() + MIN_LOCK,
        "unlock_ledger must derive from the caller's lock_ledgers"
    );
    let entry_max = vault_client.get_vault(&user, &token_client.address, &2);
    assert_eq!(entry_max.unlock_ledger, env.ledger().sequence() + MAX_LOCK);
}

#[test]
fn test_deposit_overflowing_lock_period_returns_clean_error() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, MIN_LOCK, u32::MAX);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    // MAX_LOCK is u32::MAX so the bounds check passes, but the ledger
    // sequence + lock_ledgers overflows u32. This must be a clean,
    // decodable error — not a trap from the release profile's
    // overflow-checks, which would give the client no decodable variant.
    let res = vault_client.try_deposit(&user, &token_client.address, &100, &u32::MAX);
    assert_eq!(res, Err(Ok(Error::InvalidLockPeriod)));

    // No funds moved and no vault was created.
    assert_eq!(token_client.balance(&user), 1000);
    assert_eq!(vault_client.get_user_vault_count(&user), 0);
}

#[test]
fn test_deposit_fails_cleanly_when_user_vault_count_is_maxed() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, MIN_LOCK, MAX_LOCK);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    // Pin the per-user counter at u32::MAX directly, so the next deposit
    // would overflow it. Needs contract context to write storage.
    let count_key = DataKey::UserVaultCount(user.clone());
    env.as_contract(&vault_client.address, || {
        env.storage().persistent().set(&count_key, &u32::MAX);
    });

    let res = vault_client.try_deposit(&user, &token_client.address, &100, &10);
    assert_eq!(res, Err(Ok(Error::VaultIdOverflow)));

    // The counter must be unchanged — a failed deposit must not consume
    // or wrap the id space.
    assert_eq!(vault_client.get_user_vault_count(&user), u32::MAX);
}

#[test]
fn test_update_config_rejects_invalid_bounds_and_applies_valid_ones() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, MIN_LOCK, MAX_LOCK);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    // Deposit under the ORIGINAL bounds first: this vault's terms are
    // fixed at deposit time and the rest of the test must not move them.
    vault_client.deposit(&user, &token_client.address, &100, &10);
    let entry_before = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry_before.unlock_ledger, env.ledger().sequence() + 10);

    // Invalid: min == 0.
    let res = vault_client.try_update_config(&0, &500);
    assert_eq!(res, Err(Ok(Error::InvalidLockPeriod)));
    // Invalid: max < min.
    let res = vault_client.try_update_config(&500, &100);
    assert_eq!(res, Err(Ok(Error::InvalidLockPeriod)));

    // Failed updates must leave the stored bounds untouched.
    assert_eq!(vault_client.get_lock_bounds(), (MIN_LOCK, MAX_LOCK));

    // Valid change applies.
    vault_client.update_config(&20, &200);
    assert_eq!(vault_client.get_lock_bounds(), (20, 200));

    // A subsequent deposit validates against the NEW bounds: 10 is now
    // below the new min and must be rejected even though it was valid
    // when vault 1 was created; 20 is the inclusive edge and is accepted.
    let res = vault_client.try_deposit(&user, &token_client.address, &100, &10);
    assert_eq!(res, Err(Ok(Error::InvalidLockPeriod)));
    vault_client.deposit(&user, &token_client.address, &100, &20);

    // Existing vaults are unaffected by a bounds change — their
    // unlock_ledger was fixed at deposit time.
    let entry_after = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(
        entry_after.unlock_ledger, entry_before.unlock_ledger,
        "a bounds change must never touch already-existing vaults"
    );
}

#[test]
fn test_update_config_publishes_config_updated_event() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let vault_client = setup(&env, &admin, MIN_LOCK, MAX_LOCK);

    let events_before = env.events().all().events().len();
    vault_client.update_config(&30, &300);
    let events_after = env.events().all().events().len();

    assert_eq!(
        events_after,
        events_before + 1,
        "update_config must publish exactly one ConfigUpdatedEvent"
    );
}

#[test]
fn test_get_lock_bounds_matches_deposit_validation() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let (min, max) = (42u32, 4242u32);
    let vault_client = setup(&env, &admin, min, max);

    // The view must return exactly what a deposit validates against.
    assert_eq!(vault_client.get_lock_bounds(), (min, max));

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    // Edge values read from the view are accepted by deposit.
    let (read_min, read_max) = vault_client.get_lock_bounds();
    vault_client.deposit(&user, &token_client.address, &1, &read_min);
    vault_client.deposit(&user, &token_client.address, &1, &read_max);

    // One outside the read bounds is rejected.
    let res = vault_client.try_deposit(&user, &token_client.address, &1, &(read_max + 1));
    assert_eq!(res, Err(Ok(Error::InvalidLockPeriod)));
}
