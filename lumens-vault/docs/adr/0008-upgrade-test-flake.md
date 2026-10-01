# ADR 0008: Investigating the `test_real_upgrade_and_state_migration` flake

**Status:** Investigation complete. No fix applied (see Non-goals).

**Date:** 2026-09-29

**Issue:** E05-01 (TegoLabs/sorokeep#823)

**Requirements:** G-8, FR-14

**Depends on:** E01-14

---

## Context

`test_real_upgrade_and_state_migration` in
`lumens-vault/contracts/lumens-vault/src/test.rs` was observed to fail once
and then pass on rerun with no code change. That observation is the whole
of the original evidence.

The previous backlog prescribed pinning the ledger sequence as the fix.
That prescription was never tied to a reproduction, and the current state
of the file does not match it: the pin is at sequence `1000`
(`src/test.rs:205`), not the `100_000` the old issue specified. The
project has separately hit a Windows `os error 32` (file in use) failure
while building the v2 fixture wasm, which points at a different cause:
`contractimport!` reads the compiled `.wasm` at **compile time**, not at
test time, so the test's behaviour depends on build state that the test
itself does not control.

Two hypotheses were therefore carried into this investigation:

1. **Build ordering.** The test depends on
   `contracts/lumens-vault-v2-fixture/target/wasm32v1-none/release/lumens_vault_v2_fixture.wasm`
   existing at compile time. A missing, stale, or partially-written wasm
   would make `cargo test` fail before the test runs at all — and the
   failure would look intermittent if the developer rebuilt the fixture
   between runs.
2. **Ledger sequence.** The pin at `src/test.rs:205` sets
   `env.ledger().sequence_number = 1000` before the test body runs.
   Removing or changing it could change the test's outcome if any
   assertion depends on the ledger sequence.

Reproduce first. A fix applied without a reproduction is explicitly not
acceptable for this issue; that is the mistake the old backlog made.

---

## Environment

- OS: Kali Linux (x86_64)
- `rustc` / `cargo`: 1.94.1
- `stellar` CLI: 28.1.0
- Fixture wasm hash (this investigation):
  `9c25df916dd3e7f9cee8076ad89dcb7ec83368193f80e88518f049601860b51e`
  (2764 bytes, optimized from 2975)

---

## Experiments

### Experiment A — Baseline

Fixture built, ledger pin present at `1000`, single run.

**Command**

    cd lumens-vault/contracts/lumens-vault
    cargo test test_real_upgrade_and_state_migration

**Result**

    test test::test_real_upgrade_and_state_migration ... ok
    test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out

Pass. This is the "happy path" state a fresh contributor reaches once
they have followed the comment block at `src/test.rs:20` (build the
fixture first, then run `cargo test`).

---

### Experiment B — Build-ordering reproduction

The fixture's `target/` directory was deleted to simulate a fresh clone
where the fixture has not yet been built. `cargo test` was then run
**without** rebuilding the fixture, twice.

**Commands**

    rm -rf lumens-vault/contracts/lumens-vault-v2-fixture/target
    cd lumens-vault/contracts/lumens-vault
    cargo test test_real_upgrade_and_state_migration   # run 1
    cargo test test_real_upgrade_and_state_migration   # run 2

**Result (identical on both runs)**

    error: No such file or directory (os error 2)
       --> src/test.rs:192:5
        |
    192 | /     soroban_sdk::contractimport!(
    193 | |         file = "../lumens-vault-v2-fixture/target/wasm32v1-none/release/lumens_vault_v2_fixture.wasm"
    194 | |     );
        | |_____^
        |
        = note: this error originates in the macro `soroban_sdk::contractimport`

    error[E0425]: cannot find value `WASM` in module `new_contract`
       --> src/test.rs:198:55

    error[E0433]: failed to resolve: could not find `Client` in `new_contract`
       --> src/test.rs:239:36

    error: could not compile `lumens-vault` (lib test) due to 3 previous errors

**Interpretation**

Deterministic compile-time failure. Not a flake. The failure mode
matches the shape of the project's prior Windows `os error 32` incident:
the build dependency on the fixture wasm is real, hard, and not visible
to anyone who has not read the comment at `src/test.rs:20`.

This confirms hypothesis 1 as a **deterministic** failure mode. It does
not explain a "failed once, passed on rerun with no code change" report
by itself, because a missing fixture fails every subsequent run until
the fixture is rebuilt.

---

### Experiment C — Ledger pin removed, 20 runs

Fixture rebuilt. The pin at `src/test.rs:205` was commented out. The
test was then run 20 consecutive times with no other code change.

**Commands**

    # comment out: env.ledger().with_mut(|l| l.sequence_number = 1000);
    cd lumens-vault/contracts/lumens-vault
    for i in $(seq 1 20); do
      cargo test test_real_upgrade_and_state_migration --quiet 2>&1 \
        | grep -q "test result: ok" && echo "run $i: PASS" || echo "run $i: FAIL"
    done

**Result**

    run 1: FAIL
    run 2: FAIL
    ...
    run 20: FAIL

    PASS: 0
    FAIL: 20

Every failure was the same, deterministic test-time panic (the first
run's full output):

    running 1 test
    test test::test_real_upgrade_and_state_migration ... FAILED

    ---- test::test_real_upgrade_and_state_migration stdout ----

    thread 'test::test_real_upgrade_and_state_migration' (11484) panicked at src/test.rs:247:5:
    assertion failed: migrated.last_touched_ledger > 0
    note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

    failures:
        test::test_real_upgrade_and_state_migration

    test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 4 filtered out

**Interpretation**

The pin is load-bearing. It is not a flake workaround; it is a
prerequisite for the assertion at `src/test.rs:247` to be meaningful.
The causal chain is straightforward:

- The fixture writes `last_touched_ledger: env.ledger().sequence()`
  (`lumens-vault-v2-fixture/src/contract.rs:49`).
- The default `Env::default()` ledger sequence is `0`.
- Therefore `last_touched_ledger == 0` and `assert!(0 > 0)` fails.
- The pin sets `sequence_number = 1000`, making the assertion true.

Removing the pin produces a **deterministic** failure, not a flaky one.
This is the opposite of what the old backlog assumed. The pin is not
suppressing a race; it is providing the value the assertion checks for.

---

### Experiment D — Control: ledger pin present, 20 runs

Fixture built, pin restored at `1000`, 20 consecutive runs.

**Result**

    run 1: PASS
    run 2: PASS
    ...
    run 20: PASS

    PASS: 20
    FAIL: 0

**Interpretation**

With the pin in place, the test passes 20 out of 20 times. There is no
observable nondeterminism in the tested path under either pin state.

---

## Evidence summary

| # | Setup                                  | Runs | Pass | Fail | Failure mode                     |
|---|----------------------------------------|------|------|------|----------------------------------|
| A | Fixture built, pin at 1000             | 1    | 1    | 0    | —                                |
| B | Fixture `target/` deleted, pin at 1000 | 2    | 0    | 2    | Compile-time: `contractimport!`  |
| C | Fixture built, pin removed             | 20   | 0    | 20   | Test-time: `last_touched_ledger` |
| D | Fixture built, pin at 1000             | 20   | 20   | 0    | —                                |

---

## Conclusion

**Which hypothesis does the evidence support?**

Both hypotheses describe real, deterministic failure modes. Neither
reproduces the originally reported "failed once, then passed on rerun
with no code change."

- **Build ordering (hypothesis 1):** supported as a real failure mode.
  Deleting the fixture wasm produces a hard compile error every time.
  This is consistent with the project's prior Windows `os error 32`
  incident and with the fact that `contractimport!` resolves its path at
  compile time. This is a *deterministic* failure, so on its own it
  cannot explain a one-off flake — but it can very easily **look** like
  one to a developer who rebuilt the fixture between their failing run
  and their passing rerun, since the input they changed (build state)
  is invisible to `cargo test`.

- **Ledger sequence (hypothesis 2):** supported as a *correctness
  requirement*, not as a flake fix. Removing the pin causes a
  deterministic test-time failure on the `last_touched_ledger > 0`
  assertion. The pin must stay. It was never suppressing
  nondeterminism, and the old backlog's framing of it as a flake fix is
  not supported by the evidence.

**Was the original flake reproduced?**

No. Under deliberate, controlled conditions the observed failure modes
are both deterministic. The reported "failed once, passed on rerun with
no code change" signature could not be reproduced in this environment.
That is the honest result, and it is recorded here as such.

**Why might the original report have looked like a flake?**

The most likely explanation is a build-state change between the two
runs. Both failure modes examined here depend on inputs the test does
not control:

- The fixture wasm's presence and content (`contractimport!` reads it
  at compile time).
- The starting ledger sequence (set by the pin).

If either input changed between the failing run and the passing rerun —
for example a fixture rebuild triggered by a `cargo clean`, an IDE save,
or a change of working directory that invalidated a cache — the test
would appear to "heal itself" with no visible code change. This is
consistent with the Windows `os error 32` history, where the fixture
build itself is the fragile step.

It is also possible the original report was a genuine one-off that is
no longer present in the current tree, in which case no fix is
warranted and the correct action is to leave the test alone.

---

## Decision

**No fix is applied in this issue.** Per the non-goals for E05-01, a
fix here would repeat the mistake of the old backlog: it would be a
prescription untethered from a reproduction.

The investigation establishes two things that E05-02 and E05-03 should
treat as inputs:

1. **The ledger pin is not a flake fix and must not be removed as one.**
   Its value and its purpose should be documented (or changed with a
   reason), but E05-02 should not remove it on the assumption it was
   suppressing a race.

2. **The build-order dependency is a real, deterministic hazard.** It
   fails opaquely at compile time and matches a failure mode the project
   has already seen in the wild. Making it explicit — a build script
   that fails with a clear message, or a wrapper script that builds the
   fixture first — is the appropriate remedy, and that is E05-03's
   scope, not this one's.

E05-02 should therefore choose a fix that:

- preserves the pin (or changes its value with justification and a
  comment explaining what the pin protects against), and
- does not attempt to "fix the flake" — because no flake was
  reproduced.

## Non-goals (restated)

- Do not apply a fix in this issue.
- Do not remove the ledger pin as a flake workaround; the evidence does
  not support that.

## References

- `lumens-vault/contracts/lumens-vault/src/test.rs` — the test and the
  pin.
- `lumens-vault/contracts/lumens-vault-v2-fixture/src/contract.rs:49` —
  the fixture's `last_touched_ledger` write.
- Issue #823 (E05-01) — this investigation.
- Issue #824 (E05-02) — the fix, informed by this ADR.
- Issue #825 (E05-03) — make the fixture build dependency explicit.
- Stellar docs: [Upgrading contracts](https://developers.stellar.org/docs/build/guides/conventions/upgrading-contracts)

---

## Appendix: raw logs

The following logs were captured during the investigation:

- `/tmp/exp-baseline.log` — Experiment A
- `/tmp/exp-no-fixture.log` — Experiment B (run 1)
- `/tmp/exp-no-fixture-run2.log` — Experiment B (run 2)
- `/tmp/exp-pin-removed.log` — Experiment C
- `/tmp/exp-pin-present.log` — Experiment D

They are not committed here because they are large and reproducible
from the commands above. The relevant excerpts are quoted inline.
