# ADR 0002: Edit VaultConfigV1 In Place

## Status

**Decided — precondition recorded, maintainer confirmation still outstanding.**

- Issue: #781 (E02-01)
- Requirements: FR-2, NFR-7
- Depends on: E01-14
- Finding recorded: 2026-09-29, against `main` at `57e8904`

## Context

FR-2 (epic E02) replaces `VaultConfigV1`'s single `default_timelock_ledgers: u32`
field with two fields, `min_lock_ledgers: u32` and `max_lock_ledgers: u32`, while
keeping the enum wrapper as `VaultConfig::V1`.

Editing a persisted type's shape in place is only safe while no deployed instance
exists holding data in the old shape. Soroban decodes a stored entry according to
the type the new code declares, so an old entry read by code expecting a different
shape either fails to decode or decodes into the wrong fields. The alternative —
adding a `VaultConfig::V2` variant and leaving `V1` byte-identical — costs an extra
variant plus a migration path, and is unnecessary if nothing is deployed.

This ADR exists to record which of those two situations applies, and to fix the
rule that governs the choice once it changes.

## Decision

`VaultConfigV1` is edited in place. `VaultConfig` remains a single-variant enum
wrapping `V1`. No `V2` variant is added for the FR-2 change.

This decision is valid **only** because no instance of this contract has ever been
deployed to testnet or mainnet.

## Evidence that nothing is deployed

| Source | Statement |
|---|---|
| `PROJECT_HANDOFF.md` §3 rule 8 | "Never renumber shipped `Error` codes if the contract has been deployed anywhere. **Nothing is deployed today**, so appending is preferred anyway." |
| `PROJECT_HANDOFF.md` §3 rule 9 | "Never mutate `VaultConfigV1`/`VaultEntryV1` in place if any deployed instance exists; add a V2 variant instead. (**Today nothing is deployed**, so Issue 2 may change `VaultConfigV1`. Confirm that assumption first.)" |
| `HANDOFF_ADDENDUM.md` (open items) | "Confirm nothing has been deployed anywhere (Issue 2 edits `VaultConfigV1` in place on that assumption)." |
| `docs/backlog/REQUIREMENTS.md` G-14 | "No issue actually deploys to testnet." The deploy document (`docs/deploy.md`) does not exist yet; it is scheduled by a later E02 issue. |
| Repository contents | No contract ID, deploy script, network configuration or deployment record exists anywhere under `lumens-vault/`. The only contract addresses in the tree are throwaway fixtures under `contracts/lumens-vault/test_snapshots/`. |
| `docs/SYSTEM_DESIGN.md` | `backend/` and `frontend/` are specified but do not exist; there is no deployed-contract configuration to point at. |
| Fixture crate | `contracts/lumens-vault-v2-fixture/` is documented in `PROJECT_HANDOFF.md` §6.6 as "disposable; proves upgrade; **never deployed**". |

Each source is a statement made by the project itself, not an independent
verification against Stellar's ledgers. That is why the confirmation below is
required rather than optional.

## Confirmation

The issue's first acceptance criterion asks for a maintainer to confirm in the
issue thread — not merely in the docs — that the contract has never been deployed.
A confirmation request carrying the evidence table above, plus the one ambiguous
signal below, is included in the PR that adds this ADR so it can be posted to #781.
It could not be posted directly from the environment that prepared this change
(the credentials available there cannot create issue comments), so a maintainer or
the issue assignee has to post it.

**As of 2026-09-29 no maintainer reply on deployment status exists in #781.** Until
that reply lands, this ADR's decision is provisional: it is the correct choice if
the evidence is right, and nothing in the repository contradicts the evidence.

### The one signal that is not self-evident

`lumens-vault/README.md` reads "**Status:** testnet only, not audited, not
deployed to mainnet." This ADR reads that as a statement of the project's target
and scope — it aims at testnet, has not been deployed to mainnet, and the
pre-mainnet conditions are collected under epic E04 — **not** as evidence that a
testnet instance exists. It is called out rather than silently assumed because it
is the only text in the repository that can be read either way. If a testnet
instance does exist, this ADR is wrong and the first consequence below applies.

## Consequences

- **If this ADR is right (the working assumption):** `VaultConfigV1` gains
  `min_lock_ledgers` and `max_lock_ledgers` in place; `VaultConfig::V1` stays the
  only variant; the FR-2 change needs no migration.
- **If this ADR turns out to be wrong:** a `VaultConfig::V2` variant must be added
  instead of editing `V1`. `VaultConfigV1` stays byte-identical to the deployed
  shape, and every read site must handle both variants. Code or tests already
  written against a single-variant `V1` have to be revised, and the state left by
  the mistaken in-place edit has to be migrated — a data migration, not a code
  revert.
- The confirmation in #781 must be answered before this ADR is treated as final.

## The rule for the future

**Once any instance of this contract is deployed — testnet or mainnet — the V1
shapes are frozen.** From that point on:

1. `VaultConfigV1`, `VaultEntryV1` and `VaultStateV1` are no longer edited. A
   change to the shape of a persisted value is expressed by adding a new versioned
   variant (`V2`) and leaving the existing variant byte-identical, so existing
   entries still decode.
2. `Error` codes are never renumbered. New variants are appended — `InvalidLockPeriod = 8`
   (E02-05) is the first example.
3. Removing a variant is itself a breaking change and follows rule 1: it is only
   possible once no entry can still hold the removed shape.

The testnet/mainnet distinction does not weaken this rule. A testnet deployment
creates the same decoding obligation as a mainnet one, and testnet state already
read by a client or indexer is just as real as mainnet state.
