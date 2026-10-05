#!/usr/bin/env pwsh
#Requires -Version 5.1

<#
.SYNOPSIS
    Build the v2 fixture and run the lumens-vault contract test suite.

.DESCRIPTION
    This script handles the correct build order for the lumens-vault contract tests:
    1. Builds the v2 fixture (required by the upgrade test)
    2. Runs cargo test for the main contract
    
    It ensures the fixture is always built before running tests, preventing the
    "No such file or directory" error that occurs when contractimport! can't find
    the fixture wasm at compile time.

.EXAMPLE
    ./scripts/test-contract.ps1
    
    Builds the fixture and runs all tests.

.EXAMPLE
    ./scripts/test-contract.ps1 -- test_real_upgrade
    
    Builds the fixture and runs only tests matching "test_real_upgrade".

.NOTES
    Run from the lumens-vault/ directory or project root.
    Requires: Rust 1.85+, wasm32v1-none target, stellar-cli
#>

[CmdletBinding()]
param(
    # Additional arguments to pass to cargo test (e.g., test name filter, -- --nocapture)
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$CargoTestArgs
)

$ErrorActionPreference = 'Stop'

# Determine script location and set paths relative to lumens-vault root
$scriptDir = Split-Path -Parent $PSCommandPath
$lumensVaultRoot = Split-Path -Parent $scriptDir

$fixtureDir = Join-Path $lumensVaultRoot "contracts/lumens-vault-v2-fixture"
$contractDir = Join-Path $lumensVaultRoot "contracts/lumens-vault"

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "  Lumens Vault Contract Test Runner" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host

# Step 1: Build the v2 fixture
Write-Host "[1/2] Building v2 fixture..." -ForegroundColor Yellow
Write-Host "      Location: $fixtureDir" -ForegroundColor Gray
Write-Host

Push-Location $fixtureDir
try {
    stellar contract build
    if ($LASTEXITCODE -ne 0) {
        throw "Fixture build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Write-Host
Write-Host "✓ Fixture built successfully" -ForegroundColor Green
Write-Host

# Step 2: Run the test suite
Write-Host "[2/2] Running cargo test..." -ForegroundColor Yellow
Write-Host "      Location: $contractDir" -ForegroundColor Gray
Write-Host

Push-Location $contractDir
try {
    if ($CargoTestArgs) {
        cargo test @CargoTestArgs
    } else {
        cargo test
    }
    
    if ($LASTEXITCODE -ne 0) {
        throw "Tests failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Write-Host
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "  ✓ All tests passed" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host
