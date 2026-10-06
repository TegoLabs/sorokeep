# ADR 0003: Global Lock Bounds

## Status

Accepted

## Context

The vault enforces a minimum and maximum lock period for every deposit. These bounds are configured on `VaultConfig` as a single global pair (`min_lock_period`, `max_lock_period`) and apply uniformly to all assets supported by the vault. This decision was made early in the design and the reasoning was never written down. This ADR records the decision, the reasoning behind it, and the concrete signal that would justify revisiting it in favor of per-asset bounds.

## Decision

Lock bounds remain global for v1. There is one `min_lock_period` and one `max_lock_period` for the entire vault, not one pair per asset.

## Rationale

1. **The bounds express a protocol-level policy, not an asset-level one.** The minimum lock exists to discourage flash deposits/withdrawals and to give the vault a predictable duration of capital. The maximum exists to bound the vault's longest-term commitment. Both are properties of the vault as a system, not of any particular asset.

2. **Global bounds keep the config shape simple and auditable.** A global pair is a single invariant that applies to every deposit regardless of asset. There is no per-asset lookup on the deposit path, no risk of a missing entry for a newly added asset, and no ambiguity about which bounds apply when an asset is added or removed.

3. **The complexity is not yet justified by observed need.** No asset has been added to the vault that actually requires different bounds from the global pair. Introducing per-asset bounds before there is a concrete case to serve would be speculative generality.

4. **Per-asset bounds would change the config shape.** The bounds are part of `VaultConfig`, which is persisted on chain. Moving from a global pair to a per-asset map is not a local change; it is a change to the shape of the config type itself.

## Counter-argument

A global bound is a compromise that fits no asset perfectly. A volatile asset and a stablecoin plausibly warrant different minimums. Holders of a stablecoin may be willing to commit for a longer minimum because the opportunity cost of locking is lower and more predictable, while holders of a volatile asset may require a shorter minimum to avoid being forced to stay exposed through large price swings. A single global minimum must therefore be set to the most permissive case, which means it is looser than ideal for the asset that could tolerate a tighter one.

This is a real cost, but it is not yet worth the complexity. The cost of global bounds is a suboptimal but well-defined policy that applies to all assets. The cost of per-asset bounds is an on-chain config shape change, a new asset-lookup path in the deposit logic, and a new class of configuration errors (asset added without bounds, bounds updated while deposits are open). Until an asset actually needs different bounds, the global pair is the better trade.

## Signal to revisit

We will revisit this decision when a concrete asset is added to the vault whose required minimum lock period cannot be satisfied by the global `min_lock_period` without imposing an unacceptable burden on another asset. In practice this means:

- A stablecoin is added and its holders would accept a longer minimum than the global one, but the global minimum cannot be raised without forcing a volatile asset into a longer lock than its holders will accept; or

- A volatile asset is added that needs a shorter minimum than the global one, but the global minimum cannot be lowered without weakening the anti-flash-deposit property for the assets that rely on it.

When either of these occurs, the cost of the global compromise becomes measurable and per-asset bounds become worth the config shape change.

## Migration cost

Introducing per-asset bounds is a change to the shape of `VaultConfig`, not just to its values. The global `(min_lock_period, max_lock_period)` pair would be replaced by a per-asset mapping. Because `VaultConfig` is persisted on chain, this requires a `VaultConfig::V2` once the contract is deployed. The migration would need to read the existing global bounds and seed the per-asset map from them so that existing deposits keep their effective bounds. This is exactly the kind of on-chain state migration that is best undertaken only when the signal above actually occurs.

## Consequences

- Lock bounds are a global pair on `VaultConfig` for v1.
- The deposit path does not need a per-asset bounds lookup.
- Adding an asset does not require configuring new bounds.
- Revisiting this decision requires a `VaultConfig::V2` and a state migration once deployed.
