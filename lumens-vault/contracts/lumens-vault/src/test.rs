#![cfg(test)]
#![allow(deprecated)]

extern crate std;

use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{
    testutils::{storage::Persistent, Address as _, Ledger, MockAuth, MockAuthInvoke},
    Address, BytesN, ConversionError, Env, IntoVal, InvokeError, TryFromVal,
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

/// `env.register` passes constructor arguments directly to `__constructor`.
fn setup(env: &Env, admin: &Address, default_timelock_ledgers: u32) -> LumensVaultClient<'static> {
    let vault_id = env.register(LumensVault, (admin, default_timelock_ledgers));
    LumensVaultClient::new(env, &vault_id)
}

#[test]
fn test_deposit_and_withdraw() {
    let env = Env::default();
    // blanket mock is fine: test is about core deposit/withdraw logic, not access control
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

    // The view reflects the remaining vault state after a partial withdrawal.
    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 50);
}

#[test]
fn test_deposit_rejects_non_positive_amount() {
    // Deposits reject zero and negative amounts before any token transfer.
    let env = Env::default();
    // blanket mock is fine: test is about input validation, not access control
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
    // Withdrawals reject non-positive amounts before mutating the recorded
    // balance; otherwise a negative amount could inflate `entry_v1.amount`
    // through `entry_v1.amount -= amount`.
    let env = Env::default();
    // blanket mock is fine: test is about input validation, not access control
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
    // The user vault counter is refreshed on each deposit. Without this,
    // `UserVaultCount` would archive on its default schedule regardless of
    // how active the user was — silently blocking every
    // future deposit from that user once it did.
    let env = Env::default();
    // blanket mock is fine: test is about storage TTL logic, not access control
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

#[test]
fn test_delisting_blocks_deposits_but_never_traps_existing_funds() {
    // FR-11: An earlier version of this contract had the whitelist check on
    // withdraw as well as deposit, which would have permanently trapped user
    // funds the moment an admin delisted an asset. The fix was to omit the
    // check on withdraw. This test is a permanent regression guard.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);

    // Deposit while whitelisted
    vault_client.add_asset(&token_client.address);
    vault_client.deposit(&user, &token_client.address, &500);

    // Delist the asset
    vault_client.remove_asset(&token_client.address);

    // Assert a new deposit of the delisted asset fails with AssetNotWhitelisted
    let res = vault_client.try_deposit(&user, &token_client.address, &100);
    assert_eq!(res, Err(Ok(crate::contract::Error::AssetNotWhitelisted)));

    // Mature the lock
    env.ledger().with_mut(|l| l.sequence_number += 11);

    // Withdraw successfully
    vault_client.withdraw(&user, &token_client.address, &1, &500);
    assert_eq!(token_client.balance(&user), 1000);
}

#[test]
fn test_every_event_stays_within_topic_ceiling() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);
    let vault_address = vault_client.address.clone();

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);

    vault_client.pause();
    vault_client.unpause();
    vault_client.add_asset(&token_client.address);
    let vault_id = vault_client.deposit(&user, &token_client.address, &100);
    env.ledger().with_mut(|ledger| ledger.sequence_number += 11);
    vault_client.withdraw(&user, &token_client.address, &vault_id, &40);
    vault_client.remove_asset(&token_client.address);
    vault_client.transfer_admin(&new_admin);

    let new_wasm_hash = install_new_wasm(&env);
    vault_client.upgrade(&new_wasm_hash);

    let vault_events: std::vec::Vec<_> = env
        .events()
        .all()
        .into_iter()
        .filter(|(contract_id, _, _)| contract_id == &vault_address)
        .collect();
    let expected_events = [
        ("PauseEvent", 2),
        ("UnpauseEvent", 2),
        ("WhitelistEvent", 2),
        ("DepositEvent", 3),
        ("WithdrawEvent", 3),
        ("DelistEvent", 2),
        ("NewAdminEvent", 2),
        ("UpgradeEvent", 2),
    ];

    assert_eq!(vault_events.len(), expected_events.len());
    for ((event_name, expected_topic_count), (_, topics, _)) in
        expected_events.iter().zip(&vault_events)
    {
        std::println!("{event_name}: topics={topics:?}");
        assert_eq!(
            topics.len(),
            *expected_topic_count,
            "unexpected topic count for {event_name}"
        );
        assert!(topics.len() <= 4, "{event_name} exceeds the 4-topic ceiling");
    }

    let deposit_data: (u32, i128) =
        <(u32, i128)>::try_from_val(&env, &vault_events[3].2).unwrap();
    assert_eq!(deposit_data, (vault_id, 100));
    let withdraw_data: (u32, i128) =
        <(u32, i128)>::try_from_val(&env, &vault_events[4].2).unwrap();
    assert_eq!(withdraw_data, (vault_id, 40));
}

// ---------------------------------------------------------------------
// E05-06 — Pause semantics (FR-5, FR-10, NFR-2).
//
// FR-5 has two halves and both are pinned here:
//
//   1. While paused, deposits and withdrawals are rejected with
//      Error::Paused — even a matured vault cannot be drained, so an
//      admin cannot use a pause to move funds out.
//   2. Pause is a circuit breaker, not a timelock override. It must
//      never change any vault's unlock_ledger, so it can never be a
//      backdoor to early access, and it must never lock funds
//      permanently either — after unpause every vault is exactly where
//      it was, on its original schedule.
//
// Authorization of pause/unpause itself is out of scope (E04-03).
// ---------------------------------------------------------------------

#[test]
fn test_deposit_fails_while_paused() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    vault_client.pause();
    assert!(vault_client.is_paused());

    let res = vault_client.try_deposit(&user, &token_client.address, &100);
    assert_eq!(res, Err(Ok(Error::Paused)));

    // The rejected deposit changed nothing: no tokens left the user, the
    // contract holds nothing, and no vault was created.
    assert_eq!(token_client.balance(&user), 1000);
    assert_eq!(token_client.balance(&vault_client.address), 0);
    assert_eq!(vault_client.get_user_vault_count(&user), 0);
}

#[test]
fn test_withdraw_of_matured_vault_fails_while_paused() {
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

    // Mature the vault: land exactly on unlock_ledger (the inclusive
    // boundary pinned by E05-11), so the timelock alone would allow the
    // withdrawal.
    let unlock_ledger = vault_client
        .get_vault(&user, &token_client.address, &1)
        .unlock_ledger;
    env.ledger()
        .with_mut(|l| l.sequence_number = unlock_ledger);

    vault_client.pause();

    // Paused wins even over a matured vault. This is the half of FR-5
    // that matters for user trust: a pause must not become a drain tool.
    let res = vault_client.try_withdraw(&user, &token_client.address, &1, &100);
    assert_eq!(res, Err(Ok(Error::Paused)));

    // The failed attempt changed nothing — balance neither dropped nor
    // was inflated.
    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 500);
    assert_eq!(entry.unlock_ledger, unlock_ledger);
    assert_eq!(token_client.balance(&user), 500);
    assert_eq!(token_client.balance(&vault_client.address), 500);
}

#[test]
fn test_deposit_and_withdraw_succeed_after_unpause() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    vault_client.pause();
    vault_client.unpause();
    assert!(!vault_client.is_paused());

    // Both operations work again after unpause — a pause must never lock
    // funds permanently.
    let returned_vault_id = vault_client.deposit(&user, &token_client.address, &100);
    assert_eq!(returned_vault_id, 1);

    let unlock_ledger = vault_client
        .get_vault(&user, &token_client.address, &1)
        .unlock_ledger;
    env.ledger()
        .with_mut(|l| l.sequence_number = unlock_ledger);

    vault_client.withdraw(&user, &token_client.address, &1, &100);
    assert_eq!(token_client.balance(&user), 1000);
    assert_eq!(token_client.balance(&vault_client.address), 0);
}

#[test]
fn test_pause_does_not_change_any_vaults_unlock_ledger() {
    // The load-bearing half of FR-5: pause must never be a backdoor to
    // early access. The unlock_ledger recorded at deposit time is the
    // only thing that gates a withdrawal, so a pause/unpause cycle must
    // leave it unchanged for every vault — not just one.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    // Two vaults for the same user, deposited at different ledger
    // sequences so their unlock_ledgers differ.
    vault_client.deposit(&user, &token_client.address, &100);
    env.ledger().with_mut(|l| l.sequence_number += 5);
    vault_client.deposit(&user, &token_client.address, &50);

    let unlock_ledger_vault_1 = vault_client
        .get_vault(&user, &token_client.address, &1)
        .unlock_ledger;
    let unlock_ledger_vault_2 = vault_client
        .get_vault(&user, &token_client.address, &2)
        .unlock_ledger;
    assert_ne!(unlock_ledger_vault_1, unlock_ledger_vault_2);

    // A full pause/unpause cycle must not move either unlock_ledger.
    vault_client.pause();
    assert_eq!(
        vault_client
            .get_vault(&user, &token_client.address, &1)
            .unlock_ledger,
        unlock_ledger_vault_1
    );
    assert_eq!(
        vault_client
            .get_vault(&user, &token_client.address, &2)
            .unlock_ledger,
        unlock_ledger_vault_2
    );

    vault_client.unpause();
    assert_eq!(
        vault_client
            .get_vault(&user, &token_client.address, &1)
            .unlock_ledger,
        unlock_ledger_vault_1
    );
    assert_eq!(
        vault_client
            .get_vault(&user, &token_client.address, &2)
            .unlock_ledger,
        unlock_ledger_vault_2
    );

    // And the original schedule still governs access, unchanged by the
    // pause: vault 1 is at its unlock_ledger and pays out, vault 2 is
    // not and is still rejected with TimelockNotExpired.
    env.ledger()
        .with_mut(|l| l.sequence_number = unlock_ledger_vault_1);
    vault_client.withdraw(&user, &token_client.address, &1, &100);

    let res = vault_client.try_withdraw(&user, &token_client.address, &2, &50);
    assert_eq!(res, Err(Ok(Error::TimelockNotExpired)));

    let entry = vault_client.get_vault(&user, &token_client.address, &2);
    assert_eq!(entry.amount, 50);
    assert_eq!(entry.unlock_ledger, unlock_ledger_vault_2);
    assert_eq!(token_client.balance(&user), 950);
    assert_eq!(token_client.balance(&vault_client.address), 50);
}

// ---------------------------------------------------------------------
// FR-9 regression guard — atomic constructor
//
// FR-9 replaced a two-step deploy+initialize flow with a single `__constructor`
// that runs atomically during deployment. The critical property is that the
// contract can never exist in a state where it has no admin: there is no window
// between "contract deployed" and "admin assigned" that a front-runner could
// exploit by calling `initialize` first and claiming the admin role.
//
// This test pins that property. If a future refactor reintroduces a separate
// `initialize` entry point — even one protected by `require_auth` — it would
// reopen the front-running window and be a CRITICAL regression. This test does
// not cover that deploy-time authorization scenario (that is E06-04's concern);
// it covers the atomicity invariant: all three instance storage keys (Admin,
// State, Config) are present and correct immediately after registration, before
// any other call has been made.
#[test]
fn test_constructor_writes_all_instance_keys_atomically() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let timelock_ledgers: u32 = 42;

    // Register the contract with constructor args. No other call has been made
    // yet — in particular, no deposit exists. This is the state we are testing.
    let vault_client = setup(&env, &admin, timelock_ledgers);

    // 1. Admin key: get_admin_address must return the exact address passed to
    //    the constructor, with no separate initializer call required.
    let stored_admin = vault_client.get_admin_address();
    assert_eq!(
        stored_admin, admin,
        "get_admin_address should return the constructor-supplied admin immediately after deployment"
    );

    // 2. State key: is_paused must be false — the contract is live the moment
    //    it is deployed, not in an uninitialized limbo where is_paused could
    //    panic or return an unexpected value.
    let paused = vault_client.is_paused();
    assert!(
        !paused,
        "is_paused should be false immediately after deployment with no deposits"
    );

    // 3. Config key: the default_timelock_ledgers written by the constructor
    //    must be visible without any additional setup call. We verify this
    //    indirectly via deposit: the vault's unlock_ledger is computed as
    //    `sequence + default_timelock_ledgers`, so if the config key was
    //    missing or wrong the math would be off.
    //
    //    We set up the minimum required scaffolding (one whitelisted asset,
    //    one minted balance) but make no assertion about the deposit itself —
    //    the only thing being checked here is that the timelock comes from the
    //    constructor value, proving Config was written atomically.
    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&admin, &1);
    vault_client.add_asset(&token_client.address);

    let start_ledger = env.ledger().sequence();
    let vault_id = vault_client.deposit(&admin, &token_client.address, &1);

    let entry = vault_client.get_vault(&admin, &token_client.address, &vault_id);
    assert_eq!(
        entry.unlock_ledger,
        start_ledger + timelock_ledgers,
        "unlock_ledger should equal start_ledger + constructor timelock, \
         proving Config was written atomically by __constructor"
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
    // blanket mock is fine: test is about upgrades and migration, not access control
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
// Deposit ordering (#836 / E05-14).
//
// DELIBERATE ORDERING: `deposit` calls `token.transfer` BEFORE writing
// vault state to storage. If the transfer fails (insufficient balance,
// paused token, etc.), the whole transaction reverts and no vault should
// exist. This is the most critical ordering in the contract: a vault
// recorded without the corresponding tokens actually arriving would be
// the worst failure possible.
//
// This test pins that invariant by attempting a deposit with insufficient
// balance and asserting that no vault state was created.
// ---------------------------------------------------------------------

#[test]
fn test_deposit_with_insufficient_balance_creates_no_vault() {
    // #836 / E05-14: Deposit transfers tokens before recording vault state.
    // If the transfer fails, no vault should exist — a vault recorded
    // without tokens arriving is the worst failure this contract could have.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    
    // Mint only 50 tokens, but attempt to deposit 100
    token_asset.mint(&user, &50);
    vault_client.add_asset(&token_client.address);

    let user_balance_before = token_client.balance(&user);
    let vault_balance_before = token_client.balance(&vault_client.address);
    let vault_count_before = vault_client.get_user_vault_count(&user);

    // This must fail because the user has insufficient balance.
    let res = vault_client.try_deposit(&user, &token_client.address, &100);
    assert!(res.is_err(), "Deposit with insufficient balance must fail");

    // CRITICAL: After the failed deposit, no vault should exist and no
    // state should have changed. This proves the transfer happens before
    // state is recorded.
    
    // 1. User vault count unchanged
    let vault_count_after = vault_client.get_user_vault_count(&user);
    assert_eq!(
        vault_count_after, vault_count_before,
        "Vault count must not increment on failed deposit"
    );

    // 2. No vault entry exists (if one was created, this would not panic)
    let vault_lookup = vault_client.try_get_vault(&user, &token_client.address, &1);
    assert!(
        vault_lookup.is_err(),
        "No vault entry should exist after failed deposit"
    );

    // 3. Token balances unchanged — no tokens moved
    assert_eq!(
        token_client.balance(&user),
        user_balance_before,
        "User token balance must be unchanged after failed deposit"
    );
    assert_eq!(
        token_client.balance(&vault_client.address),
        vault_balance_before,
        "Vault contract balance must be unchanged after failed deposit"
    );

    // Positive control: a deposit within the user's balance succeeds,
    // proving the setup is sound and only the insufficient balance caused
    // the earlier failure.
    let success_res = vault_client.deposit(&user, &token_client.address, &50);
    assert_eq!(success_res, 1, "Deposit within balance must succeed");
    
    assert_eq!(vault_client.get_user_vault_count(&user), 1);
    assert_eq!(token_client.balance(&user), 0);
    assert_eq!(token_client.balance(&vault_client.address), 50);
    
    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 50);
}

// ---------------------------------------------------------------------
// Withdraw ordering (#837 / E05-15).
//
// DELIBERATE ORDERING: `withdraw` writes the decremented vault balance to
// storage BEFORE it calls `transfer` to move tokens out. This is not
// incidental. Recording state first means the stored balance never lags
// behind tokens that have already left the vault. Do not reorder these
// two steps.
//
// The tests below pin the observable consequence: stored balance and token
// balances stay mutually consistent on success, and a rejected withdrawal
// (timelock, insufficient balance) moves no tokens and changes no balance.
// ---------------------------------------------------------------------

#[test]
fn test_withdraw_success_keeps_stored_and_token_balances_consistent() {
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

    vault_client.withdraw(&user, &token_client.address, &1, &200);

    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    let user_bal = token_client.balance(&user);
    let vault_bal = token_client.balance(&vault_client.address);

    assert_eq!(entry.amount, 300);
    // Stored balance matches what the vault actually holds.
    assert_eq!(vault_bal, entry.amount);
    assert_eq!(user_bal, 700);
    // No tokens created or destroyed.
    assert_eq!(user_bal + vault_bal, 1000);
}

#[test]
fn test_withdraw_timelock_failure_moves_no_tokens_and_changes_no_balance() {
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

    // Timelock (10 ledgers) has not elapsed.
    let res = vault_client.try_withdraw(&user, &token_client.address, &1, &200);
    assert!(res.is_err());

    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 500);
    assert_eq!(token_client.balance(&user), 500);
    assert_eq!(token_client.balance(&vault_client.address), 500);
}

#[test]
fn test_withdraw_insufficient_balance_moves_no_tokens_and_changes_no_balance() {
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

    // Timelock has elapsed, but the request exceeds the deposited balance.
    let res = vault_client.try_withdraw(&user, &token_client.address, &1, &600);
    assert!(res.is_err());

    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 500);
    assert_eq!(token_client.balance(&user), 500);
    assert_eq!(token_client.balance(&vault_client.address), 500);
}

// Authorization: the asset whitelist.
//
// Whitelisting decides which token contracts `deposit` will call `transfer`
// on, so anyone who can whitelist can point the vault at a contract of their
// choosing. These tests pin down that only the admin can.
//
// How a rejected `require_auth()` actually surfaces in soroban-sdk 28 — this
// is not what you would guess from the contract signature, and it is the
// usual source of confusion when writing auth tests here:
//
//   - A *contract* failure (`Err(Error::AssetNotWhitelisted)` and friends)
//     comes back from `try_*` as `Err(Ok(Error::..))`. The inner `Ok` means
//     "contract code ran and returned a typed error this client understands".
//   - A *missing authorization* is a host error raised before the contract's
//     own error path is reachable, so it comes back as
//     `Err(Err(InvokeError::Abort))` — not an `Error` variant at all, and
//     nothing that could be added to the `Error` enum would change that.
//
// So `assert!(res.is_err())` alone does not distinguish "the caller wasn't
// authorized" from "the contract rejected the argument", which for an auth
// test is the entire claim. The assertions below match the exact shape.
// ---------------------------------------------------------------------

/// What `try_add_asset` / `try_remove_asset` return. The nesting is the
/// client binding's, not this contract's: the outer `Result` is whether the
/// invocation succeeded, the inner `Ok` arm is the decoded return value, and
/// the inner `Err` arm distinguishes a typed contract `Error` from a host
/// `InvokeError`.
type WhitelistCallResult = Result<Result<(), ConversionError>, Result<Error, InvokeError>>;

/// Authorizes exactly one invocation by exactly one address, and nothing else.
///
/// Deliberately not `env.mock_all_auths()`: that makes every `require_auth()`
/// succeed regardless of who signed, which is precisely the condition these
/// tests exist to detect. Passing a non-admin as `signer` is what "a
/// non-admin calls this function" means for an entry point like `add_asset`
/// that takes no caller argument — the signed auth entry is the caller.
fn whitelist_call_as(
    env: &Env,
    vault: &LumensVaultClient,
    signer: &Address,
    fn_name: &'static str,
    asset: &Address,
) -> WhitelistCallResult {
    let invoke = MockAuthInvoke {
        contract: &vault.address,
        fn_name,
        args: (asset.clone(),).into_val(env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: signer,
        invoke: &invoke,
    }];
    let scoped = vault.mock_auths(&auths);
    match fn_name {
        "add_asset" => scoped.try_add_asset(asset),
        "remove_asset" => scoped.try_remove_asset(asset),
        other => panic!("whitelist_call_as does not handle {other}"),
    }
}

/// Asserts a call was authorized and completed. Unwraps both layers of
/// `WhitelistCallResult` so callers don't have to, and so the inner
/// `#[must_use]` decode result isn't silently dropped.
fn assert_authorized(result: WhitelistCallResult, what: &str) {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => panic!("{what} succeeded but its return value failed to decode: {e:?}"),
        Err(Ok(e)) => panic!("{what} was authorized but the contract rejected it: {e:?}"),
        Err(Err(e)) => panic!("{what} failed at the host level: {e:?} — check the mocked auth"),
    }
}

/// Asserts a call failed specifically because authorization was missing,
/// rather than for any other reason. See the block comment above for why
/// this is `Err(Err(Abort))` and not one of the contract's `Error` variants.
fn assert_unauthorized(result: WhitelistCallResult) {
    match result {
        Err(Err(InvokeError::Abort)) => {}
        Err(Ok(e)) => panic!(
            "expected an authorization failure, but the contract returned its own error: {e:?} \
             — that means the call was authorized and failed for a different reason"
        ),
        Err(Err(other)) => panic!("expected InvokeError::Abort, got {other:?}"),
        Ok(_) => panic!("expected an authorization failure, but the call succeeded"),
    }
}

/// Registers a vault and returns it alongside a real token contract address
/// to use as the whitelist subject. The constructor's `admin.require_auth()`
/// is satisfied under `mock_all_auths()`, which is then cleared so that every
/// call under test runs with only the auth it is explicitly given.
fn setup_whitelist_fixture(env: &Env, admin: &Address) -> (LumensVaultClient<'static>, Address) {
    env.mock_all_auths();
    let vault_client = setup(env, admin, 10);

    let token_admin = Address::generate(env);
    let (token_client, _) = create_token_contract(env, &token_admin);
    let asset = token_client.address.clone();

    // From here on, authorization is granted per call via `whitelist_call_as`.
    env.set_auths(&[]);

    (vault_client, asset)
}

#[test]
fn test_admin_can_add_and_remove_asset() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let (vault_client, asset) = setup_whitelist_fixture(&env, &admin);

    assert!(
        !vault_client.is_whitelisted(&asset),
        "an asset should not be whitelisted before the admin adds it"
    );

    assert_authorized(
        whitelist_call_as(&env, &vault_client, &admin, "add_asset", &asset),
        "admin's add_asset",
    );
    assert!(
        vault_client.is_whitelisted(&asset),
        "is_whitelisted should report true after the admin added the asset"
    );

    assert_authorized(
        whitelist_call_as(&env, &vault_client, &admin, "remove_asset", &asset),
        "admin's remove_asset",
    );
    assert!(
        !vault_client.is_whitelisted(&asset),
        "is_whitelisted should report false after the admin removed the asset"
    );
}

#[test]
fn test_add_asset_rejects_non_admin_and_leaves_asset_unlisted() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let (vault_client, asset) = setup_whitelist_fixture(&env, &admin);

    assert!(!vault_client.is_whitelisted(&asset));

    let res = whitelist_call_as(&env, &vault_client, &attacker, "add_asset", &asset);
    assert_unauthorized(res);

    // The point of the test: not merely that the call errored, but that no
    // part of it took effect. A rejected add must leave the asset unlisted,
    // so a later `deposit` still fails with `AssetNotWhitelisted`.
    assert!(
        !vault_client.is_whitelisted(&asset),
        "a rejected add_asset must not whitelist the asset"
    );
    assert_eq!(
        vault_client.get_admin_address(),
        admin,
        "a rejected add_asset must not disturb the admin either"
    );
}

#[test]
fn test_remove_asset_rejects_non_admin_and_leaves_asset_whitelisted() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let (vault_client, asset) = setup_whitelist_fixture(&env, &admin);

    assert_authorized(
        whitelist_call_as(&env, &vault_client, &admin, "add_asset", &asset),
        "admin's add_asset",
    );
    assert!(vault_client.is_whitelisted(&asset));

    let res = whitelist_call_as(&env, &vault_client, &attacker, "remove_asset", &asset);
    assert_unauthorized(res);

    // Again, state rather than the error is the claim: an unauthorized
    // delisting must not be able to block deposits of a legitimate asset.
    assert!(
        vault_client.is_whitelisted(&asset),
        "a rejected remove_asset must leave the asset whitelisted"
    );
    assert_eq!(
        vault_client.get_admin_address(),
        admin,
        "a rejected remove_asset must not disturb the admin either"
    );
}
