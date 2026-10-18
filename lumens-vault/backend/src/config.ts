import util from "node:util";

const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;
const REDACTED = "[REDACTED]";

export interface AppConfig {
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  readonly contractId: string;
  readonly databasePath: string;
  readonly webhookSecret: string;
  readonly reflectorContractId: string;
  readonly port: number;
  toJSON(): Record<string, unknown>;
  toString(): string;
}

export class ConfigValidationError extends Error {
  public readonly variable: string;

  constructor(variable: string, reason: string) {
    super(`Invalid configuration for ${variable}: ${reason}`);
    this.name = "ConfigValidationError";
    this.variable = variable;
  }
}

function requireNonEmpty(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ConfigValidationError(name, `${name} is required and must be a non-empty string`);
  }
  return raw.trim();
}

function validateUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireNonEmpty(env, name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigValidationError(name, `${name} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigValidationError(name, `${name} must use http: or https: protocol`);
  }
  return value;
}

function validateContractId(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireNonEmpty(env, name);
  if (!CONTRACT_ID_REGEX.test(value)) {
    throw new ConfigValidationError(
      name,
      `${name} must be a valid 56-character Stellar contract StrKey starting with C`
    );
  }
  return value;
}

function validatePort(env: NodeJS.ProcessEnv, name = "PORT", defaultPort = 3000): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return defaultPort;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigValidationError(name, `${name} must be an integer between 1 and 65535`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ConfigValidationError(name, `${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rpcUrl = validateUrl(env, "RPC_URL");
  const networkPassphrase = requireNonEmpty(env, "NETWORK_PASSPHRASE");
  const contractId = validateContractId(env, "CONTRACT_ID");
  const databasePath = requireNonEmpty(env, "DATABASE_PATH");
  const webhookSecret = requireNonEmpty(env, "WEBHOOK_SECRET");
  const reflectorContractId = validateContractId(env, "REFLECTOR_CONTRACT_ID");
  const port = validatePort(env, "PORT", 3000);

  const redactView = () => ({
    rpcUrl,
    networkPassphrase,
    contractId,
    databasePath,
    webhookSecret: REDACTED,
    reflectorContractId,
    port,
  });

  const configObj: Record<string, unknown> = {
    rpcUrl,
    networkPassphrase,
    contractId,
    databasePath,
    reflectorContractId,
    port,
    toJSON: redactView,
    toString: () => JSON.stringify(redactView()),
    [util.inspect.custom]: () => redactView(),
  };

  Object.defineProperty(configObj, "webhookSecret", {
    value: webhookSecret,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(configObj) as unknown as AppConfig;
}