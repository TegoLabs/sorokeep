# ADR 0001: Whether `test_snapshots/` is committed or ignored

**Date:** 2026-10-01
**Status:** Accepted
**Issue:** #770

## Context

`soroban-sdk` (pinned to `28.0.0` in `Cargo.toml`) writes a snapshot file under
`test_snapshots/` at the end of every test that creates a `soroban_sdk::testutils::Env`.
The write happens in `Env::drop`, so a snapshot is a by-product of *running* a test, not of
compiling one — `cargo test --no-run` writes nothing.

There are currently 18 tests in `src/test.rs` and 15 matching snapshot files in
`test_snapshots/test/`, one per test (`<test_fn_name>.1.json`). The three tests without a
committed snapshot are the ones added after this decision was first drafted; running
`cargo test` writes them, and they are picked up by the next test change. No test asserts
that the snapshot files are unchanged, so they are read by nothing in the suite.

The tradeoff is that committing them keeps a reviewable record of the contract's observable
behaviour, at the cost of diff churn whenever that behaviour legitimately changes.

## Decision: commit

`test_snapshots/` stays tracked in version control. No ignore rule is added.

This follows the upstream guidance for the tool we depend on. `soroban-sdk` documents
`Env::to_test_snapshot_file` as the way to "record the observable behavior of a test, and
changes to that behavior over time", and directs you to "commit the test snapshot file to
version control and watch for changes in it on contract change, SDK upgrade, protocol
upgrade, and other important events."

For a contract with storage, TTL, auth and upgrade-migration tests, the snapshot diff is the
cheapest available review signal: when someone changes the contract or bumps the SDK, the
diff shows exactly which ledger entries, events and authorization invocations moved. Losing
that signal to keep the diff smaller would trade away the reason snapshots exist.

### Regenerated diffs are expected

Committing snapshots means `cargo test` can produce snapshot changes. That is the intended
signal, not noise to be suppressed:

- A test or contract change that alters observable behaviour **should** show up as a
  snapshot diff, and the reviewer should read it.
- An SDK or protocol upgrade rewrites snapshots broadly. Expect a large diff on those
  commits; confirm it is SDK-level churn and behaviour-preserving rather than reverting it.
- Regeneration is driven by `cargo test`. Note that `test_real_upgrade_and_state_migration`
  imports the v2 fixture WASM, so the fixture must be built (`stellar contract build`) before
  the suite compiles.

Never hand-edit a snapshot to make a diff go away. If a snapshot is wrong, the test or the
contract is wrong.

## Tradeoff considered

- **Commit snapshots.** Pro: the diff is a real review signal for observable behaviour on
  contract and SDK changes, which is the point of the feature. Con: broader diffs on SDK and
  protocol upgrades, and a small risk that a reviewer skims past a behavioural change.
- **Ignore snapshots.** Pro: a permanently clean `git status` and smaller diffs. Con: the
  behavioural-change signal disappears entirely, and a regeneration that genuinely changed
  behaviour would go unnoticed. The cleanliness is cosmetic; the lost signal is not.

Committing is chosen. The diff size is a one-off cost per SDK bump, while the lost signal
would apply to every contract change indefinitely.

## Consequences

- `lumens-vault/contracts/lumens-vault/.gitignore` intentionally does **not** list
  `test_snapshots/`. It only ignores `target/`.
- Snapshot changes belong in the same commit as the test or contract change that produced
  them, so the reviewer sees cause and effect together.

## See also

- #769 removes the stale duplicate `test/` snapshot directory. Independent of this decision;
  the SDK writes to `test_snapshots/` only.