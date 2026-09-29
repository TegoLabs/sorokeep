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

    // New: the view function this pass added actually reflects the state.
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

#[test]
fn test_user_vault_count_ttl_is_extended_on_deposit() {
    // NEW — covers contract.rs change log item 3. Before this fix,
    // `UserVaultCount` was written once on a user's first deposit and never
    // touched again, so it would archive on its own default schedule
    // regardless of how active the user was — silently blocking every
    // future deposit from that user once it did.
    //
    // Still on `mock_all_auths`: untested for authorization, not exempt from
    // it. It is convertible — both deposits are inbound, so `authorize_deposit`
    // covers them — just not this issue's job. See the E04-02 helpers above.
    let env = Env::default();
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
//
// Still on `mock_all_auths`. `upgrade` is admin-guarded and gets its own E04
// test; converting this one as well would bury the migration assertions,
// which are the entire point of it. Authorization for `upgrade` is therefore
// currently untested — a known gap, not an oversight.
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

    let vault_client = setup(&env, &admin, 10, 100);

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
