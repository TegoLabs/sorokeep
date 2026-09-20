import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { Keypair } from "@stellar/stellar-sdk";
import * as configUtils from "../../src/utils/config";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { mockResolveKey } = vi.hoisted(() => ({
  mockResolveKey: vi.fn(),
}));

vi.mock("../../src/utils/config");
vi.mock("../../src/core/aws_secrets.js", () => ({
  AWSSecretsResolver: class {
    resolveKey = mockResolveKey;
  },
}));

import { registerVaultCommand } from "../../src/commands/vault";

const TEST_KEYPAIR = Keypair.random();
const TEST_SECRET = TEST_KEYPAIR.secret();
const TEST_PUBLIC_KEY = TEST_KEYPAIR.publicKey();

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerVaultCommand(program);
  return program;
}

function collectOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => call.join(" ")).join("\n");
}

describe("vault verify command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    originalExitCode = process.exitCode;
    vi.mocked(configUtils.loadConfig).mockReturnValue({
      network: "testnet",
      pollingIntervalSeconds: 300,
      vault: {
        url: "https://vault.example.com",
        token: "test-vault-token",
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
    delete process.env.SOROKEEP_TEST_KEY;
  });

  it("resolves a vault: source and prints only the public key", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { data: { secret_key: TEST_SECRET } } }),
    });

    const program = makeProgram();
    await program.parseAsync([
      "node",
      "sorokeep",
      "vault",
      "verify",
      "--keypair-source",
      "vault:secret/data/stellar/mykey",
    ]);

    expect(process.exitCode).toBeUndefined();
    const out = collectOutput(logSpy);
    expect(out).toContain(TEST_PUBLIC_KEY);
    expect(out).not.toContain(TEST_SECRET);
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://vault.example.com/v1/secret/data/stellar/mykey");
    expect(init.headers["X-Vault-Token"]).toBe("test-vault-token");
  });

  it("fails with a specific error when Vault rejects the token", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ errors: ["permission denied"] }),
      text: async () => "permission denied",
    });

    const program = makeProgram();
    await program.parseAsync([
      "node",
      "sorokeep",
      "vault",
      "verify",
      "--keypair-source",
      "vault:secret/data/stellar/mykey",
    ]);

    expect(process.exitCode).toBe(1);
    const err = collectOutput(errorSpy);
    expect(err).toMatch(/authentication failed|403/i);
    expect(err).not.toContain(TEST_SECRET);
  });

  it("fails with a specific error when the Vault path is wrong", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ errors: [] }),
      text: async () => "",
    });

    const program = makeProgram();
    await program.parseAsync([
      "node",
      "sorokeep",
      "vault",
      "verify",
      "--keypair-source",
      "vault:secret/data/missing",
    ]);

    expect(process.exitCode).toBe(1);
    expect(collectOutput(errorSpy)).toMatch(/not found.*secret\/data\/missing/i);
  });

  it("fails when Vault is not configured in config.yaml", async () => {
    vi.mocked(configUtils.loadConfig).mockReturnValue({
      network: "testnet",
      pollingIntervalSeconds: 300,
    });

    const program = makeProgram();
    await program.parseAsync([
      "node",
      "sorokeep",
      "vault",
      "verify",
      "--keypair-source",
      "vault:secret/data/stellar/mykey",
    ]);

    expect(process.exitCode).toBe(1);
    expect(collectOutput(errorSpy)).toMatch(/vault\.(url|token)|not configured/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails when the Vault endpoint is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:8200"));

    const program = makeProgram();
    await program.parseAsync([
      "node",
      "sorokeep",
      "vault",
      "verify",
      "--keypair-source",
      "vault:secret/data/stellar/mykey",
    ]);

    expect(process.exitCode).toBe(1);
    expect(collectOutput(errorSpy)).toMatch(/ECONNREFUSED|request failed/i);
  });

  it("resolves an aws: source and prints only the public key", async () => {
    mockResolveKey.mockResolvedValue(TEST_SECRET);

    const program = makeProgram();
    await program.parseAsync([
      "node",
      "sorokeep",
      "vault",
      "verify",
      "--keypair-source",
      "aws:prod/stellar/signing-key",
      "--aws-region",
      "eu-west-1",
    ]);

    expect(process.exitCode).toBeUndefined();
    expect(mockResolveKey).toHaveBeenCalledWith("prod/stellar/signing-key");
    const out = collectOutput(logSpy);
    expect(out).toContain(TEST_PUBLIC_KEY);
    expect(out).not.toContain(TEST_SECRET);
  });

  it("fails with a specific error when AWS denies access", async () => {
    const denied = new Error("User is not authorized to perform secretsmanager:GetSecretValue");
    denied.name = "AccessDeniedException";
    mockResolveKey.mockRejectedValue(denied);

    const program = makeProgram();
    await program.parseAsync([
      "node",
      "sorokeep",
      "vault",
      "verify",
      "--keypair-source",
      "aws:prod/stellar/signing-key",
    ]);

    expect(process.exitCode).toBe(1);
    const err = collectOutput(errorSpy);
    expect(err).toMatch(/AccessDenied|not authorized|secretsmanager:GetSecretValue/i);
    expect(err).not.toContain(TEST_SECRET);
  });

  it("resolves an env: source and prints only the public key", async () => {
    process.env.SOROKEEP_TEST_KEY = TEST_SECRET;

    const program = makeProgram();
    await program.parseAsync([
      "node",
      "sorokeep",
      "vault",
      "verify",
      "--keypair-source",
      "env:SOROKEEP_TEST_KEY",
    ]);

    expect(process.exitCode).toBeUndefined();
    const out = collectOutput(logSpy);
    expect(out).toContain(TEST_PUBLIC_KEY);
    expect(out).not.toContain(TEST_SECRET);
  });

  it("fails when the env: variable is not set", async () => {
    const program = makeProgram();
    await program.parseAsync([
      "node",
      "sorokeep",
      "vault",
      "verify",
      "--keypair-source",
      "env:SOROKEEP_TEST_KEY",
    ]);

    expect(process.exitCode).toBe(1);
    expect(collectOutput(errorSpy)).toMatch(/SOROKEEP_TEST_KEY.*not set/i);
  });

  it("fails when the resolved value is not a valid Stellar secret", async () => {
    process.env.SOROKEEP_TEST_KEY = "not-a-stellar-secret";

    const program = makeProgram();
    await program.parseAsync([
      "node",
      "sorokeep",
      "vault",
      "verify",
      "--keypair-source",
      "env:SOROKEEP_TEST_KEY",
    ]);

    expect(process.exitCode).toBe(1);
    expect(collectOutput(errorSpy)).toMatch(/not a valid Stellar secret/i);
    expect(collectOutput(errorSpy)).not.toContain("not-a-stellar-secret");
  });

  it("fails on an unrecognised keypair source", async () => {
    const program = makeProgram();
    await program.parseAsync([
      "node",
      "sorokeep",
      "vault",
      "verify",
      "--keypair-source",
      "file:/tmp/key.txt",
    ]);

    expect(process.exitCode).toBe(1);
    expect(collectOutput(errorSpy)).toMatch(/unrecognised|expected.*env:|vault:|aws:/i);
  });

  it("fails when --keypair-source is omitted", async () => {
    const program = makeProgram();
    await program.parseAsync(["node", "sorokeep", "vault", "verify"]);

    expect(process.exitCode).toBe(1);
    expect(collectOutput(errorSpy)).toMatch(/keypair-source/i);
  });
});
