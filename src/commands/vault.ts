import { Command } from "commander";
import chalk from "chalk";
import { Keypair } from "@stellar/stellar-sdk";
import {
    VaultResolver,
    VaultAuthError,
    VaultSecretNotFoundError,
    VaultSecretError,
} from "../core/vault.js";
import { AWSSecretsResolver } from "../core/aws_secrets.js";
import { zeroizeKeypair } from "../core/channels.js";
import { loadConfig } from "../utils/config.js";
import { printOutput } from "../utils/formatting.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "VaultCommand" });

const CANDIDATE_SECRET_FIELDS = [
    "secret_key",
    "private_key",
    "secret",
    "value",
    "stellar_secret",
    "key",
] as const;

function extractStellarSecretFromAwsValue(raw: string, secretId: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            throw new Error(
                `AWS secret '${secretId}' returned malformed JSON payload`,
            );
        }

        if (parsed && typeof parsed === "object") {
            const record = parsed as Record<string, unknown>;
            for (const field of CANDIDATE_SECRET_FIELDS) {
                if (typeof record[field] === "string") {
                    return record[field] as string;
                }
            }
            const stringValues = Object.values(record).filter(
                (v): v is string => typeof v === "string",
            );
            if (stringValues.length === 1 && stringValues[0]) {
                return stringValues[0];
            }
        }
        throw new Error(
            `No valid Stellar secret field found in AWS secret '${secretId}'. Expected one of: ${CANDIDATE_SECRET_FIELDS.join(", ")}`,
        );
    }

    return trimmed;
}

function classifyAwsError(error: unknown, secretId: string): string {
    const errName =
        error && typeof error === "object" && "name" in error
            ? String((error as { name?: unknown }).name)
            : "";
    const message = error instanceof Error ? error.message : String(error);

    if (
        errName === "AccessDeniedException" ||
        message.includes("AccessDenied") ||
        message.includes("not authorized to perform")
    ) {
        return `AWS Secrets Manager access denied for '${secretId}' (missing IAM permission secretsmanager:GetSecretValue): ${message}`;
    }

    if (
        errName === "ResourceNotFoundException" ||
        message.includes("ResourceNotFound")
    ) {
        return `AWS Secrets Manager secret not found: '${secretId}' (${message})`;
    }

    if (
        errName === "UnrecognizedClientException" ||
        errName === "InvalidSignatureException" ||
        errName === "CredentialsProviderError"
    ) {
        return `AWS authentication failed while resolving '${secretId}': ${message}`;
    }

    return `Failed to resolve secret '${secretId}' from AWS Secrets Manager: ${message}`;
}

function classifyVaultError(error: unknown, secretPath: string): string {
    if (error instanceof VaultAuthError) {
        return `HashiCorp Vault authentication failed for '${secretPath}': ${error.message}`;
    }
    if (error instanceof VaultSecretNotFoundError) {
        return error.message;
    }
    if (error instanceof VaultSecretError) {
        return error.message;
    }
    const message = error instanceof Error ? error.message : String(error);
    return `HashiCorp Vault resolution failed for '${secretPath}': ${message}`;
}

function deriveAndZeroizePublicKey(secretKey: string): string {
    if (!secretKey.startsWith("S") || secretKey.length !== 56) {
        throw new Error(
            "Resolved value is not a valid Stellar secret key (expected 56-character string starting with 'S')",
        );
    }

    let keypair: Keypair;
    try {
        keypair = Keypair.fromSecret(secretKey);
    } catch {
        throw new Error(
            "Resolved value failed Stellar Ed25519 secret key checksum validation",
        );
    }

    try {
        return keypair.publicKey();
    } finally {
        zeroizeKeypair(keypair);
    }
}

export interface VaultVerifyOptions {
    keypairSource: string;
    awsRegion?: string;
    awsProfile?: string;
    json?: boolean;
}

export function registerVaultCommand(program: Command): void {
    const vault = program
        .command("vault")
        .description("Verify external secret-manager credential resolution without side effects");

    vault
        .command("verify")
        .description(
            "Resolve a signing key from HashiCorp Vault, AWS Secrets Manager, or env and print only the derived public key",
        )
        .requiredOption(
            "--keypair-source <source>",
            "Credential source to verify (vault:<path>, aws:<secret-id>, or env:<VAR>)",
        )
        .option(
            "--aws-region <region>",
            "AWS region override for AWS Secrets Manager resolution",
        )
        .option(
            "--aws-profile <profile>",
            "AWS shared credentials profile name for AWS Secrets Manager resolution",
        )
        .option("--json", "Output verification result as machine-readable JSON")
        .action(async (options: VaultVerifyOptions) => {
            const source = options.keypairSource.trim();

            try {
                let provider: "vault" | "aws" | "env";
                let secretKey: string;

                if (source.startsWith("vault:")) {
                    provider = "vault";
                    const secretPath = source.slice("vault:".length).trim();
                    if (!secretPath) {
                        throw new Error(
                            "Vault secret path is empty. Expected format: vault:<secret/path>",
                        );
                    }

                    const config = loadConfig();
                    if (!config.vault?.url || !config.vault?.token) {
                        throw new Error(
                            "Vault configuration missing in config.yaml (vault.url and vault.token are required)",
                        );
                    }

                    const resolver = new VaultResolver({
                        url: config.vault.url,
                        token: config.vault.token,
                        namespace: config.vault.namespace,
                    });

                    try {
                        secretKey = await resolver.getSecret(secretPath);
                    } catch (err: unknown) {
                        throw new Error(classifyVaultError(err, secretPath));
                    }
                } else if (
                    source.startsWith("aws:") ||
                    source.startsWith("aws-secrets:") ||
                    source.startsWith("sm:")
                ) {
                    provider = "aws";
                    const colonIdx = source.indexOf(":");
                    const secretId = source.slice(colonIdx + 1).trim();
                    if (!secretId) {
                        throw new Error(
                            "AWS secret ID is empty. Expected format: aws:<secret-id>",
                        );
                    }

                    const resolver = new AWSSecretsResolver({
                        region: options.awsRegion ?? process.env.AWS_REGION,
                        profile: options.awsProfile ?? process.env.AWS_PROFILE,
                    });

                    let rawSecret: string;
                    try {
                        rawSecret = await resolver.resolveKey(secretId);
                    } catch (err: unknown) {
                        throw new Error(classifyAwsError(err, secretId));
                    }

                    secretKey = extractStellarSecretFromAwsValue(rawSecret, secretId);
                } else if (source.startsWith("env:")) {
                    provider = "env";
                    const envVar = source.slice("env:".length).trim();
                    if (!envVar) {
                        throw new Error(
                            "Environment variable name is empty. Expected format: env:<VAR_NAME>",
                        );
                    }
                    const envValue = process.env[envVar];
                    if (!envValue) {
                        throw new Error(
                            `Environment variable '${envVar}' is not set or empty`,
                        );
                    }
                    secretKey = envValue.trim();
                } else {
                    throw new Error(
                        "Unsupported --keypair-source format. Expected 'vault:<path>', 'aws:<secret-id>', or 'env:<VAR_NAME>'",
                    );
                }

                const publicKey = deriveAndZeroizePublicKey(secretKey);

                if (options.json) {
                    printOutput(
                        {
                            success: true,
                            provider,
                            publicKey,
                        },
                        true,
                    );
                    return;
                }

                console.log(
                    chalk.green(`✔ Credential source verified (${provider})`),
                );
                console.log(`  Public key: ${publicKey}`);
            } catch (error: unknown) {
                const message =
                    error instanceof Error ? error.message : String(error);
                logger.error("Vault verify failed", { error: message });

                if (options.json) {
                    printOutput(
                        {
                            success: false,
                            error: message,
                        },
                        true,
                    );
                } else {
                    console.error(chalk.red(`✖ Credential verification failed: ${message}`));
                }
                process.exit(1);
            }
        });
}
