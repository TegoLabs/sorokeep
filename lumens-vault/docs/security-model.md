# Lumens Vault — Security Model

**Covers:** FR-11, NFR-1  
**Related issues:** #819 (E04-11), #780  
**Status:** VERIFIED against primary sources — do not summarise from memory.

---

## 1. Purpose of this document

This document records the trust assumptions that govern how the vault
interacts with external token contracts. It is not aspirational; it
describes what the current code actually does and why each decision was
made. Read it before whitelisting a new asset or proposing changes to
`deposit` or `withdraw`.

---

## 2. Whitelisting is a trust decision

The vault calls `token::Client::transfer` on whatever contract address the
admin passes to `add_asset`. That means the admin is not just adding a
ticker symbol to a list — they are granting a foreign contract the
ability to execute code inside this transaction.

**The contract cannot validate token behaviour.** It cannot inspect the
token contract's source, verify that its `transfer` implementation is
non-malicious, or place any bound on what side-effects that call might
produce. If a whitelisted token is broken or malicious, the vault has no
defence beyond Soroban's host-level guarantees (see §3).

Concretely, a malicious token contract could, during a call to `transfer`:

- emit misleading events
- call other contracts (subject to Soroban's reentrancy rules — see §3)
- consume budget aggressively, causing the enclosing transaction to run out
  of CPU or memory and trap
- revert, which propagates as an error to the vault and fails the user's
  transaction
- behave differently for different callers, amounts, or ledger states

None of these are hypothetical. Each has been observed in EVM ecosystems
against contracts with equivalent whitelisting designs.

**The admin's whitelisting decision is therefore a security decision, not
an administrative one.** It should be treated with the same care as any
admin key operation.

---

## 3. Soroban's reentrancy stance

The classic reentrancy attack — where a token's `transfer` calls back into
the vault before state has been updated, allowing an attacker to drain
funds — is structurally prevented at the Soroban host level.

Soroban prohibits reentrancy: a contract cannot call itself directly or
indirectly within the same transaction. This is a host-enforced constraint,
not a software guard that an individual contract must remember to add.

> "No reentrancy, eliminating a significant attack vector … Soroban's
> design choice to disallow reentrancy significantly reduces the attack
> surface."
>
> — Stellar Development Foundation,
> [*Soroban: The Smart Contract Platform Designed for Developers*](https://www.stellar.org/blog/developers/soroban-the-smart-contract-platform-designed-for-developers)

The mechanism behind this is confirmed by the LayerZero Stellar technical
documentation, which describes it precisely:

> "Soroban prohibits reentrancy — contracts cannot call themselves
> (directly or indirectly) in the same transaction."
>
> — [LayerZero Stellar Technical Overview — Reentrancy Prohibition](https://docs.layerzero.network/v2/developers/stellar/technical-overview)

This removes the specific attack that motivates the
checks-effects-interactions pattern on EVM. It does **not** remove the
other risks listed in §2 (budget exhaustion, unexpected reverts, arbitrary
cross-contract side-effects outside this vault).

---

## 4. Transfer call ordering in `deposit` and `withdraw`

Even though Soroban's host removes the reentrancy risk, the vault
deliberately follows the checks-effects-interactions pattern anyway. The
transfer to or from the token contract is the last external call in both
functions. This makes the reasoning about correctness local and
unconditional — it does not rely on the host guarantee holding forever.

### 4.1 `deposit`

Order of operations in `deposit` (see `contract.rs`):

1. **Check** — `amount > 0`, contract is not paused, asset is whitelisted.
2. **Effect** — increment `UserVaultCount`, write the new `VaultEntry` to
   persistent storage, extend both entries' TTLs.
3. **Interact** — call `token_client.transfer(&from, &vault_address, &amount)`.

By the time `transfer` is called, every state update the vault is
responsible for is already committed to storage. If the token's `transfer`
panics or reverts, the entire transaction is rolled back atomically by
Soroban — the vault never ends up in a state where storage was updated but
tokens were not moved, or vice versa.

### 4.2 `withdraw`

Order of operations in `withdraw` (see `contract.rs`):

1. **Check** — `amount > 0`, contract is not paused, vault entry exists,
   balance is sufficient, timelock has expired.
2. **Effect** — decrement `entry_v1.amount` and write the updated
   `VaultEntry` back to persistent storage.
3. **Interact** — call `token_client.transfer(&vault_address, &to, &amount)`.

Again, the storage is updated before the external call. If the outgoing
`transfer` fails, the transaction rolls back and the user's vault balance
is restored — no funds are lost.

### 4.3 Why this ordering matters even without reentrancy

On Soroban the ordering does not prevent reentrancy (the host already does
that), but it provides two other properties:

- **Auditability.** A reader can verify the function's correctness without
  reasoning about what the token contract might do during `transfer`. The
  vault's own invariants are established before any foreign code runs.
- **Future-proofing.** If Soroban's reentrancy prohibition were ever
  relaxed in a future protocol version, the vault's ordering would remain
  correct without any code changes. Relying solely on the host guarantee
  would be a hidden dependency on a protocol property that could change.

---

## 5. What an admin should verify before whitelisting an asset

Before calling `add_asset` with a token address, the admin should satisfy
themselves on each of the following points. This list is not exhaustive;
it is the minimum due diligence.

**Source and provenance**

- Is the contract's source code published and verifiable? Can the deployed
  WASM hash be matched against a known build?
- Is it a Stellar Asset Contract (SAC) wrapping a classic Stellar asset, an
  audited third-party token, or an unknown contract? SACs are the most
  trustworthy because their implementation is part of the Stellar protocol
  itself.

**Transfer semantics**

- Does `transfer` revert on failure, or does it return a success/failure
  value silently? The vault assumes revert-on-failure. A token that returns
  `false` on a failed transfer but does not revert will cause the vault to
  record the deposit or release the withdrawal without the tokens actually
  moving.
- Are there transfer fees, hooks, or callbacks? Fee-on-transfer tokens will
  cause the vault to credit a larger balance than it received. Callback
  tokens may invoke arbitrary code mid-transaction.
- Does `transfer` enforce any restrictions (allowlists, pausable, blacklist,
  jurisdiction controls)? A token that can freeze the vault's address would
  permanently trap all funds of that asset.

**Supply and upgrade risk**

- Can the token's admin mint unbounded supply? If so, a compromise of the
  token admin could be used to inflate balances.
- Is the token contract upgradeable? An upgrade could change any of the
  above properties after whitelisting. Track whether the token's upgrade
  key is controlled by a trusted party.

**Liquidity and operational risk**

- Is there a realistic path for users to acquire this asset and to exit it
  back to a liquid market? A whitelisted asset with no market makes user
  funds illiquid for the full lock period.

---

## 6. What this document does not cover

- **Deploy-time authorization of a third-party admin.** That is a deploy
  concern covered in E06-04.
- **An allowlist of specific approved tokens.** The contract deliberately
  has no such list — the admin's judgement is the control, and maintaining
  an on-chain allowlist in this document would drift out of date. This
  document describes the decision framework, not the decisions.
- **Soroban budget exhaustion as an attack surface.** Budget limits are
  enforced by the host before any contract code runs; a contract cannot
  exceed them. They are a denial-of-service risk (a user's transaction
  fails), not a funds-at-risk.
