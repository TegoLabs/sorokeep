# Pre-Mainnet Security Checklist

A mainnet release must not proceed until every item below is checked off. Each item names the issue that satisfies it (or is explicitly flagged as not yet having one) and has an explicit pass condition. This checklist is referenced from the project README.

## Checklist

### 1. Live testnet upgrade dry-run with two independent deployments

- **Issue:** #817
- **Pass condition:** Two independent deployments of the upgrade are executed against a live testnet, both reach the expected new contract version, and the resulting on-chain state is identical across both deployments.

### 2. Production admin account with verified medium threshold

- **Issue:** #818
- **Pass condition:** The production admin account is configured on the live network and the medium threshold is verified on-chain to require the expected number of signatures before an admin operation can succeed.

### 3. Event topic counts verified against a real emission

- **Issue:** #819
- **Pass condition:** For each event emitted by the contract, the number of topics observed in a real on-chain emission matches the documented count exactly.

### 4. Sorokeep flags verified live

- **Issue:** Not yet assigned.
- **Pass condition:** The Sorokeep flags are read from the live network and each flag matches the value required by the release configuration.

### 5. Independent security review

- **Issue:** Not yet assigned.
- **Pass condition:** An independent security review is completed, all findings of high or critical severity are resolved or explicitly accepted by the maintainers, and the review report is linked from this checklist.
