# ADR 0009: Freeze the lumens-vault contract interface

- Status: **DRAFT — blocked on #843, #808, #822.** Do not mark Accepted until the baseline table below is filled from a real build.
- Issue: #845 (E05-22)
- Requirements: NFR-7, FR-14

## Context

The contract milestone (E02–E05) finishes before backend and frontend work begins so that off-chain code is not chasing a moving target. Backend decoders bind to error codes by number, event shapes and function signatures; the frontend binds to function signatures and the unlock-boundary semantics. Any change to these silently breaks a consumer unless the change is visible and deliberate.

The interface is described in [`../contract-interface.md`](../contract-interface.md), which must match the built wasm exactly.

## Decision

From the commit recorded below, the contract interface is **frozen**. The frozen surface is:

- exported functions, argument names/types and return types
- error variants and their numeric codes
- event names, topic layout and data fields
- persisted storage shapes (`DataKey` and the versioned `V1` structs)

**Any change to the frozen surface requires an issue, opened before the change, that explains the impact on backend and frontend consumers.** The issue must state which consumers are affected, what they must change, and whether deployed state or already-decoded events are affected. The PR that makes the change links that issue and updates `contract-interface.md` and this baseline in the same PR.

This is not a prohibition on change. It makes change visible and deliberate.

Existing rules continue to apply: error codes are append-only and never renumbered; stored values change only by adding a new versioned variant.

## Baseline

Produced by running `freeze-baseline.sh` on a clean checkout of the commit below.

| Item | Value |
|---|---|
| Commit | `<FILL: git rev-parse HEAD>` |
| Wasm sha256 | `<FILL>` |
| Wasm size (bytes) | `<FILL>` |
| rustc | `<FILL>` |
| stellar-cli | `<FILL>` |
| soroban-sdk | 28.0.0 (from `Cargo.toml`; confirm against `Cargo.lock`) |
| Build command | `stellar contract build` (run in `lumens-vault/contracts/lumens-vault`) |
| Date | `<FILL>` |

Pre-change size reference from E03-12: 11,447 bytes.

### Evidence

`cargo test` output:

```
<PASTE cargo test output>
```

`stellar contract build` output:

```
<PASTE stellar contract build output>
```

## Consequences

- Backend and frontend can build against `contract-interface.md` with a stable reference.
- A later change to the contract is a reviewed decision with a written impact statement, not a side effect.
- Changing the interface costs an extra issue and doc update. That cost is intended.
- The recorded hash lets later work (deployment verification, CI size comparison) detect drift from the reviewed build.
