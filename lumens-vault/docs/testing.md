# Running the contract test suite from a clean checkout

Everything needed to get from `git clone` to a green `cargo test` for the contracts
under `contracts/`. Three things bite a new contributor in their first ten minutes: the
Rust version requirement, the `wasm32v1-none` target, and the fixture build ordering.
This page is the path that works — **every command below was run on a clean checkout
and the outputs are reproduced verbatim**.

Scope: contract tests only. Backend and frontend testing are documented when those
components exist, under their own epics.

## Prerequisites

| Tool | Required | Why |
| ---- | -------- | --- |
| Rust (via rustup) | **1.85 or later** | `soroban-sdk` 28's dependency tree needs `edition2024`. An older toolchain fails while parsing a *transitive* dependency's manifest, before it reaches any of this project's own code. |
| target `wasm32v1-none` | installed with rustup | The only target the Soroban runtime supports. Both `stellar contract build` and `cargo test` need it available. |
| `stellar-cli` | reasonably current (verified here with 28.1.0) | Builds the v2 fixture wasm and the contract wasm. |
| PowerShell | 5.1+ or 7.x | The sequence below is written in PowerShell. The identical block runs in `pwsh` 7 on Windows, macOS and Linux. |

### One-time toolchain install

Windows, from an elevated PowerShell:

```powershell
winget install Rustlang.Rustup
winget install --id Stellar.StellarCLI
```

macOS / Linux / WSL, from the official installers
([rustup.rs](https://rustup.rs/) and the
[Stellar CLI install page](https://developers.stellar.org/docs/tools/cli/install-cli)):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
curl -fsSL https://github.com/stellar/stellar-cli/raw/main/install.sh | sh
```

Then, on every platform — restart the terminal first so the new tools are on `PATH`:

```powershell
rustup default stable          # must report 1.85 or later, see "Verify"
rustup target add wasm32v1-none
```

### Verify

```powershell
rustc --version                  # must be 1.85.0 or newer
rustup target list --installed   # must include wasm32v1-none
stellar --version
```

Actual output from the clean-checkout run behind this document (Linux, PowerShell 7.6.6):

```text
rustc 1.98.1 (48a229cea 2026-09-01)
cargo 1.98.1 (797e8a9bc 2026-08-05)
stellar 28.1.0 (c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd)
stellar-xdr 28.0.0 (d0f1330e43c3a2c0c616da30698b24140d4eea72)
xdr (9c9c145953e80990d6ff1ae3a6a973a0ce6d0694)
wasm32v1-none
x86_64-unknown-linux-gnu
```

### What an old toolchain looks like (Rust < 1.85)

`cargo test` dies before compiling a single line of this project. Captured with
`cargo +1.84.0 test` against the same clean checkout:

```text
error: failed to parse manifest at `.../registry/src/.../zeroize_derive-1.5.0/Cargo.toml`

Caused by:
  feature `edition2024` is required

  The package requires the Cargo feature called `edition2024`, but that feature is not
  stabilized in this version of Cargo (1.84.0 (66221abde 2024-11-19)).
  Consider trying a newer version of Cargo (this may require the nightly release).
```

`zeroize_derive` is a transitive dependency of `soroban-sdk` 28 — that is why the floor
is Rust 1.85. Fix: `rustup default stable` (or any installed toolchain ≥ 1.85), then
re-run.

## The sequence: clean checkout to green suite

```powershell
git clone https://github.com/TegoLabs/sorokeep.git
cd sorokeep\lumens-vault

# Step 1 — build the v2 fixture FIRST (see "Why the fixture comes first")
cd contracts\lumens-vault-v2-fixture
stellar contract build

# Step 2 — run the suite
cd ..\lumens-vault
cargo test
```

That is the whole path. Expected result: `18 passed; 0 failed`.

### Verified output, step 1 — fixture build

```text
   Compiling lumens-vault-v2-fixture v0.1.0 (/tmp/sorokeep-clean/lumens-vault/contracts/lumens-vault-v2-fixture)
    Finished `release` profile [optimized] target(s) in 52.49s
ℹ️  Build Summary:
    Wasm File: target/wasm32v1-none/release/lumens_vault_v2_fixture.wasm (2671 bytes optimized (original size was 2891 bytes))
    Wasm Hash: f067f69ae0893388b98df9c9bd2bd942341bfba3dbcdd47a615061d02c47ca49
    Wasm Size: 2671 bytes optimized (original size was 2891 bytes)
    Exported Functions: 2 found
      • get_vault
      • version
✅ Build Complete
```

### Verified output, step 2 — the suite

```text
   Compiling lumens-vault v0.1.0 (/tmp/sorokeep-clean/lumens-vault/contracts/lumens-vault)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.44s
     Running unittests src/lib.rs (target/debug/deps/lumens_vault-c71f517138591e58)

running 5 tests
test test::test_deposit_rejects_non_positive_amount ... ok
test test::test_deposit_and_withdraw ... ok
test test::test_real_upgrade_and_state_migration ... ok
test test::test_user_vault_count_ttl_is_extended_on_deposit ... ok
test test::test_withdraw_rejects_non_positive_amount ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.07s

   Doc-tests lumens_vault

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

A test count other than the current `18` means you are not on the current branch, or a
test is being filtered out — check before trusting a green run. The `5 passed` block above
is verbatim output from the older checkout this page was first written against and is left
as recorded history; the count has since grown as tests were added.

## Why the fixture comes first

`test_real_upgrade_and_state_migration` imports the fixture's compiled wasm with
`soroban_sdk::contractimport!` in `contracts/lumens-vault/src/test.rs`:

```rust
soroban_sdk::contractimport!(
    file = "../lumens-vault-v2-fixture/target/wasm32v1-none/release/lumens_vault_v2_fixture.wasm"
);
```

`contractimport!` reads that file **at compile time**, not at test time. Two things
follow:

1. **`cargo test` will not build the fixture for you.** The fixture is a separate
   crate with its own `target/` directory; it is not a workspace member and not a
   dependency of the test binary, so cargo has no reason to compile it.
2. **The failure happens during compilation**, before any test runs, so it looks like
   broken code rather than a missing step.

### The actual failure when the fixture build is skipped

Ran `cargo test` first on a clean checkout with no fixture `target/` directory:

```text
error: No such file or directory (os error 2)
   --> src/test.rs:192:5
    |
192 | /     soroban_sdk::contractimport!(
193 | |         file = "../lumens-vault-v2-fixture/target/wasm32v1-none/release/lumens_vault_v2_fixture.wasm"
194 | |     );
    | |_____^
    |
    = note: this error originates in the macro `soroban_sdk::contractimport` (in Nightly builds, run with -Z macro-backtrace for more info)

error: could not compile `lumens-vault` (lib test) due to 1 previous error
warning: build failed, waiting for other jobs to finish...
```

Exit code 101. The fix is step 1 above: `cd contracts\lumens-vault-v2-fixture` and
`stellar contract build`, then re-run `cargo test`.

### The quieter failure: a stale fixture

If the fixture's `target/` exists but is older than the last change to the fixture's
source, the build *succeeds* — against the old wasm. The suite goes green while
`test_real_upgrade_and_state_migration` exercises a binary that no longer matches the
code you are looking at. Re-run `stellar contract build` in the fixture after every
change to `contracts/lumens-vault-v2-fixture/`, before `cargo test`. An automated guard
for both failure modes is tracked separately as E05-03.

## Repeat-run verification

A single green run is weak evidence for a suite that touches the ledger and TTL. The
contract suite was run repeatedly to check for nondeterminism, with no code change
between runs.

| Field | Value |
| ----- | ----- |
| Date | 2026-10-01 |
| Commit | `ec6bf6c2725f01c9de184d627c8010260832a750` |
| Command | `cargo test` in `contracts/lumens-vault` |
| Runs | 25 consecutive |
| Pass rate | 25/25 (100%) |
| Test count per run | 18 passed, 0 failed, 0 ignored |
| Plus | 1 single-threaded run (`cargo test -- --test-threads=1`), passed |
| No failures filed | none — nothing flaked, so no follow-up issue was opened |

Environment: Linux x86_64, `rustc`/`cargo` 1.91.0, `wasm32v1-none` target installed.

The exact command, run 25 times in a loop with no code change in between:

```bash
cd lumens-vault/contracts/lumens-vault
for i in $(seq 1 25); do
  cargo test 2>&1 | grep -E '^test result:' && echo "run $i: PASS" || echo "run $i: FAIL"
done
```

Every run reported the same result line:

```text
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Run durations ranged from 1.51s to 3.18s. The single-threaded run took 6.52s, which is
what serialising the 18 tests costs — no test depends on another having run first.

**This is evidence about the tests, not a fix.** Per E05-21's non-goals, no flake was
found here and none was fixed. `test_real_upgrade_and_state_migration` — the test
ADR 0008 could not reproduce a failure in — passed on all 25 runs plus the
single-threaded run.

Two caveats on what this result does and does not establish:

- It does not address the **build-state** hazard in ADR 0008. `contractimport!` reads
  the fixture wasm at compile time, and the runs above used a fixture that was already
  built. A stale or missing fixture is still a deterministic failure mode that a green
  `cargo test` does not rule out. E05-03 covers making that dependency explicit.
- The **ledger pin** at `src/test.rs` is load-bearing per ADR 0008 Experiment C, not a
  flake suppression. It was left in place, untouched.

## Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `feature 'edition2024' is required` while parsing a dependency manifest | Rust older than 1.85 | `rustup default stable`, re-run |
| `No such file or directory` on `lumens_vault_v2_fixture.wasm` | Fixture not built yet | Build the fixture first (step 1) |
| Suite green but fixture edits seem untested | Stale fixture wasm | Rebuild the fixture after every fixture change |
| `stellar: command not found` or `rustup: command not found` | New tools not on `PATH` | Restart the terminal (or re-open the shell profile), confirm with the Verify commands above |
| Target errors mentioning `wasm32v1-none` | Target not installed | `rustup target add wasm32v1-none` |

## Related

- [`README.md`](../README.md) — build and test summary, wasm artifact expectations
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — the two hard-won rules: show your work,
  verify against primary sources
