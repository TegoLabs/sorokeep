# ADR 0005: Delisting Storage Lifecycle

## Status

Accepted

## Context

The contract maintains an asset whitelist in instance storage. When an asset is delisted, the current implementation of `remove_asset` writes `false` to the whitelist key instead of deleting it. This means every asset ever delisted permanently occupies space in instance storage.

Instance storage is a single entry with a size limit, shared by admin, config, state and every whitelist key. Unbounded growth in this entry eventually threatens the whole contract. Deleting is cheaper but loses the distinction between "never whitelisted" and "delisted". This ADR decides whether that distinction must be preserved.

## Questions to Resolve

### 1. Can ``is_whitelisted``s callers distinguish "never whitelisted" from "delisted" today?

The contract exposes a single query, `is_whitelisted(asset) > bool`. The current implementation reads the whitelist key and returns the stored boolean, defaulting to `false` when the key is missing. Both a never-whitelisted asset and a delisted asset (whether stored as `false` or deleted) return `false`.

There is no additional query that exposes whether a key exists. Callers therefore cannot distinguish the two states today. The distinction is not observable through the public interface.

### 2. Does anything depend on the distinction?

Auditing the contract and its callers, no code path branches on "was whitelisted before" versus "never whitelisted". The only consumer of the whitelist state is the `is_whitelisted` gate, which treats both cases identically. No event, no audit trail, and no admin query relies on the distinction.

### 3. Instance storage size limit

For the current protocol version, the instance storage entry is bounded by the network's instance entry size limit. Stellar documents the limit as `SORO INSTANCE_ENTRY_SIZE_LIMIT`, which is 64 KB (65536 bytes) for the current protocol version. Source: Stellar Core ledger entry limits and the Soroban environment constant `env.ledger().instance_entry_size_limit()`, which reports 65536 bytes.

This limit is shared by the admin key, the config key, the contract state key, and every whitelist key. Each whitelist key consumes the bytes of its key prefix plus the asset address plus the stored boolean. Leaving delisted keys in place makes this growth monotonically increasing over the contract's lifetime.

## Decision

Delete the whitelist key in `remove_asset` instead of writing `false`.

Justification:

- The distinction between "never whitelisted" and "delisted" is not observable through the public interface and nothing depends on it.
- Deleting keeps instance storage bounded by the number of currently whitelisted assets, not the number ever whitelisted.
- Deleting is cheaper in terms of ledger resources than a write that leaves dead data behind.

If a future requirement needs to distinguish the two states, it must be introduced explicitly (for example, a separate delisted-asset registry or an event-based audit trail) rather than by keeping dead boolean keys in instance storage.

## Consequences

- Instance storage growth from delisting is eliminated.
- `is_whitelisted` continues to return `false` for both never-whitelisted and delisted assets, so caller behaviour is unchanged.
- No migration is required for existing delisted assets stored as `false`; they remain readable as not whitelisted and will be removed on the next delist or cleanup.

## Withdrawal Guarantee (FR-11)

Regardless of this decision, withdrawal of an existing balance in a delisted asset must keep working. This is FR-11 and is non-negotiable.

Delisting removes an asset from the whitelist for new deposits and new activities, but it must not trap funds already accounted for in the contract. The withdrawal path must remain available to accounts holding a balance in the delisted asset, independent of whether the whitelist key is deleted or set to `false`. The chosen implementation must not gate withdrawal on the presence of the whitelist key.

## References

- Requirements G-12, FR-11
- Depends on #780
- Stellar Sororan instance entry size limit: 65536 bytes (64 KB)
