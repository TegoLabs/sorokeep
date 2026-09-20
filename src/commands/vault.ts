import { Command } from "commander";
import chalk from "chalk";
import { Keypair } from "@stellar/stellar-sdk";
import { VaultResolver } from "../core/vault.js";
import { AWSSecretsResolver } from "../core/aws_secrets.js";
import { zeroizeKeypair } from "../core/channels.js";
import { loadConfig } from "../utils/config.js";

interface VaultVerifyOptions {
    keypairSource?: string;
    awsRegion?: string;
    awsProfile?: string;
}

/**
 * Resolve a keypair source to its raw secret string through the same
 * resolvers the guard/daemon path uses (core/vault.ts, core/aws_secrets.ts).
 * Supported schemes: env:<var>, vault:<path>, aws:<secret-id>, or a raw
 * Stellar secret key. Errors propagate with their specific cause so the
 * caller can report exactly which link in the credential chain failed.
 */
async function resolveSourceSecret(source: string, options: VaultVerifyOptions): Promise<string> {
    if (source.startsWith("env:")) {
        const envVar = source.slice(4);
        const value = process.env[envVar];
        if (!value) {
            throw new Error(`Environment variable '${envVar}' is not set`);
        }
        return value;
    }

    if (source.startsWith("vault:")) {
        const vaultPath = source.slice(6);
        if (!vaultPath) {
            throw new Error("Vault keypair source is missing a secret path (expected 'vault:<path>')");
        }
        const config = loadConfig();
        if (!config.vault?.url || !config.vault?.token) {
            throw new Error("Vault is not configured — set vault.url and vault.token in ~/.sorokeep/config.yaml");
        }
        const resolver = new VaultResolver({
            url: config.vault.url,
            token: config.vault.token,
            namespace: config.vault.namespace,
        });
        return resolver.getSecret(vaultPath);
    }

    if (source.startsWith("aws:")) {
        const secretId = source.slice(4);
        if (!secretId) {
            throw new Error("AWS keypair source is missing a secret id (expected 'aws:<secret-id>')");
        }
        const resolver = new AWSSecretsResolver({
            region: options.awsRegion,
            profile: options.awsProfile,
        });
        return resolver.resolveKey(secretId);
    }

    if (source.startsWith("S") && source.length === 56) {
        return source;
    }

    throw new Error(
        "Unrecognised keypair source — expected 'env:<var>', 'vault:<path>', 'aws:<secret-id>' or a Stellar secret key"
    );
}

function isRawSecret(source: string): boolean {
    return source.startsWith("S") && source.length === 56;
}

export function registerVaultCommand(program: Command): void {
    const vault = program
        .command("vault")
        .description("Manage external credential sources (HashiCorp Vault, AWS Secrets Manager)");

    // ── vault verify ────────────────────────────────────────────────────────
    vault
        .command("verify")
        .description("Verify a --keypair-source resolves its signing key, without signing or storing anything")
        .option(
            "--keypair-source <source>",
            "Credential source: 'env:<var>', 'vault:<path>', 'aws:<secret-id>' or a raw Stellar secret key",
        )
        .option("--aws-region <region>", "AWS region override for 'aws:' sources")
        .option("--aws-profile <profile>", "AWS shared-credentials profile for 'aws:' sources")
        .action(async (options: VaultVerifyOptions) => {
            const source = options.keypairSource;
            if (!source) {
                console.error(
                    chalk.red("✖ Missing --keypair-source.") +
                    `\n  Example: sorokeep vault verify --keypair-source vault:secret/data/stellar/mykey`,
                );
                process.exitCode = 1;
                return;
            }

            // A raw secret key must never be echoed back; only label it.
            const displaySource = isRawSecret(source) ? "(raw secret key)" : source;

            try {
                const secret = await resolveSourceSecret(source, options);

                let publicKey: string;
                let keypair: Keypair | undefined;
                try {
                    keypair = Keypair.fromSecret(secret);
                    publicKey = keypair.publicKey();
                } catch {
                    throw new Error("Credential source resolved, but the value is not a valid Stellar secret key");
                } finally {
                    if (keypair) {
                        zeroizeKeypair(keypair);
                    }
                }

                console.log(
                    chalk.green("✔ Credential source verified.") +
                    `\n  Source:     ${chalk.cyan(displaySource)}` +
                    `\n  Public key: ${chalk.cyan(publicKey)}`,
                );
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(
                    chalk.red("✖ Credential verification failed.") +
                    `\n  Source: ${displaySource}` +
                    `\n  Error:  ${message}`,
                );
                process.exitCode = 1;
            }
        });
}
