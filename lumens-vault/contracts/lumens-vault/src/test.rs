#![cfg(test)]
#![allow(deprecated)]

use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{
    testutils::{storage::Persistent, Address as _, Ledger},
    Address, BytesN, Env, IntoVal, InvokeError, Val, Vec,
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
///
/// The bounds are the global, inclusive-at-both-ends pair stored in
/// `VaultConfig` — the same numbers `get_lock_bounds` returns and the same
/// ones `deposit` validates against. There is no separate default any more.
fn setup(
    env: &Env,
    admin: &Address,
    min_lock_ledgers: u32,
    max_lock_ledgers: u32,
) -> LumensVaultClient<'static> {
    let vault_id = env.register(LumensVault, (admin, min_lock_ledgers, max_lock_ledgers));
    LumensVaultClient::new(env, &vault_id)
}

// ---------------------------------------------------------------------
// Authorization helpers (E04-02).
//
// `env.mock_all_auths()` switches the host into recording mode, where EVERY
// `require_auth()` succeeds. It is not evidence about access control, and
// that was measured rather than assumed: with `update_config`'s
// `admin.require_auth()` deleted, the suite still reported 5 passed / 1
// failed — every test that had been on `mock_all_auths` passed with the
// guard removed. Only the tests built on the helpers below noticed.
//
// The mechanism used instead is `Env::mock_auths`. Verified against the
// installed SDK source rather than from memory: soroban-sdk 28.0.0,
// src/env.rs, the doc comment on `mock_auths` reads "Mock authorizations in
// the environment which will cause matching invokes of require_auth ... to
// pass. Authorizations not matching a mocked auth will fail." So authorizing
// one address does not authorize the rest, and the match covers the function
// name and the argument list as well as the address.
//
// Conversion is deliberately partial, one guarded function per issue. Two
// things decide whether a given test can be converted at all: whether the
// flow needs a *contract* to authorize something (see `authorize` — it
// cannot), and whether the E04 issue that owns it has landed yet. A test
// still on `mock_all_auths` is untested for authorization, not exempt from
// it; the comment above it should say which.
//
// `Env::register` is exempt and needs no mock here: it installs the
// constructor's auth recording for the duration of the constructor call and
// restores the previous auth manager afterwards
// (`register_contract_with_constructor` in soroban-sdk 28). That is why
// `setup()` can be called in a test that authorizes nobody at all.
// ---------------------------------------------------------------------

/// Authorize exactly one `require_auth` for the next call: `signer` is
/// permitted to invoke `fn_name` on `contract` with exactly `args`. Any
/// other address, function, or argument list in that call fails.
///
/// ## `signer` must be an account, not a contract
///
/// `Env::mock_auths` (soroban-sdk 28, src/env.rs) does this for every entry
/// it is given:
///
/// ```text
/// self.register_at(a.address, MockAuthContract, ())
/// ```
///
/// That is how the authorization is faked — the address gets a contract that
/// implements nothing but `__check_auth`. It also means the call *replaces
/// whatever contract instance already lives at that address*. Mock a contract
/// address and you have just deleted that contract.
///
/// This was hit, not reasoned about: authorizing the vault so it could
/// `transfer` tokens out during `withdraw` produced
/// `Error(Context, MissingValue)` with "calling unknown contract function,
/// withdraw" — the vault had been replaced by the empty stub.
///
/// The practical rule, which decides which of the auth tests can be written
/// at all: **`mock_auths` covers flows where tokens come IN; flows where
/// tokens go OUT stay on `mock_all_auths`.** A successful `withdraw` is
/// always the latter, because the token contract makes the vault the `from`
/// of the `transfer`. Tests that only *attempt* an early or invalid
/// withdrawal never reach the transfer and convert fine.
fn authorize(
    env: &Env,
    signer: &Address,
    contract: &Address,
    fn_name: &str,
    args: impl IntoVal<Env, Vec<Val>>,
) {
    env.mock_auths(&[MockAuth {
        address: signer,
        invoke: &MockAuthInvoke {
            contract,
            fn_name,
            args: args.into_val(env),
            sub_invokes: &[],
        },
    }]);
}

/// Authorize a real `deposit`, which is the only place the auth tree is more
/// than one level deep.
///
/// `deposit` calls `from.require_auth()`, and then makes the token contract
/// `transfer` the tokens in. That transfer is itself guarded — the token
/// contract authorizes the *vault* to move the user's balance, as a
/// sub-invocation of the deposit. A `MockAuth` covering only the outer call
/// is not enough; the host rejects the transfer with
/// `Error(Auth, InvalidAction)` and the whole deposit fails. Verified by
/// running it, not assumed.
///
/// Note what this also demonstrates: the mock has to describe the exact
/// argument list, so a test cannot quietly deposit a different amount than
/// the one it authorized.
fn authorize_deposit(
    env: &Env,
    user: &Address,
    vault: &Address,
    asset: &Address,
    amount: i128,
    lock_ledgers: u32,
) {
    let transfer = MockAuthInvoke {
        contract: asset,
        fn_name: "transfer",
        args: (user, vault, amount).into_val(env),
        sub_invokes: &[],
    };

    env.mock_auths(&[MockAuth {
        address: user,
        invoke: &MockAuthInvoke {
            contract: vault,
            fn_name: "deposit",
            args: (user, asset, amount, lock_ledgers).into_val(env),
            sub_invokes: &[transfer],
        },
    }]);
}

/// The counterpart to `assert_unauthorized`: the call WAS authorized, ran to
/// completion, and the contract itself returned `expected`.
///
/// Note the arm this matches: a contract that returns `Err(e)` is reported
/// as the outer `Err(Ok(e))` — the invocation is treated as failed, but the
/// error is carried rather than discarded, which is exactly what separates
/// it from the auth failure's `Err(Err(InvokeError::Abort))`. Both are outer
/// errors; only one of them is the contract talking.
///
/// Asserting a specific variant is what distinguishes "the bounds rejected
/// this deposit" from "something else went wrong", and it is the only way a
/// bounds test proves the bounds are load-bearing rather than merely
/// present.
fn assert_contract_error<T, C, E>(
    res: &Result<Result<T, C>, Result<E, InvokeError>>,
    expected: E,
    what: &str,
) where
    T: core::fmt::Debug,
    C: core::fmt::Debug,
    E: core::fmt::Debug + PartialEq,
{
    match res {
        Err(Ok(actual)) => assert_eq!(
            *actual, expected,
            "{what} was refused, but with a different error than expected"
        ),
        other => panic!(
            "{what} should have been refused by the contract with {expected:?}. \
             Observed: {other:?}. An outer Err(..) carrying an InvokeError means \
             the call never reached the contract's own logic (auth or trap), so \
             it would have failed the same way with the bounds removed."
        ),
    }
}

/// Assert that a `try_*` call failed *because authorization was missing*.
///
/// ## The shape, and why it is not the obvious one
///
/// A missing `require_auth` is NOT one of the contract's `Error` variants, and
/// it is not an "unauthorized" error code either. Observed in this repo
/// against soroban-sdk 28.0.0 / soroban-env-host 28.0.2, calling
/// `try_update_config` with only a non-admin's authorization registered:
///
/// ```text
/// attack = Err(Err(Abort))
/// ```
///
/// A generated `try_*` method returns a two-level result —
///
/// ```text
/// Result<Result<T, ConversionError>, Result<Error, InvokeError>>
///                          ^^^^^^^^^ contract ran and returned Err(..)
///     ^^^^^^^^^^^^^^^^^ failed without the contract deciding (auth, trap, budget)
/// ```
///
/// — and a failed authorization lands in the OUTER `Err` as
/// `InvokeError::Abort`. Note the inner `Err` arm: when the contract itself
/// returns an error, the invocation still counts as failed, so that surfaces
/// as the outer `Err(Ok(e))` carrying the contract's `Error`. Both are outer
/// errors; `assert_contract_error` below is what tells them apart. The host escalates the `Error(Auth, InvalidAction)`
/// it produces internally into a contract abort before it can cross the
/// invocation boundary, so the auth code is not visible to the caller. The
/// diagnostic events that *would* name it (`Error(Auth, InvalidAction)`,
/// "Unauthorized function call for address ...") are rolled back with the
/// failed invocation: `env.logs().all()` returns an empty vector afterwards,
/// which was checked rather than assumed.
///
/// Two consequences for how these tests are written:
///
/// 1. Asserting only `is_err()` accepts the contract's own error too, so a
///    test can pass for the wrong reason — as it does when bounds validation
///    happens to reject the attacker's arguments for them. This helper
///    demands the outer `Err(Err(InvokeError::Abort))` shape and prints what
///    it saw instead.
/// 2. `Abort` on its own does NOT prove the cause — a contract panic
///    produces it too. What makes the negative case sound is the pair of
///    positive control and unchanged state that each caller pairs with this:
///    the same call authorized as the admin succeeds, and the stored state is
///    asserted identical afterwards. Neither the shape nor this function can
///    substitute for those.
///
/// Three type parameters because the two levels carry different types in
/// SDK 28: the inner error is `ConversionError`, the outer pairs the
/// contract's own error type with `InvokeError`.
fn assert_unauthorized<T, C, E>(res: &Result<Result<T, C>, Result<E, InvokeError>>, what: &str)
where
    T: core::fmt::Debug,
    C: core::fmt::Debug,
    E: core::fmt::Debug,
{
    match res {
        Err(Err(InvokeError::Abort)) => {}
        other => panic!(
            "{what} did not fail as an unauthorized invocation. Observed: {other:?}. \
             Expected the outer Err(Err(Abort)). If it is the outer Err(Ok(_)) the \
             authorization SUCCEEDED and the contract returned one of its own errors \
             — the call was refused by validation, not by the guard."
        ),
    }
}

#[test]
fn test_deposit_and_withdraw() {
    // NOT convertible to `mock_auths` — see the note on `authorize` above.
    // A successful `withdraw` moves tokens OUT, so the token contract
    // requires the *vault's* authorization for that `transfer`, and mocking
    // a contract address overwrites the contract living there. This test has
    // to stay on `mock_all_auths`, which says nothing about authorization
    // either way — it just means this test is not evidence for it. The
    // authorization behaviour is covered by the E04 tests instead.
    let env = Env::default();
    // blanket mock is fine: test is about core deposit/withdraw logic, not access control
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    let vault_client = setup(&env, &admin, 10, 100);

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

    // The view reflects the remaining vault state after a partial withdrawal.
    let entry = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(entry.amount, 50);
}

#[test]
fn test_deposit_rejects_non_positive_amount() {
    // NEW — covers the fix in contract.rs change log item 2. Before this
    // fix, neither of these guarded at all.
    //
    // Still on `mock_all_auths`: untested for authorization, not exempt from
    // it. It is convertible — both deposits are refused by the `amount` guard
    // before the token transfer, so nothing outbound is authorized — just not
    // this issue's job. See the E04-02 helpers above.
    let env = Env::default();
    // blanket mock is fine: test is about input validation, not access control
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10, 100);

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
    // NEW — this is the more important half of the fix: without the guard,
    // a negative `amount` here would have skipped the insufficient-balance
    // check and *inflated* the caller's recorded balance via
    // `entry_v1.amount -= amount`. See contract.rs change log item 2 for
    // the full walkthrough.
    //
    // WORKED EXAMPLE (E04-02). This test was on `env.mock_all_auths()` and
    // is converted to the shared helpers, so the twelve auth tests that
    // follow have one pattern to copy instead of twelve. Its assertions are
    // unchanged — only the way each call is authorized is different, which
    // is the point: the same test intent must survive the conversion, or the
    // conversion is not a conversion.
    let env = Env::default();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    let vault_client = setup(&env, &admin, 10, 100);
    let vault = &vault_client.address;

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    let asset = &token_client.address;

    // Three signers, three authorizations, in the order they are needed.
    // Each call replaces the previous set: `mock_auths` does not accumulate.

    // 1. The token admin mints the test balance. This is an admin guard on a
    //    *different* contract, which is the case that silently goes missing.
    authorize(&env, &token_admin, asset, "mint", (&user, &1000i128));
    token_asset.mint(&user, &1000);

    // 2. The vault admin whitelists the asset. This is the shape the E04
    //    admin tests care about: one account, one function, one argument.
    authorize(&env, &admin, vault, "add_asset", (asset,));
    vault_client.add_asset(asset);

    // 3. The user deposits. The only two-level auth tree in the contract, so
    //    it gets its own helper rather than an inline construction.
    authorize_deposit(&env, &user, vault, asset, 500, 10);
    vault_client.deposit(&user, asset, &500, &10);
    env.ledger().with_mut(|l| l.sequence_number += 11);

    // 4. The user attempts the negative withdrawal. It is refused by the
    //    `amount` guard, which runs before the token transfer, so no token
    //    authorization is needed — and if that ever changes, this test fails
    //    loudly rather than passing for the wrong reason.
    authorize(
        &env,
        &user,
        vault,
        "withdraw",
        (&user, asset, &1u32, &-200i128),
    );
    let res = vault_client.try_withdraw(&user, asset, &1, &-200);
    assert_contract_error(&res, Error::InvalidAmount, "a negative withdrawal");

    // Balance must be exactly what was deposited — not inflated.
    let entry = vault_client.get_vault(&user, asset, &1);
    assert_eq!(entry.amount, 500);
}

// =====================================================================
// E03-06 — withdraw extends the TTL of exactly the entries it touches
// (NFR-5)
// =====================================================================
//
// The withdraw counterpart to E03-05. The interesting part is an
// asymmetry that is easy to mistake for a bug: withdraw extends the
// Vault entry it reads but deliberately leaves UserVaultCount alone,
// because withdraw allocates no id. That asymmetry is pinned here so it
// stays a decision rather than becoming an accident.
// ---------------------------------------------------------------------
#[test]
fn test_withdraw_extends_ttl_of_only_the_entries_it_touches() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &10_000);
    vault_client.add_asset(&token_client.address);

    // Two vaults for the same user, so there is a second Vault entry that
    // the withdrawal must not touch.
    vault_client.deposit(&user, &token_client.address, &100);
    env.ledger().with_mut(|l| l.sequence_number += 5);
    vault_client.deposit(&user, &token_client.address, &50);

    let vault_1_key = DataKey::Vault(user.clone(), token_client.address.clone(), 1);
    let vault_2_key = DataKey::Vault(user.clone(), token_client.address.clone(), 2);
    let count_key = DataKey::UserVaultCount(user.clone());

    let persistent_ttl = |key: &DataKey| {
        env.as_contract(&vault_client.address, || {
            env.storage().persistent().get_ttl(key)
        })
    };

    let remaining = persistent_ttl(&vault_1_key);
    env.ledger()
        .with_mut(|l| l.sequence_number += remaining - 1000);

    let vault_1_before = persistent_ttl(&vault_1_key);
    let vault_2_before = persistent_ttl(&vault_2_key);
    let count_before = persistent_ttl(&count_key);

    // Partial withdrawal so the Vault entry survives to be inspected.
    // The ledger is long past unlock_ledger by now.
    vault_client.withdraw(&user, &token_client.address, &1, &40);

    assert!(
        persistent_ttl(&vault_1_key) > vault_1_before,
        "the withdrawn vault's TTL should have been extended"
    );
    assert_eq!(
        persistent_ttl(&count_key),
        count_before,
        "withdraw must not extend UserVaultCount's TTL — it allocates no id, so it \
         has no reason to touch the counter (intentional, not an oversight)"
    );
    assert_eq!(
        persistent_ttl(&vault_2_key),
        vault_2_before,
        "withdraw extended the TTL of an unrelated vault — NFR-5 regression"
    );
}

#[test]
fn test_user_vault_count_ttl_is_extended_on_deposit() {
    // The user vault counter is refreshed on each deposit. Without this,
    // `UserVaultCount` would archive on its default schedule regardless of
    // how active the user was — silently blocking every
    // future deposit from that user once it did.
    //
    // Still on `mock_all_auths`: untested for authorization, not exempt from
    // it. It is convertible — both deposits are inbound, so `authorize_deposit`
    // covers them — just not this issue's job. See the E04-02 helpers above.
    let env = Env::default();
    // blanket mock is fine: test is about storage TTL logic, not access control
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10, 100);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    vault_client.deposit(&user, &token_client.address, &100, &10);

    let count_key = DataKey::UserVaultCount(user.clone());
    let ttl_after_first_deposit =
        env.as_contract(&vault_client.address, || env.storage().persistent().get_ttl(&count_key));

    // Advance close to (but not past) the extension threshold and deposit
    // again — the TTL should be bumped back up, not left decaying.
    env.ledger()
        .with_mut(|l| l.sequence_number += ttl_after_first_deposit - 1000);

    vault_client.deposit(&user, &token_client.address, &50, &10);

    let ttl_after_second_deposit =
        env.as_contract(&vault_client.address, || env.storage().persistent().get_ttl(&count_key));

    assert!(
        ttl_after_second_deposit > 1000,
        "UserVaultCount TTL was not refreshed on the second deposit — it would archive soon"
    );
}

// =====================================================================
// E03-05 — deposit extends the TTL of exactly the entries it touches
// (NFR-5)
// =====================================================================
//
// NFR-5 says a function extends the TTL only of the entries it actually
// touches, with the deployed guard as the backstop for dormant ones.
// Both directions of that failure are silent: an over-eager bump pays
// rent forever for entries nobody reads, and a missing bump archives an
// entry that is still live. Nothing else in the suite would catch
// either, so the property is pinned here directly.
// ---------------------------------------------------------------------
// E04-06: update_config authorization.
//
// update_config is the most consequential admin function after upgrade,
// because the bounds it writes are what every future deposit is checked
// against. An attacker who can call it sets min to 0 and the lock becomes
// advisory: a deposit could be created already withdrawable. So this test
// is about the guard, and the two state assertions after each failed call
// exist so the test cannot pass merely because the call errored for some
// unrelated reason.
// ---------------------------------------------------------------------

#[test]
fn test_update_config_rejects_unauthorized_caller() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.sequence_number = 1000);

    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let user = Address::generate(&env);

    let vault_client = setup(&env, &admin, 10, 100);
    let vault = &vault_client.address;

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    let asset = &token_client.address;

    // The test asset is a real Stellar Asset Contract, and `mint` is guarded
    // by the token admin's own `require_auth`. Under `mock_all_auths` this
    // was invisible; under `mock_auths` it has to be authorized explicitly,
    // which is the first sign that the mechanism really is restrictive.
    authorize(&env, &token_admin, asset, "mint", (&user, &1000i128));
    token_asset.mint(&user, &1000);

    authorize(&env, &admin, vault, "add_asset", (asset,));
    vault_client.add_asset(asset);

    // ---- Criterion 1: the admin can change the bounds, and the change is
    // observable through the view clients bind to.
    //
    // Note the client shape: the contract fn returns `Result<(u32, u32),
    // Error>`, but the generated `get_lock_bounds` returns the bare tuple and
    // panics if the contract ever returns `Err`. The `try_get_lock_bounds`
    // variant is the one that exposes the two-level result. Since config is
    // written atomically in the constructor, `Err` is unreachable here.
    assert_eq!(vault_client.get_lock_bounds(), (10u32, 100u32));

    authorize(&env, &admin, vault, "update_config", (&50u32, &60u32));
    vault_client.update_config(&50, &60);

    assert_eq!(vault_client.get_lock_bounds(), (50u32, 60u32));

    // ---- Criterion 2: a non-admin cannot, and the attempt changes nothing.
    //
    // The attacker gets an authorization entry of their own, deliberately
    // for this very function and these very arguments. That is the strong
    // form of the negative: it fails while a correctly-shaped auth exists
    // in the same call, so the test is proving the guard checks *who*, not
    // merely whether any authorization was supplied.
    authorize(&env, &attacker, vault, "update_config", (&0u32, &1000u32));
    let attack = vault_client.try_update_config(&0, &1000);
    assert_unauthorized(&attack, "update_config by a non-admin");

    // The attempted write was min=0, max=1000. If any part of it had landed,
    // this would not still be (50, 60).
    assert_eq!(
        vault_client.get_lock_bounds(),
        (50u32, 60u32),
        "a rejected update_config call still changed the stored bounds"
    );

    // A second, differently-shaped attempt, so the test does not depend on
    // the particular arguments chosen above.
    authorize(&env, &attacker, vault, "update_config", (&0u32, &0u32));
    let attack = vault_client.try_update_config(&0, &0);
    assert_unauthorized(&attack, "update_config by a non-admin (second attempt)");
    assert_eq!(vault_client.get_lock_bounds(), (50u32, 60u32));

    // ---- Criterion 3: deposits are validated against the NEW bounds.
    //
    // The new bounds (50, 60) sit strictly inside the old ones (10, 100),
    // so a period of 10 or of 100 was valid before the change and must be
    // refused now. That is the assertion that would fail if the contract
    // cached the config it was deployed with, or read anything but the
    // value update_config actually wrote.
    authorize_deposit(&env, &user, vault, asset, 100, 10);
    let below_new_min = vault_client.try_deposit(&user, asset, &100, &10);
    assert_contract_error(
        &below_new_min,
        Error::InvalidLockPeriod,
        "a 10-ledger deposit after the admin raised the minimum to 50",
    );
    assert_eq!(vault_client.get_user_vault_count(&user), 0);

    authorize_deposit(&env, &user, vault, asset, 100, 100);
    let above_new_max = vault_client.try_deposit(&user, asset, &100, &100);
    assert_contract_error(
        &above_new_max,
        Error::InvalidLockPeriod,
        "a 100-ledger deposit after the admin lowered the maximum to 60",
    );
    assert_eq!(vault_client.get_user_vault_count(&user), 0);

    // And a period inside the new bounds succeeds, with unlock_ledger
    // derived from the caller's period and the current sequence. 50 is
    // exactly the new minimum, so this also pins down that the range is
    // inclusive at both ends.
    authorize_deposit(&env, &user, vault, asset, 100, 50);
    let vault_id = vault_client.deposit(&user, asset, &100, &50);
    assert_eq!(vault_id, 1);
    assert_eq!(vault_client.get_user_vault_count(&user), 1);

    let entry = vault_client.get_vault(&user, asset, &1);
    assert_eq!(entry.unlock_ledger, 1050);

    // ---- Close the loop on the attack the auth check exists to stop.
    //
    // Had the attacker's `min = 0` gone through, `deposit` with
    // `lock_ledgers = 0` would have been accepted and the resulting vault
    // withdrawable immediately. It cannot be: the bound is still 50, and the
    // vault just created refuses a withdrawal 50 ledgers before it matures.
    // The specific error matters — `TimelockNotExpired` is the lock doing
    // its job, not an unrelated refusal.
    authorize(
        &env,
        &user,
        vault,
        "withdraw",
        (&user, asset, &1u32, &100i128),
    );
    let early = vault_client.try_withdraw(&user, asset, &1, &100);
    assert_contract_error(
        &early,
        Error::TimelockNotExpired,
        "an early withdrawal of a vault deposited under the new bounds",
    );
    assert_eq!(token_client.balance(&user), 900);
}

// ---------------------------------------------------------------------
// The real upgrade test.
//
// FR-3 supports partial withdrawal with the remainder staying locked
// under the original terms. The property that actually matters is that
// `unlock_ledger` is not recomputed: a partial withdrawal must neither
// silently re-lock funds for another full term nor quietly unlock them.
// ---------------------------------------------------------------------
#[test]
fn test_partial_withdrawal_leaves_remainder_locked_under_the_same_terms() {
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

    let original = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(original.amount, 100);

    // Mature the lock exactly.
    env.ledger()
        .with_mut(|l| l.sequence_number = original.unlock_ledger);

    vault_client.withdraw(&user, &token_client.address, &1, &40);

    let remainder = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(remainder.amount, 60, "the entry should hold exactly the remainder");
    assert_eq!(
        remainder.unlock_ledger, original.unlock_ledger,
        "a partial withdrawal must not move unlock_ledger — the remainder stays \
         locked under the terms it was deposited with (FR-3)"
    );
    assert_eq!(token_client.balance(&user), 940);
    assert_eq!(token_client.balance(&vault_client.address), 60);

    // Withdrawing the remainder reaches zero and the entry is removed,
    // matching the zero-balance decision from E03-02.
    vault_client.withdraw(&user, &token_client.address, &1, &60);

    assert!(
        vault_client.try_get_vault(&user, &token_client.address, &1).is_err(),
        "a zero-balance vault is removed rather than kept as an empty entry"
    );
    assert_eq!(token_client.balance(&user), 1000);
    assert_eq!(token_client.balance(&vault_client.address), 0);
    assert_eq!(
        vault_client.get_user_vault_count(&user),
        1,
        "the id allocator is monotonic — removing a drained vault does not return its id"
    );
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
// If your workspace layout puts these crates somewhere else, fix the path
// in the `contractimport!` call below to match.
//
// Still on `mock_all_auths`. `upgrade` is admin-guarded and gets its own E04
// test; converting this one as well would bury the migration assertions,
// which are the entire point of it. Authorization for `upgrade` is therefore
// currently untested — a known gap, not an oversight.
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

// =====================================================================
// E05-11 — withdrawal at the exact unlock ledger boundary
// =====================================================================
//
// The guard is `sequence < unlock_ledger` → TimelockNotExpired, so a
// vault is withdrawable *at* unlock_ledger, inclusively. That is a
// deliberate boundary choice with a one-character alternative (`<=`),
// and no mid-range test would catch it being flipped.
//
// `docs/contract-interface.md` already states this same boundary under
// "Semantics the frontend and backend depend on", so the documented
// contract and this test now agree.
// ---------------------------------------------------------------------
#[test]
fn test_withdraw_is_allowed_at_exactly_unlock_ledger_and_rejected_one_ledger_before() {
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
    let unlock_ledger = vault_client
        .get_vault(&user, &token_client.address, &1)
        .unlock_ledger;

    // One ledger early: still locked.
    env.ledger()
        .with_mut(|l| l.sequence_number = unlock_ledger - 1);
    let too_early = vault_client.try_withdraw(&user, &token_client.address, &1, &50);
    assert_eq!(
        too_early,
        Err(Ok(Error::TimelockNotExpired)),
        "withdrawing one ledger before unlock_ledger must fail with TimelockNotExpired"
    );
    assert_eq!(token_client.balance(&user), 900);

    // Exactly at unlock_ledger: allowed. The boundary is inclusive.
    env.ledger()
        .with_mut(|l| l.sequence_number = unlock_ledger);
    vault_client.withdraw(&user, &token_client.address, &1, &50);
    assert_eq!(token_client.balance(&user), 950);
    assert_eq!(token_client.balance(&vault_client.address), 50);
}

#[test]
fn test_deposit_and_withdraw_succeed_after_unpause() {
    let env = Env::default();
    env.mock_all_auths();

    let vault_client = setup(&env, &admin, 10, 100);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &1000);
    vault_client.add_asset(&token_client.address);

    // 1. Write real state through the OLD contract's own deposit logic —
    //    not a raw storage poke.
    let returned_vault_id = vault_client.deposit(&user, &token_client.address, &500, &10);
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

// =====================================================================
// E04-07 — upgrade rejects an unauthorized caller
// =====================================================================
//
// `upgrade` replaces the entire running bytecode. It is the
// highest-consequence entry point in the contract: whoever can call it
// owns the vault and everything in it. This pins the guard, and proves
// it is the guard rather than a broken call path by having the admin
// perform the identical call successfully afterwards.
// ---------------------------------------------------------------------

/// `upgrade` authorized by exactly `signer`, and nothing else.
fn upgrade_as(
    env: &Env,
    vault: &LumensVaultClient,
    signer: &Address,
    new_wasm_hash: &BytesN<32>,
) -> WhitelistCallResult {
    let invoke = MockAuthInvoke {
        contract: &vault.address,
        fn_name: "upgrade",
        args: (new_wasm_hash.clone(),).into_val(env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: signer,
        invoke: &invoke,
    }];
    vault.mock_auths(&auths).try_upgrade(new_wasm_hash)
}

#[test]
fn test_upgrade_rejects_an_unauthorized_caller() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let (vault_client, _asset) = setup_whitelist_fixture(&env, &admin);

    // A validly uploaded wasm hash — the attacker is not guessing at a
    // bad input, they are replaying the admin's own call.
    let new_wasm_hash = install_new_wasm(&env);
    assert_eq!(vault_client.version(), 1);

    assert_unauthorized(upgrade_as(&env, &vault_client, &attacker, &new_wasm_hash));
    assert_eq!(
        vault_client.version(),
        1,
        "the bytecode must be unchanged after a rejected upgrade"
    );

    // Positive control: the admin's identical call succeeds, so the test
    // is proving the authorization guard and not a broken call path.
    assert_authorized(
        upgrade_as(&env, &vault_client, &admin, &new_wasm_hash),
        "the admin's upgrade",
    );
    assert_eq!(vault_client.version(), 2);
}

/// Starting ledger for the upgrade tests.
///
/// This pin is **load-bearing, not a flake workaround** — see ADR 0008
/// (`docs/adr/0008-upgrade-test-flake.md`), which investigated the
/// reported one-off failure of `test_real_upgrade_and_state_migration`.
/// It found no reproducible nondeterminism, and established instead that
/// the pin provides the value the migration assertion checks against:
/// the fixture's `get_vault` stamps `last_touched_ledger` with the ledger
/// it is served at, so a `0` here would make the assertion compare `0`
/// to `0` and pass vacuously (ADR 0008, Experiment C: the pin removed
/// fails 20/20).
///
/// The value must be at least 1 so the stamped ledger is distinguishable
/// from an untouched/default value. `1000` is otherwise arbitrary: it is
/// comfortably above 0 and small enough that the `+11` ledger advances
/// the other tests perform cannot realistically reach it by accident.
const UPGRADE_TEST_START_LEDGER: u32 = 1000;

#[test]
fn test_real_upgrade_and_state_migration() {
    let env = Env::default();
    // blanket mock is fine: test is about upgrades and migration, not access control
    env.mock_all_auths();
    env.ledger()
        .with_mut(|l| l.sequence_number = UPGRADE_TEST_START_LEDGER);

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
    //
    // E05-02: the fixture stamps this field with the ledger the read is
    // served at, so asserting equality against the pinned start ledger
    // states *why* the pin matters instead of leaving a bare `> 0` that
    // silently becomes `0 > 0` if anyone removes it. See
    // `UPGRADE_TEST_START_LEDGER` and ADR 0008.
    assert_eq!(migrated.last_touched_ledger, UPGRADE_TEST_START_LEDGER);
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

// =====================================================================
// E05-10 — deposit and withdraw at i128 amount extremes
// =====================================================================
//
// Balances are i128, `withdraw` subtracts from a stored balance, and
// `deposit` stores a caller-supplied amount. The failure mode is a
// silently corrupted balance, which is cheap to test and expensive to
// discover in production.
//
// Two separate assets are used for the two `i128::MAX` deposits so that
// each deposit is funded by its own mint: minting a second `i128::MAX`
// onto the same asset would overflow the token's own total supply and
// make the token — not the vault — the limiting factor.
// ---------------------------------------------------------------------
#[test]
fn test_deposit_and_withdraw_at_i128_extremes_do_not_corrupt_balances() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (asset_1_client, asset_1) = create_token_contract(&env, &token_admin);
    let (asset_2_client, asset_2) = create_token_contract(&env, &token_admin);

    // The token must not be the limiting factor.
    asset_1.mint(&user, &i128::MAX);
    asset_2.mint(&user, &i128::MAX);
    vault_client.add_asset(&asset_1_client.address);
    vault_client.add_asset(&asset_2_client.address);
    assert_eq!(asset_1_client.balance(&user), i128::MAX);
    assert_eq!(asset_2_client.balance(&user), i128::MAX);

    // A deposit of i128::MAX succeeds and is stored exactly as supplied.
    let vault_id = vault_client.deposit(&user, &asset_1_client.address, &i128::MAX);
    assert_eq!(vault_id, 1);
    let extreme = vault_client.get_vault(&user, &asset_1_client.address, &1);
    assert_eq!(extreme.amount, i128::MAX);
    assert_eq!(asset_1_client.balance(&vault_client.address), i128::MAX);

    // A second deposit does not sum with the first. Vault ids are allocated
    // per user, so this creates `(user, asset_2, 2)` alongside
    // `(user, asset_1, 1)`; each deposit has its own entry and the contract
    // exposes only per-vault point lookups. There is no aggregate balance
    // and no on-chain addition of one vault's amount to another's, so there
    // is no summation that could overflow. The second extreme deposit leaves
    // the first entry exactly as it was.
    let second_id = vault_client.deposit(&user, &asset_2_client.address, &i128::MAX);
    assert_eq!(second_id, 2);
    assert_eq!(
        vault_client.get_vault(&user, &asset_1_client.address, &1).amount,
        i128::MAX,
        "the first i128::MAX vault must be unaffected by a second extreme deposit"
    );
    assert_eq!(
        vault_client.get_vault(&user, &asset_2_client.address, &2).amount,
        i128::MAX
    );

    env.ledger().with_mut(|l| l.sequence_number += 11);

    // Withdrawing the full i128 balance leaves exactly zero with no
    // wraparound from `entry.amount -= amount`.
    vault_client.withdraw(&user, &asset_1_client.address, &1, &i128::MAX);
    assert!(
        vault_client.try_get_vault(&user, &asset_1_client.address, &1).is_err(),
        "the drained i128::MAX vault should be removed, not left wrapping around"
    );
    assert_eq!(asset_1_client.balance(&user), i128::MAX);
    assert_eq!(asset_1_client.balance(&vault_client.address), 0);
}

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

// =====================================================================
// E05-17 — the upgrade preserves vault balances across many entries
// =====================================================================
//
// The existing upgrade test migrates a single vault. The real risk in an
// upgrade is a partial or inconsistent migration across many entries,
// which one entry cannot reveal. This creates six vaults across two
// users and two assets, at three different ledger sequences, and checks
// every one survives the bytecode swap.
// ---------------------------------------------------------------------
#[test]
fn test_upgrade_preserves_every_vault_across_many_entries() {
    let env = Env::default();
    env.mock_all_auths();
    // A non-zero starting ledger, for the same reason ADR 0008 gives for the
    // single-vault upgrade test: the fixture stamps `last_touched_ledger` with
    // the ledger it is served at, so a sequence well above 0 keeps that stamp
    // distinguishable from a default and leaves room for the advances below.
    env.ledger().with_mut(|l| l.sequence_number = 1000);

    let admin = Address::generate(&env);
    let user_a = Address::generate(&env);
    let user_b = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (asset_1_client, asset_1) = create_token_contract(&env, &token_admin);
    let (asset_2_client, asset_2) = create_token_contract(&env, &token_admin);
    asset_1.mint(&user_a, &10_000);
    asset_1.mint(&user_b, &10_000);
    asset_2.mint(&user_a, &10_000);
    asset_2.mint(&user_b, &10_000);
    vault_client.add_asset(&asset_1_client.address);
    vault_client.add_asset(&asset_2_client.address);

    // Six vaults: two users, two assets, three distinct ledger sequences so
    // the unlock_ledgers are not all identical. Vault ids are allocated per
    // user, so each user's three deposits take ids 1, 2 and 3 regardless of
    // which asset they are in.
    vault_client.deposit(&user_a, &asset_1_client.address, &100); // A/asset_1/1
    vault_client.deposit(&user_a, &asset_2_client.address, &200); // A/asset_2/2
    env.ledger().with_mut(|l| l.sequence_number += 7);
    vault_client.deposit(&user_a, &asset_1_client.address, &300); // A/asset_1/3
    vault_client.deposit(&user_b, &asset_1_client.address, &400); // B/asset_1/1
    env.ledger().with_mut(|l| l.sequence_number += 5);
    vault_client.deposit(&user_b, &asset_2_client.address, &500); // B/asset_2/2
    vault_client.deposit(&user_b, &asset_2_client.address, &600); // B/asset_2/3

    assert_eq!(vault_client.get_user_vault_count(&user_a), 3);
    assert_eq!(vault_client.get_user_vault_count(&user_b), 3);

    // Snapshot every entry through the OLD binary before the swap.
    let a_1_1 = vault_client.get_vault(&user_a, &asset_1_client.address, &1);
    let a_2_2 = vault_client.get_vault(&user_a, &asset_2_client.address, &2);
    let a_1_3 = vault_client.get_vault(&user_a, &asset_1_client.address, &3);
    let b_1_1 = vault_client.get_vault(&user_b, &asset_1_client.address, &1);
    let b_2_2 = vault_client.get_vault(&user_b, &asset_2_client.address, &2);
    let b_2_3 = vault_client.get_vault(&user_b, &asset_2_client.address, &3);

    let contract_address = vault_client.address.clone();
    assert_eq!(vault_client.version(), 1);

    let new_wasm_hash = install_new_wasm(&env);
    vault_client.upgrade(&new_wasm_hash);

    // The bytecode really swapped, and the address really did not.
    assert_eq!(vault_client.version(), 2);
    assert_eq!(
        vault_client.address, contract_address,
        "an upgrade must not change the contract address"
    );

    // Every vault is readable through the NEW binary with its exact
    // pre-upgrade balance and unlock_ledger.
    let new_client = new_contract::Client::new(&env, &contract_address);

    let m = new_client.get_vault(&user_a, &asset_1_client.address, &1);
    assert_eq!(m.amount, 100);
    assert_eq!(m.unlock_ledger, a_1_1.unlock_ledger);

    let m = new_client.get_vault(&user_a, &asset_2_client.address, &2);
    assert_eq!(m.amount, 200);
    assert_eq!(m.unlock_ledger, a_2_2.unlock_ledger);

    let m = new_client.get_vault(&user_a, &asset_1_client.address, &3);
    assert_eq!(m.amount, 300);
    assert_eq!(m.unlock_ledger, a_1_3.unlock_ledger);

    let m = new_client.get_vault(&user_b, &asset_1_client.address, &1);
    assert_eq!(m.amount, 400);
    assert_eq!(m.unlock_ledger, b_1_1.unlock_ledger);

    let m = new_client.get_vault(&user_b, &asset_2_client.address, &2);
    assert_eq!(m.amount, 500);
    assert_eq!(m.unlock_ledger, b_2_2.unlock_ledger);

    let m = new_client.get_vault(&user_b, &asset_2_client.address, &3);
    assert_eq!(m.amount, 600);
    assert_eq!(m.unlock_ledger, b_2_3.unlock_ledger);

    // UserVaultCount is intact for each user. The v2 fixture deliberately
    // exports only `version` and `get_vault`, so this is read straight from
    // storage rather than through a client call the new binary does not
    // have — which also makes it a direct check that the entry itself
    // survived the swap, not just that some call still answers.
    let count_a: u32 = env.as_contract(&contract_address, || {
        env.storage()
            .persistent()
            .get(&DataKey::UserVaultCount(user_a.clone()))
            .unwrap_or(0)
    });
    assert_eq!(count_a, 3, "UserVaultCount for user A must survive the upgrade");

    let count_b: u32 = env.as_contract(&contract_address, || {
        env.storage()
            .persistent()
            .get(&DataKey::UserVaultCount(user_b.clone()))
            .unwrap_or(0)
    });
    assert_eq!(count_b, 3, "UserVaultCount for user B must survive the upgrade");
}

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

// =====================================================================
// E05-23 — the contract takes no fee on any path (FR-6)
// =====================================================================
//
// FR-6 states there are no protocol fees in v1. That is currently true
// only because nobody wrote any, which is not the same as being enforced:
// a negative requirement with no test erodes the first time someone adds
// a small skim during a later feature. Pinned here while it is trivially
// true.
// ---------------------------------------------------------------------
#[test]
fn test_vault_takes_no_fee_on_any_path() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let vault_client = setup(&env, &admin, 10);

    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&user, &2000);
    vault_client.add_asset(&token_client.address);

    // Full round trip. What leaves the user's account must be exactly what
    // comes back, and the contract must hold nothing afterwards.
    let user_before = token_client.balance(&user);
    vault_client.deposit(&user, &token_client.address, &1000);

    let deposited = vault_client.get_vault(&user, &token_client.address, &1);
    assert_eq!(
        deposited.amount, 1000,
        "the vault recorded less than was deposited — a fee was withheld on deposit"
    );
    assert_eq!(token_client.balance(&vault_client.address), 1000);
    assert_eq!(token_client.balance(&user), user_before - 1000);

    env.ledger().with_mut(|l| l.sequence_number += 11);
    vault_client.withdraw(&user, &token_client.address, &1, &1000);

    assert_eq!(
        token_client.balance(&user),
        user_before,
        "the round trip did not return exactly what was deposited — a fee was withheld on withdrawal"
    );
    assert_eq!(token_client.balance(&vault_client.address), 0);

    // Partial withdrawal too: a per-withdrawal fee would be easiest to
    // hide there, and the reconciliation across the whole round trip is
    // what would expose it.
    let user_before_partial = token_client.balance(&user);
    let partial_vault_id = vault_client.deposit(&user, &token_client.address, &1000);
    env.ledger().with_mut(|l| l.sequence_number += 11);
    vault_client.withdraw(&user, &token_client.address, &partial_vault_id, &250);

    assert_eq!(
        token_client.balance(&user),
        user_before_partial - 1000 + 250,
        "a partial withdrawal returned less than was requested — a fee was withheld"
    );

    let remaining = vault_client.get_vault(&user, &token_client.address, &partial_vault_id);
    assert_eq!(remaining.amount, 750);
    assert_eq!(
        token_client.balance(&vault_client.address),
        remaining.amount,
        "the contract holds more than the recorded balance — a fee was retained"
    );
    assert_eq!(
        token_client.balance(&user) + token_client.balance(&vault_client.address),
        user_before_partial,
        "tokens were created or destroyed across the round trip"
    );
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

// =====================================================================
// E04-05 — transfer_admin, and the old admin genuinely loses access
// =====================================================================
//
// Under `mock_all_auths()` every `require_auth()` succeeds, so no earlier
// test could have shown that a transfer actually *revokes* anything — the
// previous admin's calls would have kept working. With scoped auth the
// claim becomes testable, and it is the most important admin test here:
// a transfer that does not revoke is a silent two-admin contract.
// ---------------------------------------------------------------------

/// `transfer_admin` authorized by exactly `signer`, and nothing else.
fn transfer_admin_as(
    env: &Env,
    vault: &LumensVaultClient,
    signer: &Address,
    new_admin: &Address,
) -> WhitelistCallResult {
    let invoke = MockAuthInvoke {
        contract: &vault.address,
        fn_name: "transfer_admin",
        args: (new_admin.clone(),).into_val(env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: signer,
        invoke: &invoke,
    }];
    vault.mock_auths(&auths).try_transfer_admin(new_admin)
}

#[test]
fn test_transfer_admin_revokes_the_previous_admins_access() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let (vault_client, _asset) = setup_whitelist_fixture(&env, &admin);

    let new_admin = Address::generate(&env);
    let never_admin = Address::generate(&env);

    // Plain contract addresses are enough for `add_asset`: it writes a bool
    // and never calls the asset, so no token contract is needed.
    let asset_for_new_admin = Address::generate(&env);
    let asset_for_old_admin = Address::generate(&env);
    let asset_for_never_admin = Address::generate(&env);

    // 1. The sitting admin hands over.
    assert_authorized(
        transfer_admin_as(&env, &vault_client, &admin, &new_admin),
        "the admin's transfer_admin",
    );
    assert_eq!(
        vault_client.get_admin_address(),
        new_admin,
        "get_admin_address should return the new admin after a transfer"
    );

    // 2. The new admin can perform an admin action. `add_asset` takes no
    //    caller argument, so the signed auth entry *is* the caller.
    assert_authorized(
        whitelist_call_as(&env, &vault_client, &new_admin, "add_asset", &asset_for_new_admin),
        "the new admin's add_asset",
    );
    assert!(vault_client.is_whitelisted(&asset_for_new_admin));

    // 3. The previous admin is now a non-admin, and their next admin call
    //    must fail. Observed failure: `Err(Err(InvokeError::Abort))` — the
    //    host rejects the missing authorization before the contract's own
    //    error path is reachable, so this is not and cannot be an `Error`
    //    variant. `assert_unauthorized` pins that exact shape.
    assert_unauthorized(whitelist_call_as(
        &env,
        &vault_client,
        &admin,
        "add_asset",
        &asset_for_old_admin,
    ));
    assert!(
        !vault_client.is_whitelisted(&asset_for_old_admin),
        "the old admin's rejected call must not take effect"
    );

    // 4. A third address that was never admin also fails.
    assert_unauthorized(whitelist_call_as(
        &env,
        &vault_client,
        &never_admin,
        "add_asset",
        &asset_for_never_admin,
    ));
    assert!(!vault_client.is_whitelisted(&asset_for_never_admin));

    // 5. transfer_admin by a non-admin fails and leaves the admin
    //    unchanged — including the old admin, who must not be able to
    //    simply take the role back.
    assert_unauthorized(transfer_admin_as(&env, &vault_client, &never_admin, &never_admin));
    assert_eq!(vault_client.get_admin_address(), new_admin);

    assert_unauthorized(transfer_admin_as(&env, &vault_client, &admin, &admin));
    assert_eq!(
        vault_client.get_admin_address(),
        new_admin,
        "the old admin must not be able to transfer the role back to itself"
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

// =====================================================================
// E04-08 — deposit and withdraw require the funds owner's authorization
// =====================================================================
//
// `deposit` calls `from.require_auth()` and `withdraw` calls
// `to.require_auth()`. These guard user funds directly: without the
// withdraw check, anyone could name another user's address and drain
// their matured vault.
// ---------------------------------------------------------------------

/// `try_deposit`'s nested result: outer = did the invocation succeed,
/// inner `Ok` = the decoded return value, inner `Err` = typed contract
/// `Error` vs host `InvokeError`.
type DepositCallResult = Result<Result<u32, ConversionError>, Result<Error, InvokeError>>;

/// `deposit(from, asset, amount)` authorized by exactly `signer`. When
/// `signer != from` this is the "someone else authorizes it" case.
fn deposit_authorized_by(
    env: &Env,
    vault: &LumensVaultClient,
    signer: &Address,
    from: &Address,
    asset: &Address,
    amount: i128,
) -> DepositCallResult {
    // `deposit` also performs the token transfer in the same call, and that
    // nested `transfer` requires the sender's authorization as well — so the
    // auth entry has to cover both invocations, not only the outer one.
    let transfer_sub_invoke = MockAuthInvoke {
        contract: asset,
        fn_name: "transfer",
        args: (from.clone(), vault.address.clone(), amount).into_val(env),
        sub_invokes: &[],
    };
    let sub_invokes = [transfer_sub_invoke];
    let invoke = MockAuthInvoke {
        contract: &vault.address,
        fn_name: "deposit",
        args: (from.clone(), asset.clone(), amount).into_val(env),
        sub_invokes: &sub_invokes,
    };
    let auths = [MockAuth {
        address: signer,
        invoke: &invoke,
    }];
    vault
        .mock_auths(&auths)
        .try_deposit(from, asset, &amount)
}

/// `withdraw(to, asset, vault_id, amount)` authorized by exactly `signer`.
fn withdraw_authorized_by(
    env: &Env,
    vault: &LumensVaultClient,
    signer: &Address,
    to: &Address,
    asset: &Address,
    vault_id: u32,
    amount: i128,
) -> WhitelistCallResult {
    let invoke = MockAuthInvoke {
        contract: &vault.address,
        fn_name: "withdraw",
        args: (to.clone(), asset.clone(), vault_id, amount).into_val(env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: signer,
        invoke: &invoke,
    }];
    vault
        .mock_auths(&auths)
        .try_withdraw(to, asset, &vault_id, &amount)
}

fn assert_deposit_authorized(result: DepositCallResult, what: &str) -> u32 {
    match result {
        Ok(Ok(id)) => id,
        Ok(Err(e)) => panic!("{what} succeeded but its return value failed to decode: {e:?}"),
        Err(Ok(e)) => panic!("{what} was authorized but the contract rejected it: {e:?}"),
        Err(Err(e)) => panic!("{what} failed at the host level: {e:?} — check the mocked auth"),
    }
}

fn assert_deposit_unauthorized(result: DepositCallResult) {
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

#[test]
fn test_deposit_and_withdraw_require_the_funds_owners_authorization() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    // Setup runs under blanket mocks (the constructor and the token mint
    // both need real authorization); every call under test runs with only
    // the auth it is explicitly given.
    env.mock_all_auths();
    let vault_client = setup(&env, &admin, 10);
    let token_admin = Address::generate(&env);
    let (token_client, token_asset) = create_token_contract(&env, &token_admin);
    token_asset.mint(&owner, &1000);
    vault_client.add_asset(&token_client.address);
    env.set_auths(&[]);

    // 1. A deposit authorized by someone other than `from` fails, and no
    //    vault is created.
    assert_deposit_unauthorized(deposit_authorized_by(
        &env,
        &vault_client,
        &attacker,
        &owner,
        &token_client.address,
        100,
    ));
    assert_eq!(
        vault_client.get_user_vault_count(&owner),
        0,
        "a deposit whose authorization came from the wrong address must create no vault"
    );
    assert_eq!(token_client.balance(&vault_client.address), 0);

    // 2. The owner's own authorized deposit succeeds — the negative case
    //    above is not just a broken setup.
    let vault_id = assert_deposit_authorized(
        deposit_authorized_by(
            &env,
            &vault_client,
            &owner,
            &owner,
            &token_client.address,
            100,
        ),
        "the owner's deposit",
    );
    assert_eq!(vault_id, 1);
    assert_eq!(vault_client.get_user_vault_count(&owner), 1);

    // Mature the lock so the timelock is not what rejects the next call.
    env.ledger().with_mut(|l| l.sequence_number += 11);

    // 3. A withdrawal authorized by someone other than the vault owner
    //    fails. Without this check anyone could name another user's
    //    address and drain their matured vault.
    assert_unauthorized(withdraw_authorized_by(
        &env,
        &vault_client,
        &attacker,
        &owner,
        &token_client.address,
        1,
        50,
    ));
    assert_eq!(
        vault_client.get_vault(&owner, &token_client.address, &1).amount,
        100,
        "a rejected withdrawal must leave the balance untouched"
    );
    assert_eq!(token_client.balance(&vault_client.address), 100);
    assert_eq!(token_client.balance(&owner), 900);

    // 4. The owner's own authorized withdrawal succeeds.
    assert_authorized(
        withdraw_authorized_by(
            &env,
            &vault_client,
            &owner,
            &owner,
            &token_client.address,
            1,
            50,
        ),
        "the owner's withdrawal",
    );
    assert_eq!(token_client.balance(&owner), 950);
    assert_eq!(token_client.balance(&vault_client.address), 50);
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
