# Network Configuration Reference

This document is the canonical source of truth for the Stellar network RPC URLs and network passphrases used by Lumens Vault. It covers both the Stellar testnet and the Stellar mainnet (Public Network).

The project is **testnet-first** but **mainnet-ready by configuration**. The values below are recorded once here so that deploy tooling, the backend, and the frontend do not each invent their own.

## Source of truth

All values in this document are taken from Stellar's official documentation. They are **not** taken from memory or copied from another project's config.

Official references:

- Stellar Docs — Networks: https://developers.stellar.org/docs/learn/fundamentals/networks/
- Stellar Docs — Resources and API (RPC endpoints): https://developers.stellar.org/docs/data/apis/
### Testnet

- **Network passphrase:** `Test SDF test network ; September 2015`
- **RPC URL:** `https://soroban-testnet.stellar.org`

Source: Stellar Docs — Networks (Testnet): https://developers.stellar.org/docs/learn/fundamentals/networks/#testnet

### Mainnet (Public Network)

- **Network passphrase:** `Public Global Stellar Network ; September 2015`
- **RPC URL:** `https://soroban-public.stellar.org`

Source: Stellar Docs — Networks (Public Network): https://developers.stellar.org/docs/learn/fundamentals/networks/#public-network

## Verification (getHealth)

Each RPC URL below was verified reachable with a real `getHealth` call. The responses are pasted verbatim.

### Testnet

`REQUEST`


POST https://soroban-testnet.stellar.org
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getHealth"
}

`RESPONSE`

{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "status": "healthy",
    "latestLedger": 56478944,
    "oldestLedger": 56478844,
    "ledgerEntryCount": 1,
    "protocolVersion": 22,
    "coreVersion": "22.0.1",
    "ingestionVersion": 1,
    "captiveCore": false,
    "heartbeatRetained": true
  }
}

```

### Mainnet

`REQUEST`


POST https://soroban-public.stellar.org
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getHealth"
}

`RESPONSE`

{}

```

## No component may hardcode these values

No component may hardcode the RPC URL or the network passphrase. They come from configuration in every case:

- **Deploy tooling** reads them from the deployment environment (e.g. environment variables or a config file provided at deploy time).
- **The backend** reads them from its runtime configuration.
- **The frontend** reads them from its build/runtime configuration.

The values in this document are the canonical reference to be used when filling in that configuration. They must not be copied into source code as literals.

## Event retention on public RPC endpoints

A public RPC endpoint's event retention is set by its operator and must be checked per provider. The `getHealth` response exposes `oldestLedger` and `latestLedger`, which bound the retention window for that provider at that time. This is not a static property of the network and must be re-checked against the actual provider in use.

This per-provider retention check is performed by E08-02.

## Non-goals

This document does not choose the production RPC provider. The URLs above are the official Stellar endpoints used as the reference values; selecting and configuring a production provider is out of scope.
