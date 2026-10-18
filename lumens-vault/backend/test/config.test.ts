import util from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadConfig } from "../src/config.js";

const VALID_CONTRACT_ID = "C" + "A".repeat(55);
const VALID_REFLECTOR_ID = "C" + "B".repeat(55);

function makeValidEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    RPC_URL: "https://soroban-testnet.stellar.org",
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    CONTRACT_ID: VALID_CONTRACT_ID,
    DATABASE_PATH: ":memory:",
    WEBHOOK_SECRET: "super-secret-webhook-signing-key-999",
    REFLECTOR_CONTRACT_ID: VALID_REFLECTOR_ID,
    PORT: "4000",
    ...overrides,
  };
}

describe("loadConfig fail-fast validation", () => {
  it("loads a frozen typed config when all required variables are valid", () => {
    const cfg = loadConfig(makeValidEnv());
    expect(cfg.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(cfg.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(cfg.contractId).toBe(VALID_CONTRACT_ID);
    expect(cfg.databasePath).toBe(":memory:");
    expect(cfg.webhookSecret).toBe("super-secret-webhook-signing-key-999");
    expect(cfg.reflectorContractId).toBe(VALID_REFLECTOR_ID);
    expect(cfg.port).toBe(4000);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it("defaults PORT to 3000 when omitted", () => {
    const cfg = loadConfig(makeValidEnv({ PORT: undefined }));
    expect(cfg.port).toBe(3000);
  });

  it.each([
    "RPC_URL",
    "NETWORK_PASSPHRASE",
    "CONTRACT_ID",
    "DATABASE_PATH",
    "WEBHOOK_SECRET",
    "REFLECTOR_CONTRACT_ID",
  ])("throws ConfigValidationError naming %s when missing", (missingVar) => {
    const env = makeValidEnv({ [missingVar]: "" });
    expect(() => loadConfig(env)).toThrowError(ConfigValidationError);
    expect(() => loadConfig(env)).toThrowError(new RegExp(missingVar));
  });

  it("rejects malformed CONTRACT_ID and REFLECTOR_CONTRACT_ID shapes", () => {
    expect(() => loadConfig(makeValidEnv({ CONTRACT_ID: "G" + "A".repeat(55) }))).toThrow(/CONTRACT_ID/);
    expect(() => loadConfig(makeValidEnv({ CONTRACT_ID: "C123" }))).toThrow(/CONTRACT_ID/);
    expect(() => loadConfig(makeValidEnv({ REFLECTOR_CONTRACT_ID: "invalid-id" }))).toThrow(
      /REFLECTOR_CONTRACT_ID/
    );
  });

  it("rejects malformed RPC_URL and out-of-range PORT", () => {
    expect(() => loadConfig(makeValidEnv({ RPC_URL: "ftp://bad-scheme.example.com" }))).toThrow(/RPC_URL/);
    expect(() => loadConfig(makeValidEnv({ PORT: "70000" }))).toThrow(/PORT/);
    expect(() => loadConfig(makeValidEnv({ PORT: "not-a-port" }))).toThrow(/PORT/);
  });

  it("redacts WEBHOOK_SECRET from stringification, JSON serialization, and util.inspect", () => {
    const secret = "top-secret-hmac-value-do-not-leak";
    const cfg = loadConfig(makeValidEnv({ WEBHOOK_SECRET: secret }));

    expect(cfg.webhookSecret).toBe(secret);
    expect(String(cfg)).not.toContain(secret);
    expect(JSON.stringify(cfg)).not.toContain(secret);
    expect(util.inspect(cfg)).not.toContain(secret);
    expect(Object.keys(cfg)).not.toContain("webhookSecret");
  });
});