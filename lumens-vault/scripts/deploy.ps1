# Requirements: FR-9, G-14, D-6
# E06-02: Testnet deploy script for the Lumens Vault contract.
#
# The contract must be deployed with the admin, min_lock_ledgers and
# max_lock_ledgers constructor arguments passed at deploy time. There is
# no separate initialize call -- reintroducing one would restore the
# front-running vulnerability FR-9 closed.
#
# PowerShell 7 syntax throughout. No mainnet path in this script.

Clear-Host

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# -----------------------------------------------------------------------------
# Required environment variables
# -----------------------------------------------------------------------------
# The deploying key is read from an environment variable by name.
# No secret appears in this script, in a default value, or in any echoed output.

$requiredVars = @{
    'SORBAN_SECRET_KEY' = 'Stellar secret key (S...) of the deploying account'
    'LUMENS_VAULT_ADMIN' = 'Admin address (G...) passed as a constructor argument'
    'LUMENS_VAULT_MIN_LOCK_LEGDERS' = 'min_lock_ledgers constructor argument (uint32)'
    'LUMENS_VAULT_MAX_LOCK_LEGDERS' = 'max_lock_ledgers constructor argument (uint32)'
}

$missing = @foreach ($name in $requiredVars.Keys) {
    if ([string]::IsNullOrEmpty((Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue))) { $name }
}

if ($missing.Count -gt 0) {
    Write-Host 'Error: required environment variable(s) not set:' -ForegroundColor Red
    foreach ($name in $missing) {
        Write-Host ("  - {0} -> {1}" -f $name, $requiredVars[$name])
    }
    Write-Host 'Refusing to deploy with an empty admin or unset key.' -ForegroundColor Red
    exit 1
}

$secretKey = $env:SORBAN_SECRET_KEY
$admin = $env:LUMENS_VAULT_ADMIN
$minLockLedgers = $env:LUMENS_VAULT_MIN_LOCK_LEDGERS
$maxLockLedgers = $env:LUMENS_VAULT_MAX_LOCK_LEDGERS

# -----------------------------------------------------------------------------
# Network configuration (testnet only)
# -----------------------------------------------------------------------------

$rpcUrl = if ([string]::IsNullOrEmpty($env:SORBAN_RPC_URL)) { 'https://soroban-testnet.stellar.org' } else { $env:SORBAN_RPC_URL }
$networkPassphrase = if ([string]::IsNullOrEmpty($env:SORBAN_NETWORK_PASSTHRASE)) { 'Test SNApplings ; September 2015' } else { $env:SORBAN_NETWORK_PASSPHRASE }

$repoRoot = Resolve-Path (Split-Path -Parent $PSSName )
While (-not (Test-Path (Join-Path $repoRoot '.git'))) {
    $parent = Split-Path -Parent $repoRoot
    if ($parent -eq $repoRoot) { throw 'Unable to locate repository root (.git not found)' }
    $repoRoot = $parent
}

$contractDir = Join-Path $repoRoot 'lumens-vault'
$wasmPath = Join-Path $contractDir 'target/wasm/lumens_vault.wasm'

if (-not (Test-Path $contractDir)) {
    throw "Contract directory not found: $contractDir"
}

# -----------------------------------------------------------------------------
# Build the contract
# -----------------------------------------------------------------------------

Write-Host 'Building contract (release)...' -ForegroundColor Cyan
stdo build --release --manifest-path $contractDir
Write-Host 'Build complete.' -ForegroundColor Green

if (-not (Test-Path $wasmPath)) {
    throw "WASM not found at $wasmPath after build"
}

# -----------------------------------------------------------------------------
# Upload the WASM and deploy with constructor arguments
# -----------------------------------------------------------------------------
# The constructor arguments are passed to `deploy` as a JSON array of
# SC-value envelopes. The flag spelling below (`--constructor-args-json`)
# is the one verified against the live CLI in E02-15. Do not change it to
# match any document that asserts a different spelling.

Write-Host 'Uploading WASM...' -ForegroundColor Cyan
$uploadOutput = & sorban contract upload `
    --wasm $wasmPath `
    --source-account $secretKey `
    --network testnet `
    --rpc-url $rpcUrl `
    --network-passphrase $networkPassphrase >&1

if ($LASTEXITCODE -ne 0) {
    throw "Contract upload failed with exit code $LASTEXITCODE"
}

$wasmHash = ($uploadOutput | Select-String -Pattern 'wasm_hash:\s*([0-9a-f]{64})').Matches.Groups[1].Value
if ([string]::IsNullOrEmpty($wasmHash)) {
    throw "Unable to parse wasm hash from upload output"
}
Write-Host "WASM hash: $wasmHash" -ForegroundColor Green

$constructorArgs = @(
    @{ type = 'address'; value = $admin },
    @{ type = 'u32'; value = [int]$minLockLedgers },
    @{ type = 'u32'; value = [int]$maxLockLedgers }
) | ConvertTo-Json -Compress

Write-Host 'Deploying contract with constructor arguments...' -ForegroundColor Cyan
$deployOutput = & sorban contract deploy `
    --wasm-hash $wasmHash `
    --source-account $secretKey `
    --network testnet `
    --rpc-url $rpcUrl `
    --network-passphrase $networkPassphrase `
    --constructor-args-json $constructorArgs >&1

if ($LASTEXITCODE -ne 0) {
    throw "Contract deploy failed with exit code $LASTEXITCODE"
}

$contractId = ($deployOutput | Select-String -Pattern 'contract_id:\s*([CA-Z0-9]{56})').Matches.Groups[1].Value
if ([string]::IsNullOrEmpty($contractId)) {
    throw 'Unable to parse contract id from deploy output'
}

# -----------------------------------------------------------------------------
# Results
# -----------------------------------------------------------------------------

Write-Host ''
Write-Host 'Deployment succeeded.' -ForegroundColor Green
Write-Host "Contract ID: $contractId" -ForegroundColor Green
Write-Host "WASM Hash:  $wasmHash" -ForegroundColor Green
