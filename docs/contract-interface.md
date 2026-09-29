# Lumens Vault Contract Interface

This document describes the public interface of the Lumens Vault contract as consumed by the frontend.

## Timelock Semantics

### Withdrawal Unlock Boundary

The vault enforces a timelock on withdrawals:

- A withdrawal is rejected with `TimelockNotExpired` when the current ledger sequence is **strictly less than** the vault's `unlock_ledger.`
- A withdrawal is **allowed** when the current ledger sequence is **greater than or equal to** `unlock_ledger.`

The effective comparison is:

```
sequence < unlock_ledger  => TimelockNotExpired
sequence >= unlock_ledger => allowed
unlock_ledger == sequence => allowed  (inclusive boundary)
```

### Frontend Guidance

The boundary is **inclusive at unlock**. When rendering vault status, the frontend MUST treat a vault as unlocked when the current ledger sequence equals `unlock_ledger.`

- A vault with `unlock_ledger == M` is **locked** for all ledgers `<< M`.
- A vault with `unlock_ledger == M` is **unlocked** at ledger `M` and beyond.

The frontend should not show a vault as locked when the contract would allow the withdrawal. Specifically, when `current_sequence >= unlock_ledger,` the withdraw action must be enabled.

## Errors

| Error                 | Condition                                                 |
|---------------------|---------------------------------------------------------------|
| `TimelockNotExpired` | Current ledger sequence is strictly less than `unlock_ledger`.     |
