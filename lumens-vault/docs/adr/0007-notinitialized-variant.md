# ADR 0007: Decision on Error::NotInitialized

## Status

Accepted

## Context

The contract defines an `Error::NotInitialized` variant that is returned when one of the three instance-storage entries (`Admin`, `Config`, or `State`) is missing. The contract's `__constructor` runs atomically during deployment and writes all three entries. Therefore it is not obvious whether any reachable execution path can observe a missing instance entry.

NFR-2 requires every `Error` variant to be triggered by a test. A variant that is unreachable cannot satisfy this requirement, so the question of reachability must be resolved explicitly rather than left to fail review later.

This is exactly the class of claim the project has gotten wrong before, so the finding below is based on Stellar documentation rather than reasoning from first principles alone.

## Question

Can any reachable path observe missing instance state? In particular, does instance storage archival and restoration leave the instance entry and its data intact?

## Finding

Unreachable.

The relevant Stellar documentation is the persistent entry lifecycle described in the Soroban documentation on persistent entries and archival.

- Soroban developer docs, Persistent Entries: https://developers.stellar.org/docs/learn/soroban-persistent-entries
- Soroban developer docs, State Archival: https://developers.stellar.org/docs/learn/soroban-state-archival

Key points from those documents:

1. The contract instance entry (the `ContractDataInstance` ledger entry) stores the contract code hash, the contract execution environment, and the contract's instance storage. It is the entry that must exist for any contract call to succeed at all.

2. When a contract instance entry is archived, Sororan moves the entire entry -- including its instance storage -- into the archive. The entry and its data are preserved verbatim.

3. A contract whose instance entry was archived cannot be invoked until it is restored. Attempting to invoke it while archived fails at the host level before any contract code runs; the contract function is never entered and thus never observes missing instance storage.

4. When the instance entry is restored, it is restored with the same data it held before archival. Restoration does not reinitialize the contract or re-run its constructor; it merely reinstates the previously archived entry.

Together these facts mean that the instance entry and the instance storage written by `__constructor` are either both present or both absent from the perspective of running contract code. When the entry is absent, no contract code runs at all, so `Error::NotInitialized` cannot be returned. There is no path by which a contract function executes while one of `Admin`, `Config`, or `State` is missing.

The constructor being atomic at deploy closes the only other window in which a partially initialized instance could exist. There is no external way to delete individual instance storage keys without deleting or archiving the whole instance entry.

## Decision

Remove the `Error::NotInitialized` variant from the contract error enum, and remove the corresponding checks that return it.

Error codes are not renumbered. Removing a variant leaves a gap in the numeric sequence; the remaining variants keep their existing numbers. This preserves the on-chain ABI for all existing error codes and avoids silently changing the meaning of any code already observed by clients.

## Consequences

- NFR-2 is satisfied because every remaining `Error` variant is reachable and can be triggered by a test.
- Error codes for all other variants are unchanged. The numeric value previously assigned to `NotInitialized` is not reused by any other variant.
- Clients that matched on the removed code will no longer receive it, but that code was unreachable in practice, so no real client behavior changes.
- The contract no longer needs the defensive instance-storage reads that only existed to produce this error.

## References

- Soroban Persistent Entries: https://developers.stellar.org/docs/learn/soroban-persistent-entrier
- Soroban State Archival: https://developers.stellar.org/docs/learn/soroban-state-archival
- Requirements G-10, D-9, NFR-2
- Blocked by: #780
