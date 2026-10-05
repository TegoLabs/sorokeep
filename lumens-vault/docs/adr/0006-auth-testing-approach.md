# 0006 – Auth Testing Approach

## Context
The current test suite calls `env.mock_all_auths()` in every test. This globally mocks **all** `require_auth()` calls to succeed, which means that an admin function can have its `admin.require_auth()` call removed entirely and the suite would still pass. This masks missing or broken authorization checks.

## Demonstration
1. Temporarily comment out the `admin.require_auth();` line in the `pause` admin function (`contract.rs`).
2. Run the full test suite – it still reports **All tests passed**.
3. Restore the original line and run the suite again – still **All tests passed**.

The above steps prove that the existing testing approach does not verify that auth checks are present.

## Decision
- **Do not** rely on `env.mock_all_auths()` for auth‑related testing.
- Use explicit mock entries via `env.mock_auths(&[MockAuth { … }])` for each admin function, specifying the required signer address.
- For every guarded function, add:
  - A test that succeeds when the correct admin signer is provided.
  - A test that fails (expecting `Error::MissingAuth`) when the admin signer is omitted or an unauthorized signer is used.

## Consequences
- Test suite will now catch missing or accidental removal of `admin.require_auth()` calls.
- Slightly more boilerplate in tests, but improves security confidence.
- Future ADRs should reference this approach when adding new admin functions.

## References
- Soroban SDK docs – `MockAuth` (v28.0.0)
- Existing tests in `lumens-vault/contracts/lumens-vault/src/test.rs`
