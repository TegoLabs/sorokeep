# ADR 0004: What happens to a vault when its balance reaches zero

**Status:** Accepted
**Date:** 2026-09-29
**Deciders:** Lumens Vault maintainers
**Scope:** `lumens-vault/contracts/lumens-vault/src/contract.rs` (`withdraw`, `get_vault`)
**Requirements:** G-11, NFR-5
**Epic:** E03 — Contract: Storage Lifecycle & Correctness (E03-01, closes #797)
**Depends on:** #780 (E01-14, repo baseline)

## Context

`withdraw` currently decrements `VaultEntryV1.amount` and writes the entry
back via `env.storage().persistent().set(...)`, even when the post-withdrawal
balance is exactly zero (G-11, verified against `contract.rs` `withdraw` — no
delete branch).

That leaves a dead `DataKey::Vault(user, asset, vault_id)` entry in persistent
storage forever:

- It still occupies a ledger entry and still accrues rent.
- It still needs periodic TTL extension, otherwise it archives and later
  requires a restore operation before it can be read or written.
- Per NFR-5, TTL extension is scoped to entries a call touches, with
  Sorokeep's guard as the backstop for dormant entries — so every dead vault
  permanently widens the set the guard must track.

For a project whose stated purpose (TECH_SPEC §1) is showcasing storage
lifecycle management — "deliberately structured so its storage profile ... is
a real showcase for Sorokeep's lifecycle monitoring" — accumulating dead
entries is the wrong default.

The alternative is deleting the entry when the balance hits zero. That has its
own consequence, which is why this decision is recorded before any code
changes (non-goal of this issue): the vault id is consumed, and a later
`get_vault(user, asset, vault_id)` returns `VaultNotFound` rather than a
zero-balance entry.

## Decision drivers

- **G-11:** dead entries cost rent and guard attention indefinitely.
- **NFR-5:** contract functions extend TTL only for entries they touch;
  Sorokeep's guard covers the dormant rest. Fewer immortal-but-useless
  entries means a smaller guard working set.
- **NFR-7:** the choice must be recorded with its reasoning and sources,
  not left as an accident of the implementation.
- **FR-4 / FR-17:** vault ids auto-increment per user; the frontend lists
  vaults by replaying `DepositEvent` / `WithdrawEvent`, since the contract
  exposes point lookups only (NFR-6).

## Considered options

### Option A — Keep the zero-balance entry (status quo)

`withdraw` writes back `amount: 0` with the original `unlock_ledger`
unchanged. `get_vault` keeps returning `Ok(VaultEntryV1 { amount: 0, ... })`.

| Dimension | Effect |
|---|---|
| Rent cost | The entry persists indefinitely and keeps accruing rent. Every fully-withdrawn vault is a permanent per-vault cost with no user value. At scale (many users × many vaults over time) this is unbounded dead-state growth in persistent storage. |
| Sorokeep guard load | The dead entry still needs TTL extension to stay live. No contract call will ever touch it again (nothing left to withdraw, and a second full withdraw fails with `InsufficientBalance`), so under NFR-5 it falls permanently onto Sorokeep's guard as a backstop entry. Guard working set grows monotonically with cumulative withdrawals. |
| `get_vault` afterwards | Returns `Ok` with `amount: 0`. Callers see a value that looks like a live vault with nothing in it. |
| "Withdrawn" vs "never existed" | Distinguishable on-chain today: `Ok(amount: 0)` vs `Err(VaultNotFound)`. But the distinction is weak — a zero amount carries no information a client could not get from events, and it invites a misread ("I have a vault" when there is nothing left to withdraw). |

### Option B — Remove the entry when the balance reaches zero (chosen)

When `entry_v1.amount - amount == 0`, call
`env.storage().persistent().remove(&vault_key)` instead of writing the entry
back. Partial withdrawals still write back the remainder with `unlock_ledger`
unchanged.

| Dimension | Effect |
|---|---|
| Rent cost | The ledger entry is deleted, so it stops accruing rent immediately. This is the cheapest steady state: storage held is proportional to live value locked, not to cumulative historical usage. |
| Sorokeep guard load | One fewer entry for the guard to track per fully-withdrawn vault. The guard's working set tracks live vaults (+ `UserVaultCount` counters) rather than all vaults that ever existed. Dormant-but-live vaults are still the guard's job per NFR-5 — this option only stops adding dead ones to that set. |
| `get_vault` afterwards | Returns `Err(VaultNotFound)` (error code 6). The vault id is consumed: it is never reused, and it never resolves to a zero balance again. Callers must treat `VaultNotFound` on a previously-valid id as "fully withdrawn", not as a bug. |
| "Withdrawn" vs "never existed" | **Not distinguishable via `get_vault` alone** — both cases return `VaultNotFound`. This is the real cost of removal. It is mitigated, not eliminated (see below). |

## Decision outcome

**Chosen option: B — remove the persistent `Vault(...)` entry when a
withdrawal brings its balance to exactly zero.**

Rationale:

1. **Lifecycle hygiene is the point of the project.** Keeping immortal
   zero-balance entries contradicts G-11's finding and TECH_SPEC §1's showcase
   goal. Removal makes live storage proportional to live funds.
2. **Rent and guard load both strictly decrease.** Option A pays forever for
   state nobody will ever read again through a contract call; Option B pays
   once (the remove itself) and then nothing.
3. **The `get_vault` ambiguity is acceptable because the display layer does
   not depend on it.** Per FR-17, per-user vault lists and balances are
   reconstructed from contract events (`DepositEvent`, `WithdrawEvent` carry
   `vault_id` and `amount` in data). The event history still shows the vault
   existed, was funded, and was fully withdrawn — so the frontend can display
   "withdrawn / closed" versus "never existed" either way. The backend is a
   best-effort display cache (NFR-4); withdraw eligibility is always decided
   by a live on-chain check, never by the cached list. Losing the on-chain
   `amount: 0` marker therefore does not regress any UI requirement
   (FR-22 operations views included).
4. **Semantics stay clean.** A vault with nothing in it is not a vault; it is
   history. `VaultNotFound` after full withdrawal is honest, and it matches
   the existing error variant rather than requiring a new "empty vault" state.

### Consequences

- **Positive:** dead entries stop accumulating; rent and Sorokeep guard load
  scale with live vaults only.
- **Positive:** no new error variant or schema change — `VaultNotFound`
  (code 6) already covers the post-removal read. Error codes are part of the
  public interface and must not be renumbered (see `contract.rs` header
  invariants).
- **Negative:** `get_vault` alone can no longer distinguish "fully withdrawn"
  from "never existed". Clients that need the distinction must consult event
  history (FR-17 reader) — documented as the intended path, but still a
  second lookup.
- **Neutral:** partial withdrawals are unaffected — the entry survives with
  the exact remainder and identical `unlock_ledger` (FR-3).

### `UserVaultCount` is NOT decremented (normative)

On full withdrawal the `DataKey::UserVaultCount(user)` counter **must not be
decremented, reset, or otherwise modified**. It is a monotonically increasing
id allocator:

- Decrementing it would cause the next `deposit` to reuse a vault id whose
  `Vault(...)` key previously existed, colliding a new vault with a deleted
  one's history and breaking the FR-17 event reconstruction (two different
  vaults sharing one `(user, asset, id)` key over time).
- `withdraw` today deliberately does not touch `UserVaultCount` at all (and
  E03-06 pins that its TTL is not extended there); this decision preserves
  that asymmetry intentionally.
- Implementation rule for E03-02: delete only the `Vault(...)` key, and only
  when the post-withdrawal balance is exactly zero. Never touch
  `UserVaultCount` on the withdraw path.

### Backend / display-layer view

Unaffected either way, by design:

- `DepositEvent { from, asset, vault_id, amount }` and `WithdrawEvent { to,
  asset, vault_id, amount }` are still emitted exactly as today (source:
  `events.rs`, `contract.rs` `deposit` / `withdraw`).
- Replaying them yields the full lifecycle: created → partially withdrawn →
  fully withdrawn (sum of withdrawals equals deposits). A "closed" badge in
  the "my vaults" view (FR-22) is derived from that replay, not from a live
  `get_vault` returning zero.
- Direct `get_vault` remains a point-verification tool (NFR-6), not an
  enumeration source. After removal it correctly reports the entry no longer
  exists.

## Implementation notes for E03-02 (not part of this issue)

- In `withdraw`, after the balance and timelock checks, branch on the
  remainder: if zero, `env.storage().persistent().remove(&vault_key)`; else
  write back as today. The TTL `extend_ttl` already performed on the key
  before the branch is harmless when followed by a remove in the same call.
- The `WithdrawEvent` must still be published on the full-withdrawal path.
- Tests (E03-02 acceptance): full withdrawal → `get_vault` returns
  `VaultNotFound`; partial withdrawal → entry survives with correct remainder;
  `UserVaultCount` unchanged by full withdrawal so the next deposit gets a
  fresh id. No change to `deposit`.
- No code change in this issue (E03-01 non-goal).

## Sources

- `lumens-vault/contracts/lumens-vault/src/contract.rs` — `withdraw` (no
  delete branch), `get_vault` (`VaultNotFound`), `deposit` (`current_count +
  1` allocator, `UserVaultCount` TTL handling).
- `lumens-vault/contracts/lumens-vault/src/storage.rs` — `DataKey::Vault`,
  `DataKey::UserVaultCount`, versioned `VaultEntry`.
- `lumens-vault/contracts/lumens-vault/src/events.rs` — `DepositEvent`,
  `WithdrawEvent` shapes.
- `lumens-vault/docs/TECH_SPEC.md` §§1–3 (showcase goal, FR-4/FR-17, NFR-4/5/6/7).
- `lumens-vault/docs/backlog/REQUIREMENTS.md` — G-11, NFR-5 wordings.
- `lumens-vault/docs/backlog/epics/E03.json` — E03-01/E03-02 acceptance criteria.
