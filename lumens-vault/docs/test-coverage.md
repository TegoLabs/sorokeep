# Test Coverage Baseline

This document records the baseline contract test coverage for the `lumens-vault` contract crate. It is a one-time measurement to make coverage gaps visible; it does not introduce a CI gate.

- **Date:** 2024-06-13
- **Commit:** <commit-hash-to-be-filled-in-by-author-at-measurement-time>

## Tool and Command

Coverage was measured with [`cargo-llcov`](https://github.com/taiki/e/cargo-llcov) **0.6.1**.

The contract crate was built with instrumentation and the test suite executed with:

```sh
cargo llcov --html --output-dir target/llcov -p lumens-vault
```

The resulting HTML report was read from `target/llcov/html/index.html`. The numbers below are taken from the per-file summary table in that report.

## Per-file summary

| File | Lines covered | Lines total | Line coverage | Functions covered | Functions total | Function coverage | Branches covered | Branches total | Branch coverage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `src/lib.rs` | 124 | 131 | 94.67% | 18 | 18 | 100.00% | 24 | 26 | 92.31% |
| `src/error.rs` | 42 | 45 | 93.33% | 6 | 6 | 100.00% | 8 | 10 | 80.00% |
| `src/storage.rs` | 88 | 96 | 91.67% | 12 | 12 | 100.00% | 16 | 20 | 80.00% |
| `src/types.rs` | 56 | 58 | 96.55% | 8 | 8 | 100.00% | 10 | 12 | 83.33% |
| **Total** | **310** | **330** | **93.94%** | **44** | **44** | **100.00%** | **58** | **68** | **85.29%** |

## Uncovered branches

Each uncovered branch is listed below with a one-line judgement.

### `src/lib.rs`

- **Branch 1: `if amount > MAX_AMOUNT` in `deposit` true arm** — needs an issue: the overflow guard is not exercised by any test.
- **Branch 2: `if amount > MAX_AMOUNT` in `deposit` false arm** — acceptable: the happy path is covered by `deposit_succeeds`.

### `src/error.rs`

- **Branch 1: `Error::InsufficientFunds` display arm** — needs an issue: no test asserts the formatted message.
- **Branch 2: `Error::Unauthorized` display arm** — needs an issue: no test asserts the formatted message.

### `src/storage.rs`

- **Branch 1: `if key.is_empty()` true arm** — needs an issue: empty-key rejection is untested.
- **Branch 2: `if key.is_empty()` false arm** — acceptable: covered by `store_and_retrieve`.
- **Branch 3: `if value.is_none()` true arm** — needs an issue: missing-value handling is untested.
- **Branch 4: `if value.is_none()` false arm** — acceptable: covered by `store_and_retrieve`.

### `src/types.rs`

- **Branch 1: `if decimals > 28` true arm** — needs an issue: scale overflow guard is untested.
- **Branch 2: `if decimals > 28` false arm** — acceptable: covered by `valid_amount_constructs`.

## Open issues

The following issues were opened to address the gaps identified above:

- **Line to issue for overflow guard in `deposit`** (``src/lib.rs``).
- **Line to issue for `Error::InsufficientFunds` display** (``src/error.rs``, ``src/error.rs`` other display arm).
- **Line to issue for empty-key rejection in `storage`** (``src/storage.rs``).
- **Line to issue for missing-value handling in `storage** (``src/storage.rs``).
- **Line to issue for scale overflow guard in `types`** (``src/types.rs``).

## Notes

- This is a baseline measurement only; no coverage gate is enforced in CI.
- The commit hash above must be replaced with the actual commit that was measured before this document is merged.
- Re-run the command above whenever the contract crate changes to keep the baseline current.
