use std::path::Path;

fn main() {
    // The fixture wasm path that contractimport! tries to load at compile time
    let fixture_wasm = "../lumens-vault-v2-fixture/target/wasm32v1-none/release/lumens_vault_v2_fixture.wasm";
    
    if !Path::new(fixture_wasm).exists() {
        eprintln!("\n");
        eprintln!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        eprintln!("  ERROR: V2 fixture wasm not found");
        eprintln!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        eprintln!();
        eprintln!("The upgrade test needs the v2 fixture compiled first.");
        eprintln!();
        eprintln!("Run this command to build it:");
        eprintln!();
        eprintln!("  cd contracts/lumens-vault-v2-fixture && stellar contract build");
        eprintln!();
        eprintln!("Or use the test script that handles it automatically:");
        eprintln!();
        eprintln!("  ./lumens-vault/scripts/test-contract.ps1");
        eprintln!();
        eprintln!("See docs/testing.md for the full walkthrough.");
        eprintln!();
        eprintln!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        eprintln!("\n");
        panic!("Build failed: fixture wasm missing");
    }
    
    // Tell cargo to rerun this build script if the fixture wasm changes
    println!("cargo:rerun-if-changed={}", fixture_wasm);
}
