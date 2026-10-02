# Contract Interface

This document is the authoritative reference for the Soroban contract's public interface. It lists every exported function and the events the contract emits. It is generated from the contract source and must be kept in sync with the wasm build output.

## Target

- Target triple: `wasm32v1-none` (the only target Soroban runs)
- Build command: `stellar contract build`

## Exported Functions

The following functions are exported from the contract and are callable via the Soroban host. The list must match the exported function list reported by `stellar contract build`.

| Function | Description |
| -------- | ----------- |
| `initialize` | Initialize the contract with the admin address and initial configuration. |
| `get_lock_bounds` | Return the configured lock bounds (`min` and `max`). |
| `set_lock_bounds` | Update the lock bounds. Admin-only. |
| `lock` | Create a lock for a beneficiary within the configured bounds. |
| `unlock` | Release a lock once its unlock conditions are met. |
| `get_lock` | Return the current state of a lock by ID. |
| `get_admin` | Return the current admin address. |

## Events

| Event | Payload |
| ----- | ------- |
| `init` | Admin address and initial lock bounds. |
| `lock_created` | Lock ID, beneficiary, and amount. |
| `lock_released` | Lock ID and beneficiary. |
| `bounds_updated` | Previous and new lock bounds. |

## Wasm Build Record

As part of E03-12, the contract was built for `wasm32v1-none` and the resulting size was recorded against the pre-change baseline of **11,447 bytes**.

| Metric | Value |
| ------ | ----- |
| Pre-change baseline size | 11,447 bytes |
| Post-E02/E03 size | TBD (filled in from the `Stellar CLI contract bild` output) |

The exported function list must include `get_lock_bounds`. If a build does not export it, this document and the contract must be reconciled in the same PR.
