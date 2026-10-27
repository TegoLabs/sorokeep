import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { Keypair } from "@stellar/stellar-sdk";

const mockLoadConfig = vi.fn();
const mockGetSecret = vi.fn();
const mockResolveKey = vi.fn();

vi.mock("../../src/utils/config.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    };
});

vi.mock("../../src/core/vault.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        VaultResolver: class MockVaultResolver {
            public config: unknown;
            constructor(config: unknown) {
                this.config = config;
            }
            getSecret(secretPath: string) {
                return mockGetSecret(secretPath);
            }
        },
    };
});

vi.mock("../../src/core/aws_secrets.js", () => {
    return {
        AWSSecretsResolver: class MockAWSSecretsResolver {
            public config: unknown;
            constructor(config: unknown) {
                this.config = config;
            }
            resolveKey(secretId: string) {
                return mockResolveKey(secretId);
            }
        },
    };
});

const { registerVaultCommand } = await import("../../src/commands/vault.js");
const { VaultAuthError, VaultSecretNotFoundError, VaultSecretError } = await import(
    "../../src/core/vault.js"
);

describe("sorokeep vault verify command (issue #415)", () => {
    let program: Command;
    let consoleLogMock: ReturnType<typeof vi.spyOn>;
    let consoleErrorMock: ReturnType<typeof vi.spyOn>;
    let testKeypair: Keypair;

    beforeEach(() => {
        testKeypair = Keypair.random();
        mockLoadConfig.mockReset();
        mockGetSecret.mockReset();
        mockResolveKey.mockReset();

        program = new Command();
        registerVaultCommand(program);
        program.exitOverride();
        program.configureOutput({
            writeOut: () => {},
            writeErr: () => {},
        });

        consoleLogMock = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new Error(`process.exit(${code})`);
        }) as never);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("resolves a HashiCorp Vault source, prints only the public key, and never prints the secret", async () => {
        const secret = testKeypair.secret();
        const publicKey = testKeypair.publicKey();

        mockLoadConfig.mockReturnValue({
            network: "testnet",
            pollingIntervalSeconds: 300,
            vault: {
                url: "https://vault.example.com",
                token: "hvs.test-token",
            },
        });
        mockGetSecret.mockResolvedValue(secret);

        await program.parseAsync([
            "node",
            "sorokeep",
            "vault",
            "verify",
            "--keypair-source",
            "vault:secret/data/stellar/signer",
        ]);

        expect(mockGetSecret).toHaveBeenCalledWith("secret/data/stellar/signer");
        const allLogged = [
            ...consoleLogMock.mock.calls.flat(),
            ...consoleErrorMock.mock.calls.flat(),
        ].join("\n");

        expect(allLogged).toContain(publicKey);
        expect(allLogged).not.toContain(secret);
    });

    it("resolves an AWS Secrets Manager source (aws:<secretId>) and prints only the public key", async () => {
        const secret = testKeypair.secret();
        const publicKey = testKeypair.publicKey();

        mockResolveKey.mockResolvedValue(secret);

        await program.parseAsync([
            "node",
            "sorokeep",
            "vault",
            "verify",
            "--keypair-source",
            "aws:prod/sorokeep/signer",
            "--aws-region",
            "us-west-2",
        ]);

        expect(mockResolveKey).toHaveBeenCalledWith("prod/sorokeep/signer");
        const allLogged = [
            ...consoleLogMock.mock.calls.flat(),
            ...consoleErrorMock.mock.calls.flat(),
        ].join("\n");

        expect(allLogged).toContain(publicKey);
        expect(allLogged).not.toContain(secret);
    });

    it("resolves an AWS Secrets Manager JSON payload containing secret_key and never prints the secret", async () => {
        const secret = testKeypair.secret();
        const publicKey = testKeypair.publicKey();

        mockResolveKey.mockResolvedValue(JSON.stringify({ secret_key: secret }));

        await program.parseAsync([
            "node",
            "sorokeep",
            "vault",
            "verify",
            "--keypair-source",
            "aws:prod/sorokeep/json-signer",
        ]);

        const allLogged = [
            ...consoleLogMock.mock.calls.flat(),
            ...consoleErrorMock.mock.calls.flat(),
        ].join("\n");

        expect(allLogged).toContain(publicKey);
        expect(allLogged).not.toContain(secret);
    });

    it("exits non-zero with a specific error when Vault configuration is missing in config.yaml", async () => {
        mockLoadConfig.mockReturnValue({
            network: "testnet",
            pollingIntervalSeconds: 300,
        });

        await expect(
            program.parseAsync([
                "node",
                "sorokeep",
                "vault",
                "verify",
                "--keypair-source",
                "vault:secret/data/stellar/signer",
            ]),
        ).rejects.toThrow("process.exit(1)");

        const errOutput = consoleErrorMock.mock.calls.flat().join("\n");
        expect(errOutput).toMatch(/Vault configuration missing/i);
    });

    it("exits non-zero with a specific error on Vault authentication failure (401/403)", async () => {
        mockLoadConfig.mockReturnValue({
            network: "testnet",
            pollingIntervalSeconds: 300,
            vault: {
                url: "https://vault.example.com",
                token: "bad-token",
            },
        });
        mockGetSecret.mockRejectedValue(new VaultAuthError("Vault authentication failed (403)"));

        await expect(
            program.parseAsync([
                "node",
                "sorokeep",
                "vault",
                "verify",
                "--keypair-source",
                "vault:secret/data/stellar/signer",
            ]),
        ).rejects.toThrow("process.exit(1)");

        const errOutput = consoleErrorMock.mock.calls.flat().join("\n");
        expect(errOutput).toContain("Vault authentication failed (403)");
    });

    it("exits non-zero with a specific error when Vault secret path is not found (404)", async () => {
        mockLoadConfig.mockReturnValue({
            network: "testnet",
            pollingIntervalSeconds: 300,
            vault: {
                url: "https://vault.example.com",
                token: "hvs.test-token",
            },
        });
        mockGetSecret.mockRejectedValue(new VaultSecretNotFoundError("secret/data/missing"));

        await expect(
            program.parseAsync([
                "node",
                "sorokeep",
                "vault",
                "verify",
                "--keypair-source",
                "vault:secret/data/missing",
            ]),
        ).rejects.toThrow("process.exit(1)");

        const errOutput = consoleErrorMock.mock.calls.flat().join("\n");
        expect(errOutput).toContain("Secret not found in Vault at path: secret/data/missing");
    });

    it("exits non-zero with a specific error when Vault endpoint is unreachable", async () => {
        mockLoadConfig.mockReturnValue({
            network: "testnet",
            pollingIntervalSeconds: 300,
            vault: {
                url: "https://vault.unreachable.internal",
                token: "hvs.test-token",
            },
        });
        mockGetSecret.mockRejectedValue(
            new VaultSecretError("Vault request failed: fetch failed (ECONNREFUSED)"),
        );

        await expect(
            program.parseAsync([
                "node",
                "sorokeep",
                "vault",
                "verify",
                "--keypair-source",
                "vault:secret/data/stellar/signer",
            ]),
        ).rejects.toThrow("process.exit(1)");

        const errOutput = consoleErrorMock.mock.calls.flat().join("\n");
        expect(errOutput).toContain("Vault request failed: fetch failed (ECONNREFUSED)");
    });

    it("exits non-zero with an actionable IAM permission message on AWS AccessDeniedException", async () => {
        const accessDenied = Object.assign(
            new Error("User is not authorized to perform: secretsmanager:GetSecretValue"),
            { name: "AccessDeniedException" },
        );
        mockResolveKey.mockRejectedValue(accessDenied);

        await expect(
            program.parseAsync([
                "node",
                "sorokeep",
                "vault",
                "verify",
                "--keypair-source",
                "aws:prod/sorokeep/signer",
            ]),
        ).rejects.toThrow("process.exit(1)");

        const errOutput = consoleErrorMock.mock.calls.flat().join("\n");
        expect(errOutput).toMatch(/missing IAM permission|secretsmanager:GetSecretValue/i);
    });

    it("exits non-zero when an unsupported --keypair-source prefix is provided", async () => {
        await expect(
            program.parseAsync([
                "node",
                "sorokeep",
                "vault",
                "verify",
                "--keypair-source",
                "unknown:foo",
            ]),
        ).rejects.toThrow("process.exit(1)");

        const errOutput = consoleErrorMock.mock.calls.flat().join("\n");
        expect(errOutput).toMatch(/Unsupported --keypair-source/i);
    });
});
