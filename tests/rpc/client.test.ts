/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StellarRpcClient, extractResourceCosts, executeWithRetry, RpcUnreachableError, isNetworkError, handleRpcUnreachableError } from "../../src/rpc/client";
import { Contract, xdr, Keypair } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async () =>  {
    const actualModule = await vi.importActual<any>("@stellar/stellar-sdk");
    const moduleRPC = actualModule.rpc as Record<string, unknown>;

    class MockRPCServer {
        public serverUrl: string;
        constructor(serverUrl: string) {
            this.serverUrl = serverUrl;
            if (serverUrl && serverUrl.startsWith("ftp")) {
                throw new Error("Invalid URL scheme");
            }
        }

        async getHealth() {
            if (this.serverUrl && this.serverUrl.includes("refused")) {
                const err = new TypeError("fetch failed");
                (err as any).cause = { code: "ECONNREFUSED", message: "connect ECONNREFUSED" };
                throw err;
            }
            if (this.serverUrl && this.serverUrl.includes("timeout")) {
                throw new Error("Timeout");
            }
            if (this.serverUrl && this.serverUrl.includes("unhealthy")) {
                return { status: "offline" };
            }
            return { status: "healthy", latestLedger: 2443398, oldestLedger: 2322439, ledgerRetentionWindow: 120960 };
        }


        async getFeeStats() {
            if (this.serverUrl && this.serverUrl.includes("timeout")) throw new Error("Timeout");
            return {
                latestLedger: 2443398,
                inclusionFee: {
                    max: "250", min: "100", mode: "100", p10: "100", p20: "100", p30: "100",
                    p40: "100", p50: "125", p60: "150", p70: "175", p80: "200", p90: "225",
                    p95: "250", p99: "250",
                },
            };
        }

        async getLedgerEntries(...keys: any[]) {
            if (this.serverUrl && this.serverUrl.includes("timeout")) throw new Error("Timeout");
            
            return {
                latestLedger: 2443398,
                entries: keys.map(k => {
                    const kStr = k.toXDR ? k.toXDR("base64") : k;
                    let isMissing = false;
                    try {
                        const parsedK = actualModule.xdr.LedgerKey.fromXDR(kStr, "base64");
                        if (parsedK.switch().name === 'contractCode') {
                            const hash = parsedK.contractCode().hash().toString('hex');
                            if (hash === Buffer.from("missing".padEnd(32, "a")).toString("hex")) isMissing = true;
                        } else if (parsedK.switch().name === 'contractData') {
                            const contractIdStr = parsedK.contractData().contract().contractId().toString('hex');
                            if (contractIdStr === Buffer.from("missing".padEnd(32, "a")).toString("hex")) isMissing = true;
                        }
                    } catch {
                        // ignore parsing errors in test
                    }

                    if (isMissing || kStr.includes("missing")) return null;
                    if (kStr.includes("invalid")) return { xdr: "invalid" };
                    if (kStr.includes("token")) {
                        return {
                            lastModifiedLedgerSeq: 2400000,
                            liveUntilLedgerSeq: 2543398,
                            key: kStr,
                            val: {
                                contractData: () => ({
                                    val: () => ({
                                        instance: () => ({
                                            executable: () => ({
                                                switch: () => ({ name: "contractExecutableToken" }),
                                            }),
                                        }),
                                    }),
                                }),
                            },
                            xdr: "mock-xdr"
                        };
                    }
                    return {
                        lastModifiedLedgerSeq: 2400000,
                        liveUntilLedgerSeq: 2543398,
                        key: { toXDR: () => kStr },
                        val: {
                            contractData: () => ({
                                val: () => ({
                                    instance: () => ({
                                        executable: () => ({
                                            switch: () => ({ name: "contractExecutableWasm" }),
                                            wasmHash: () => Buffer.from("ab".repeat(32), "hex"),
                                        }),
                                        storage: () => null,
                                    }),
                                }),
                            }),
                        },
                        xdr: "mock-xdr"
                    };
                }).filter(Boolean),
            };
        }

        async getTransaction(hash: string) {
            if (hash === "missing") return { status: "NOT_FOUND" };
            if (hash === "failed") return { status: "FAILED", resultXdr: "mock-failed-xdr" };
            return { status: "SUCCESS", resultMetaXdr: "mock-result-meta-xdr", feeCharged: 1234 };
        }

        async getAccount(publicKey: string) {
            return new actualModule.Account(publicKey, "123");
        }

        async simulateTransaction() {
            if (this.serverUrl && this.serverUrl.includes("sim-fail")) return { error: "Simulation failed" };
            return {
                cost: { cpuInsns: "1000", memBytes: "100" },
                transactionData: new actualModule.SorobanDataBuilder().build(),
                minResourceFee: "100",
            };
        }

        async sendTransaction() {
            if (this.serverUrl && this.serverUrl.includes("send-error")) {
                return { status: "ERROR", errorResult: "Something went wrong", hash: "error-hash" };
            }
            return { status: "PENDING", hash: "mock-tx-hash" };
        }
    }

    return {
        ...actualModule,
        rpc: {
            ...moduleRPC,
            Server: MockRPCServer,
            assembleTransaction: vi.fn(() => ({ build: () => ({ sign: vi.fn() }) })),
            Api: {
                ...moduleRPC.Api,
                isSimulationError: vi.fn((sim: any) => !!sim.error)
            }
        },
        xdr: {
            ...actualModule.xdr,
            TransactionMeta: {
                fromXDR: vi.fn((xdrString: string) => {
                    if (xdrString === "mock-result-meta-xdr") {
                        return {
                            v3: () => ({
                                sorobanMeta: () => ({
                                    cpuInstructions: () => 15000,
                                    memoryBytes: () => 1024
                                })
                            })
                        };
                    }
                    throw new Error("Invalid XDR");
                })
            }
        }
    };
});

describe("StellarRpcClient", () => {
    let client: StellarRpcClient;

    beforeEach(() => {
        client = new StellarRpcClient("testnet")
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    describe("RPC Client Construction", () => {
        it('should create a client for the testnet network', () => {
            const testnetClient = new StellarRpcClient("testnet");
            expect(testnetClient.getNetwork()).toBe("testnet");
        });

        it('should create a client for the mainnet network', () => {
            const mainnetClient = new StellarRpcClient("mainnet");
            expect(mainnetClient.getNetwork()).toBe("mainnet");
        });

        it('should create a client with a custom RPC url', () => {
            const customClient = new StellarRpcClient("testnet", "https://custom-rpc.com");
            expect(customClient.getNetwork()).toBe("testnet");
        });
        
        it('should throw or reject nicely if given an invalid URL scheme', () => {
            expect(() => new StellarRpcClient("testnet", "ftp://bad-url")).toThrow();
        });

        it('should configure custom fetch dispatcher for certificate pinning if rpcCertificateFingerprint is set', async () => {
            const client = new StellarRpcClient("testnet", "https://custom-rpc.com", {
                rpcCertificateFingerprint: "expected-fingerprint"
            });
            // We just verify it constructed without error.
            // The real logic would be tested with undici fetch mocks if node was available.
            expect(client.getNetwork()).toBe("testnet");
            
            // To ensure it causes a mismatch during request if we mock undici:
            // Since we mocked stellar-sdk heavily, we might just verify fetch or constructor options if we could.
            // With vitest + our heavy mock, testing the internal options isn't perfectly straightforward without exposing them, 
            // but we can ensure it doesn't crash during construction.
        });
    });

    describe("RPC Server Health Check", () => {
        it('should return the health status from the RPC server', async () => {
            const health = await client.checkHealth();
            expect(health.status).toBe("healthy");
            expect(health.latestLedger).toBe(2443398);
        });

        it('should throw an error or handle timeouts gracefully', async () => {
            const timeoutClient = new StellarRpcClient("testnet", "https://timeout.com");
            await expect(timeoutClient.checkHealth()).rejects.toThrow();
        });
        
        it('should handle offline status', async () => {
            const offlineClient = new StellarRpcClient("testnet", "https://unhealthy.com");
            const health = await offlineClient.checkHealth();
            expect(health.status).toBe("offline");
        });
    });

    describe("Contract Instance Entries Operations with `getContractInstanceEntry(contractID)`", () => {
        it('should return an instance entry with TTL data for a valid contract', async () => {
            const contractID = "CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6";
            const retrievedContractInstanceEntry = await client.getContractInstanceEntry(contractID);

            expect(retrievedContractInstanceEntry).toBeDefined();
            expect(retrievedContractInstanceEntry!.latestLedger).toBe(2443398);
            expect(retrievedContractInstanceEntry!.liveUntilLedgerSeq).toBe(2543398);
            expect(retrievedContractInstanceEntry!.lastModifiedLedgerSeq).toBe(2400000);
            expect(retrievedContractInstanceEntry!.remainingTTL).toBe(100000);
            expect(retrievedContractInstanceEntry!.executableType).toBe("contractExecutableWasm");
            expect(retrievedContractInstanceEntry!.wasmHash).toHaveLength(64);
            expect(typeof retrievedContractInstanceEntry!.entryKeyXdr).toBe("string");
        });

        it('should return null or handle missing contracts', async () => {
            // Test goes here
        });

        it('should handle token contracts (non-WASM executable type)', async () => {
        });
        
        it('should gracefully handle malformed ledger entries from RPC', async () => {
        });
        
        it('should reject if RPC times out during getContractInstanceEntry', async () => {
            const timeoutClient = new StellarRpcClient("testnet", "https://timeout.com");
            await expect(timeoutClient.getContractInstanceEntry("CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6")).rejects.toThrow();
        });
    });

    describe("Wasm Code Entry Operations with `getWasmCodeEntry(wasmHash)`",  () => {
        it('should return WASM code entry with TTL data', async () => {
            const wasmHash = "ab".repeat(32);
            const wasmCodeEntry = await client.getWasmCodeEntry(wasmHash);
            expect(wasmCodeEntry).toBeDefined();
            expect(wasmCodeEntry!.latestLedger).toBe(2443398);
            expect(wasmCodeEntry!.remainingTTL).toBe(100000);
            expect(typeof wasmCodeEntry!.entryKeyXdr).toBe("string");
        });
        
        it('should return null for missing WASM hash', async () => {
            const missingHash = Buffer.from("missing".padEnd(32, "a")).toString("hex");
            const entry = await client.getWasmCodeEntry(missingHash);
            expect(entry).toBeNull();
        });
    });

    describe("getEntryTTLs", () => {
        it("accepts an array of base64 XDR keys and returns TTL data", async () => {
            const contract = new Contract("CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6");
            const xdrKey = contract.getFootprint().toXDR("base64");
            const retrievedEntryTTLs = await client.getEntryTTLs([xdrKey]);
            expect(retrievedEntryTTLs).toBeDefined();
            expect(retrievedEntryTTLs.latestLedger).toBe(2443398);
            expect(retrievedEntryTTLs.entries).toHaveLength(1);
        });
        
        it("handles empty array gracefully without throwing", async () => {
            const retrievedEntryTTLs = await client.getEntryTTLs([]);
            expect(retrievedEntryTTLs.entries).toHaveLength(0);
        });
        
        it("handles missing entries in the array response", async () => {
            const validXdr = new Contract("CBEOJUP5FU6KKOEZ7RMTSKZ7YLBS5D6LVATIGCESOGXSZEQ2UWQFKZW6").getFootprint().toXDR("base64");
            const xdrObj = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
                contract: new xdr.ScAddress.scAddressTypeContract(Buffer.from("missing".padEnd(32, "a"))),
                key: xdr.ScVal.scvLedgerKeyContractInstance(),
                durability: xdr.ContractDataDurability.persistent()
            }));
            const missingXdr = xdrObj.toXDR("base64");
            const retrievedEntryTTLs = await client.getEntryTTLs([validXdr, missingXdr]);
            expect(retrievedEntryTTLs.entries).toHaveLength(1);
        });
        
        it("handles malformed base64 strings gracefully", async () => {
            await expect(client.getEntryTTLs(["!!!not-base64!!!"])).rejects.toThrow();
        });
    });

    describe("getCurrentLedger", () => {
        it("returns the current ledger number", async () => {
            const ledger = await client.getCurrentLedger();
            expect(ledger).toBe(2443398);
        });
        
        it("throws if RPC is unreachable", async () => {
            const timeoutClient = new StellarRpcClient("testnet", "https://timeout.com");
            await expect(timeoutClient.getCurrentLedger()).rejects.toThrow();
        });
    });

    describe("Transaction Resource Costs Extraction", () => {
        it("Extracts and logs CPU instructions and memory consumption metrics successfully", () => {
            const mockXdr = "mock-result-meta-xdr";
            const extracted = extractResourceCosts(mockXdr);
            expect(extracted).toBeDefined();
            expect(extracted!.cpuInstructions).toBe(15000);
            expect(extracted!.memoryBytes).toBe(1024);
        });

        it("Returns null if XDR decoding fails or metadata is missing", () => {
            const invalidXdr = "invalid-xdr";
            const extracted = extractResourceCosts(invalidXdr);
            expect(extracted).toBeNull();
        });
        
        it("Returns null if empty string is passed", () => {
            const extracted = extractResourceCosts("");
            expect(extracted).toBeNull();
        });
    });
    
    describe("getFeeStats", () => {
        it("normalizes live fee stats for cost projection", async () => {
            const feeStats = await client.getFeeStats();
            expect(feeStats.latestLedger).toBe(2443398);
            expect(feeStats.baseFeeStroops).toBe(125);
            expect(feeStats.surgeFeeStroops).toBe(250);
            expect(feeStats.surgePricingMultiplier).toBe(2);
        });
        
        it("throws when RPC times out", async () => {
            const timeoutClient = new StellarRpcClient("testnet", "https://timeout.com");
            await expect(timeoutClient.getFeeStats()).rejects.toThrow();
        });
    });

    describe("Transaction Submissions", () => {
        const dummyKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
            contract: new xdr.ScAddress.scAddressTypeContract(Buffer.from("a".repeat(32))),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent()
        })).toXDR("base64");

        const secretKey = Keypair.random().secret();

        it("submitExtension succeeds", async () => {
            const result = await client.submitExtension([dummyKey], 1000, secretKey);
            expect(result.success).toBe(true);
            expect(result.txHash).toBe("mock-tx-hash");
        });

        it("submitExtension handles simulation error (expired sequence number)", async () => {
            const simFailClient = new StellarRpcClient("testnet", "https://sim-fail-seq.com");
            simFailClient["server"].simulateTransaction = vi.fn().mockResolvedValue({ error: "txBadSeq" });
            await expect(simFailClient.submitExtension([dummyKey], 1000, secretKey)).rejects.toThrow("Expired sequence number");
        });

        it("submitExtension handles simulation error (insufficient balance)", async () => {
            const simFailClient = new StellarRpcClient("testnet", "https://sim-fail-bal.com");
            simFailClient["server"].simulateTransaction = vi.fn().mockResolvedValue({ error: "txInsufficientBalance" });
            await expect(simFailClient.submitExtension([dummyKey], 1000, secretKey)).rejects.toThrow("Insufficient wallet balance");
        });

        it("submitExtension handles simulation error (invalid footprint)", async () => {
            const simFailClient = new StellarRpcClient("testnet", "https://sim-fail-key.com");
            simFailClient["server"].simulateTransaction = vi.fn().mockResolvedValue({ error: "invalid footprint" });
            await expect(simFailClient.submitExtension([dummyKey], 1000, secretKey)).rejects.toThrow("Invalid footprint key");
        });

        it("submitExtension handles send error", async () => {
            const sendErrorClient = new StellarRpcClient("testnet", "https://send-error.com");
            const result = await sendErrorClient.submitExtension([dummyKey], 1000, secretKey);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Something went wrong");
        });

        it("submitRestore succeeds", async () => {
            const result = await client.submitRestore([dummyKey], secretKey);
            expect(result.success).toBe(true);
        });

        it("pollTransaction handles FAILED status", async () => {
            const result = await client["pollTransaction"]("failed");
            expect(result.success).toBe(false);
            expect(result.error).toContain("Transaction failed");
        });

        it("pollTransaction handles NOT_FOUND and timeout", async () => {
            const mockClient = new StellarRpcClient("testnet", "https://testnet.stellar.org");
            mockClient.server.getTransaction = vi.fn().mockResolvedValue({ status: "NOT_FOUND" });
            const result = await mockClient["pollTransaction"]("missing", 2, 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Transaction polling timed out after 2 attempts");
        });
    });

    describe("RPC failover and circuit breaker (#496)", () => {
        it("accepts multiple RPC URLs as a comma-separated string", () => {
            const multiClient = new StellarRpcClient("testnet", "https://timeout.com,https://healthy.com");
            expect(multiClient["endpoints"]).toHaveLength(2);
            expect(multiClient["endpoints"][0].url).toBe("https://timeout.com");
            expect(multiClient["endpoints"][1].url).toBe("https://healthy.com");
        });

        it("accepts multiple RPC URLs as an array", () => {
            const multiClient = new StellarRpcClient("testnet", ["https://a.com", "https://b.com"]);
            expect(multiClient["endpoints"]).toHaveLength(2);
        });

        it("a single-URL client behaves exactly as before — one endpoint, no failover attempted", async () => {
            const singleClient = new StellarRpcClient("testnet", "https://healthy.com");
            expect(singleClient["endpoints"]).toHaveLength(1);
            const health = await singleClient.checkHealth();
            expect(health.status).toBe("healthy");
        });

        it("a failing first endpoint causes a retry against the second endpoint, not an immediate error", async () => {
            const multiClient = new StellarRpcClient("testnet", "https://timeout.com,https://healthy.com");
            const health = await multiClient.checkHealth();
            expect(health.status).toBe("healthy");
        });

        it("throws the original error when every configured endpoint fails", async () => {
            const multiClient = new StellarRpcClient("testnet", "https://timeout.com,https://refused.com");
            await expect(multiClient.checkHealth()).rejects.toThrow();
        });

        it("does not fail over on a non-network application error (e.g. a bad request)", async () => {
            const multiClient = new StellarRpcClient("testnet", "https://healthy.com,https://also-healthy.com");
            const appError = Object.assign(new Error("Bad request"), { response: { status: 400 } });
            const spySecond = vi.spyOn(multiClient["endpoints"][1].server, "getHealth");
            vi.spyOn(multiClient["endpoints"][0].server, "getHealth").mockRejectedValueOnce(appError);

            await expect(multiClient.checkHealth()).rejects.toThrow("Bad request");
            expect(spySecond).not.toHaveBeenCalled();
        });

        it("temporarily skips a repeatedly failing endpoint rather than retrying it every call", async () => {
            const multiClient = new StellarRpcClient("testnet", "https://timeout.com,https://healthy.com");

            // First call fails over from timeout.com to healthy.com, which
            // marks timeout.com's endpoint as circuit-broken.
            await multiClient.checkHealth();

            const spyFirst = vi.spyOn(multiClient["endpoints"][0].server, "getHealth");
            const spySecond = vi.spyOn(multiClient["endpoints"][1].server, "getHealth");

            // Second call should go straight to healthy.com without even
            // attempting the known-bad endpoint.
            await multiClient.checkHealth();

            expect(spyFirst).not.toHaveBeenCalled();
            expect(spySecond).toHaveBeenCalledTimes(1);
        });

        it("retries a circuit-broken endpoint again after the cooldown window elapses", async () => {
            vi.useFakeTimers();
            try {
                const multiClient = new StellarRpcClient("testnet", "https://timeout.com,https://healthy.com");
                await multiClient.checkHealth();

                const spyFirst = vi.spyOn(multiClient["endpoints"][0].server, "getHealth");

                vi.advanceTimersByTime(60_000);

                await multiClient.checkHealth().catch(() => {});
                expect(spyFirst).toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe("RPC rate limiting", () => {
        it("does not exceed the configured requests per second", async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

            const timestamps: number[] = [];
            const server = {
                getHealth: vi.fn(async () => {
                    timestamps.push(Date.now());
                    return { status: "healthy", latestLedger: 2443398 };
                }),
            };

            const rateLimitedClient = new StellarRpcClient("testnet", undefined, { maxRequestsPerSecond: 2 });
            (rateLimitedClient as any).server = server;

            const requests = [1, 2, 3, 4].map(() => rateLimitedClient.checkHealth());

            await vi.runAllTimersAsync();
            await Promise.all(requests);

            expect(timestamps).toHaveLength(4);
            expect(timestamps[2] - timestamps[0]).toBeGreaterThanOrEqual(1000);
            expect(timestamps[3] - timestamps[1]).toBeGreaterThanOrEqual(1000);
        });

        it("queues requests and resolves them successfully", async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

            const responses = [1, 2, 3, 4].map(() => ({ status: "healthy" }));
            const server = {
                getHealth: vi.fn(async () => {
                    const response = responses.shift();
                    return response ?? { status: "healthy" };
                }),
            };

            const rateLimitedClient = new StellarRpcClient("testnet", undefined, { maxRequestsPerSecond: 2 });
            (rateLimitedClient as any).server = server;

            const requests = [1, 2, 3, 4].map(() => rateLimitedClient.checkHealth());

            await vi.runAllTimersAsync();
            const settled = await Promise.all(requests);

            expect(settled).toHaveLength(4);
            expect(settled.every((result) => result.status === "healthy")).toBe(true);
        });

        it("limits in-flight requests to maxRequestsPerSecond at any moment", async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

            let inFlight = 0;
            let maxInFlight = 0;
            const server = {
                getHealth: vi.fn(async () => {
                    inFlight++;
                    maxInFlight = Math.max(maxInFlight, inFlight);
                    // Simulate some async work
                    await new Promise<void>(resolve => setTimeout(resolve, 50));
                    inFlight--;
                    return { status: "healthy", latestLedger: 2443398 };
                }),
            };

            const rateLimitedClient = new StellarRpcClient("testnet", undefined, { maxRequestsPerSecond: 2 });
            (rateLimitedClient as any).server = server;

            const requests = [1, 2, 3, 4, 5, 6].map(() => rateLimitedClient.checkHealth());

            await vi.runAllTimersAsync();
            await Promise.all(requests);

            // With 2 req/sec rate limit, at most 2 should have been in-flight simultaneously
            expect(maxInFlight).toBeLessThanOrEqual(2);
            expect(server.getHealth).toHaveBeenCalledTimes(6);
        });

        it("continues processing queued requests even if a preceding request fails", async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

            let callCount = 0;
            const server = {
                getHealth: vi.fn(async () => {
                    callCount++;
                    if (callCount === 1) {
                        throw new Error("First request failed");
                    }
                    return { status: "healthy", latestLedger: 2443398 };
                }),
            };

            const rateLimitedClient = new StellarRpcClient("testnet", undefined, { maxRequestsPerSecond: 1 });
            (rateLimitedClient as any).server = server;

            const firstPromise = rateLimitedClient.checkHealth();
            firstPromise.catch(() => {}); // prevent unhandled rejection during runAllTimersAsync
            const secondPromise = rateLimitedClient.checkHealth();
            secondPromise.catch(() => {}); // prevent unhandled rejection during runAllTimersAsync

            await vi.runAllTimersAsync();
            const [first, second] = await Promise.allSettled([firstPromise, secondPromise]);

            // First should have rejected
            expect(first.status).toBe("rejected");
            // Second should have resolved despite the first failing
            expect(second.status).toBe("fulfilled");
            expect(server.getHealth).toHaveBeenCalledTimes(2);
        });
    });
    describe("ExtendFootprintTTLOp — Simulation and Fee Parsing", () => {
        const dummyKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
            contract: new xdr.ScAddress.scAddressTypeContract(Buffer.from("a".repeat(32))),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent()
        })).toXDR("base64");

        const secretKey = Keypair.random().secret();

        it("simulateExtension returns minResourceFee from footprint simulation", async () => {
            const publicKey = Keypair.fromSecret(secretKey).publicKey();
            const result = await client.simulateExtension([dummyKey], 100000, publicKey);
            expect(result.success).toBe(true);
            expect(result.minResourceFee).toBe(100);
        });

        it("simulateExtension propagates error when RPC simulation fails", async () => {
            const simFailClient = new StellarRpcClient("testnet", "https://sim-fail.com");
            const publicKey = Keypair.fromSecret(secretKey).publicKey();
            const result = await simFailClient.simulateExtension([dummyKey], 100000, publicKey);
            expect(result.success).toBe(false);
            expect(result.error).toBe("Simulation failed");
        });

        it("submitExtension simulates the footprint before assembling and sending", async () => {
            const simulateSpy = vi.spyOn(client["server"] as any, "simulateTransaction");
            const sendSpy = vi.spyOn(client["server"] as any, "sendTransaction");

            await client.submitExtension([dummyKey], 100000, secretKey);

            // simulateTransaction must be called before sendTransaction
            expect(simulateSpy).toHaveBeenCalledTimes(1);
            expect(sendSpy).toHaveBeenCalledTimes(1);
            expect(simulateSpy.mock.invocationCallOrder[0])
                .toBeLessThan(sendSpy.mock.invocationCallOrder[0]!);
        });

        it("submitExtension parses feeCharged from the transaction result", async () => {
            const result = await client.submitExtension([dummyKey], 100000, secretKey);
            expect(result.success).toBe(true);
            expect(result.feeCharged).toBe(1234);
        });

        it("submitExtension returns feeCharged as undefined when not present in result", async () => {
            // Override getTransaction to omit feeCharged
            const mockClient = new StellarRpcClient("testnet", "https://testnet.stellar.org");
            mockClient["server"].getTransaction = vi.fn().mockResolvedValue({
                status: "SUCCESS",
                resultMetaXdr: "mock-result-meta-xdr",
                // no feeCharged field
            });
            mockClient["server"].getAccount = vi.fn().mockResolvedValue(
                new (await import("@stellar/stellar-sdk")).Account(
                    Keypair.fromSecret(secretKey).publicKey(), "1"
                )
            );
            mockClient["server"].simulateTransaction = vi.fn().mockResolvedValue({
                cost: { cpuInsns: "1000", memBytes: "100" },
                transactionData: new (await import("@stellar/stellar-sdk")).SorobanDataBuilder().build(),
                minResourceFee: "100",
            });
            mockClient["server"].sendTransaction = vi.fn().mockResolvedValue({
                status: "PENDING",
                hash: "tx-no-fee",
            });

            const result = await mockClient.submitExtension([dummyKey], 100000, secretKey);
            expect(result.success).toBe(true);
            expect(result.feeCharged).toBeUndefined();

        });
    });


    describe("executeWithRetry", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
            vi.restoreAllMocks();
        });

        it("Succeeds if transient failure resolves within retries", async () => {
            let attempts = 0;
            const action = vi.fn().mockImplementation(async () => {
                attempts++;
                if (attempts < 3) {
                    const error = new Error("503 Service Unavailable");
                    (error as any).response = { status: 503 };
                    throw error;
                }
                return "success";
            });

            const promise = executeWithRetry(action);
            
            // Advance timers for backoff
            await vi.advanceTimersByTimeAsync(1000); // 1st retry
            await vi.advanceTimersByTimeAsync(2000); // 2nd retry

            const result = await promise;
            
            expect(result).toBe("success");
            expect(action).toHaveBeenCalledTimes(3);
        });

        it("Network timeouts trigger retry attempts", async () => {
            const action = vi.fn().mockImplementation(async () => {
                const error = new Error("timeout");
                (error as any).code = "ETIMEDOUT";
                throw error;
            });

            let error: any;
            const promise = executeWithRetry(action).catch(e => { error = e; });

            // Fast forward through all retries: 1s, 2s, 4s
            await vi.advanceTimersByTimeAsync(1000);
            await vi.advanceTimersByTimeAsync(2000);
            await vi.advanceTimersByTimeAsync(4000);

            await promise;
            expect(error).toBeDefined();
            expect(error.message).toBe("timeout");
            expect(action).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
        });
        
        it("Does not retry on non-transient errors like 400 Bad Request", async () => {
            const action = vi.fn().mockImplementation(async () => {
                const error = new Error("400 Bad Request");
                (error as any).response = { status: 400 };
                throw error;
            });

            await expect(executeWithRetry(action)).rejects.toThrow("400 Bad Request");
            expect(action).toHaveBeenCalledTimes(1);
        });

        it("returns immediately on first success without any delay or retry", async () => {
            const action = vi.fn().mockResolvedValue("immediate-success");

            const result = await executeWithRetry(action);

            expect(result).toBe("immediate-success");
            expect(action).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        });

        it("retries exactly N times with increasing exponential backoff then succeeds (increasing delay verification)", async () => {
            let attempts = 0;
            const callTimes: number[] = [];
            const action = vi.fn().mockImplementation(async () => {
                callTimes.push(Date.now());
                attempts++;
                if (attempts <= 2) {
                    const err = new Error(`Transient failure ${attempts}`) as any;
                    err.response = { status: 503 };
                    throw err;
                }
                return "ok-after-retries";
            });

            const promise = executeWithRetry(action);

            await vi.advanceTimersByTimeAsync(0);
            expect(action).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(999);
            expect(action).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1);
            expect(action).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(1999);
            expect(action).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(1);

            const result = await promise;
            expect(result).toBe("ok-after-retries");
            expect(action).toHaveBeenCalledTimes(3);

            expect(callTimes.length).toBe(3);
            const firstDelay = callTimes[1]! - callTimes[0]!;
            const secondDelay = callTimes[2]! - callTimes[1]!;
            expect(firstDelay).toBe(1000);
            expect(secondDelay).toBe(2000);
            expect(secondDelay).toBeGreaterThan(firstDelay);
        });

        it("verifies exponential backoff delays are 1000ms, 2000ms, 4000ms for 3 retries", async () => {
            let attemptCount = 0;
            const timestamps: number[] = [];
            const action = vi.fn().mockImplementation(async () => {
                timestamps.push(Date.now());
                attemptCount++;
                if (attemptCount < 4) {
                    const err = new Error("500") as any;
                    err.response = { status: 500 };
                    throw err;
                }
                return "final-success";
            });

            const promise = executeWithRetry(action);
            await vi.advanceTimersByTimeAsync(0);
            expect(action).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1000);
            expect(action).toHaveBeenCalledTimes(2);
            expect(timestamps[1]! - timestamps[0]!).toBe(1000);

            await vi.advanceTimersByTimeAsync(2000);
            expect(action).toHaveBeenCalledTimes(3);
            expect(timestamps[2]! - timestamps[1]!).toBe(2000);

            await vi.advanceTimersByTimeAsync(4000);
            expect(action).toHaveBeenCalledTimes(4);
            expect(timestamps[3]! - timestamps[2]!).toBe(4000);

            const result = await promise;
            expect(result).toBe("final-success");
        });

        it("exhausts all retries and throws with original error's context preserved", async () => {
            const originalError = new Error("Service Unavailable - original context") as any;
            originalError.response = { status: 503 };
            originalError.code = "ETIMEDOUT";
            originalError.details = "some additional context";

            const action = vi.fn().mockRejectedValue(originalError);

            const promise = executeWithRetry(action);
            // Prevent unhandled rejection warning between timer advances and final assertion
            promise.catch(() => {});

            await vi.advanceTimersByTimeAsync(1000);
            await vi.advanceTimersByTimeAsync(2000);
            await vi.advanceTimersByTimeAsync(4000);

            let caughtError: any;
            try {
                await promise;
            } catch (e) {
                caughtError = e;
            }

            expect(caughtError).toBeDefined();
            expect(caughtError).toBe(originalError);
            expect(caughtError.message).toBe("Service Unavailable - original context");
            expect(caughtError.response.status).toBe(503);
            expect(caughtError.code).toBe("ETIMEDOUT");
            expect(caughtError.details).toBe("some additional context");
            expect(action).toHaveBeenCalledTimes(4);
        });

        it("throws with clear message preserving original error when all retries exhausted (500 error)", async () => {
            const action = vi.fn().mockImplementation(async () => {
                const err = new Error("500 Internal Server Error") as any;
                err.response = { status: 500 };
                throw err;
            });

            const promise = executeWithRetry(action);
            promise.catch(() => {});
            await vi.advanceTimersByTimeAsync(7000);

            await expect(promise).rejects.toThrow("500 Internal Server Error");
            expect(action).toHaveBeenCalledTimes(4);
        });

        it("does not retry on various 4xx non-retryable errors", async () => {
            const nonRetryableStatuses = [400, 401, 403, 404, 405, 422];

            for (const status of nonRetryableStatuses) {
                const action = vi.fn().mockImplementation(async () => {
                    const err = new Error(`${status} error`) as any;
                    err.response = { status };
                    throw err;
                });

                await expect(executeWithRetry(action)).rejects.toThrow(`${status} error`);
                expect(action).toHaveBeenCalledTimes(1);
                vi.clearAllMocks();
            }
        });

        it("retries on 429 Too Many Requests and eventually succeeds", async () => {
            let attempts = 0;
            const action = vi.fn().mockImplementation(async () => {
                attempts++;
                if (attempts < 2) {
                    const err = new Error("429 Too Many Requests") as any;
                    err.response = { status: 429 };
                    throw err;
                }
                return "success-after-429";
            });

            const promise = executeWithRetry(action);
            await vi.advanceTimersByTimeAsync(1000);
            const result = await promise;

            expect(result).toBe("success-after-429");
            expect(action).toHaveBeenCalledTimes(2);
        });

        it("retries on 500-series server errors (500, 502, 503, 504, 599)", async () => {
            const retryableStatuses = [500, 502, 503, 504, 599];

            for (const status of retryableStatuses) {
                let attempts = 0;
                const action = vi.fn().mockImplementation(async () => {
                    attempts++;
                    if (attempts === 1) {
                        const err = new Error(`${status} Server Error`) as any;
                        err.response = { status };
                        throw err;
                    }
                    return `success-${status}`;
                });

                const promise = executeWithRetry(action);
                await vi.advanceTimersByTimeAsync(1000);
                const result = await promise;

                expect(result).toBe(`success-${status}`);
                expect(action).toHaveBeenCalledTimes(2);
                vi.clearAllMocks();
            }
        });

        it("retries on network timeout codes ETIMEDOUT and ECONNRESET", async () => {
            for (const code of ["ETIMEDOUT", "ECONNRESET"]) {
                let attempts = 0;
                const action = vi.fn().mockImplementation(async () => {
                    attempts++;
                    if (attempts === 1) {
                        const err = new Error("network error") as any;
                        err.code = code;
                        throw err;
                    }
                    return `success-${code}`;
                });

                const promise = executeWithRetry(action);
                await vi.advanceTimersByTimeAsync(1000);
                const result = await promise;

                expect(result).toBe(`success-${code}`);
                expect(action).toHaveBeenCalledTimes(2);
                vi.clearAllMocks();
            }
        });

        it("retries when error message includes 'timeout'", async () => {
            let attempts = 0;
            const action = vi.fn().mockImplementation(async () => {
                attempts++;
                if (attempts === 1) {
                    throw new Error("Request timeout after 5000ms");
                }
                return "success-timeout-msg";
            });

            const promise = executeWithRetry(action);
            await vi.advanceTimersByTimeAsync(1000);
            const result = await promise;

            expect(result).toBe("success-timeout-msg");
            expect(action).toHaveBeenCalledTimes(2);
        });

        it("short-circuits immediately on non-retryable error without waiting", async () => {
            const action = vi.fn().mockImplementation(async () => {
                const err = new Error("404 Not Found") as any;
                err.response = { status: 404 };
                throw err;
            });

            const start = Date.now();
            await expect(executeWithRetry(action)).rejects.toThrow("404 Not Found");
            const elapsed = Date.now() - start;

            expect(action).toHaveBeenCalledTimes(1);
            expect(elapsed).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        });

        it("exhausting retries results in exactly MAX_RETRIES+1 attempts (4 total)", async () => {
            const action = vi.fn().mockImplementation(async () => {
                const err = new Error("503") as any;
                err.response = { status: 503 };
                throw err;
            });

            const promise = executeWithRetry(action);
            promise.catch(() => {});
            await vi.advanceTimersByTimeAsync(7000);

            await expect(promise).rejects.toThrow();
            expect(action).toHaveBeenCalledTimes(4);
        });

        it("succeeds after 1 failure with mocked fetch pattern (fetch fails N times then succeeds)", async () => {
            let fetchAttempts = 0;
            const mockFetch = vi.fn().mockImplementation(async () => {
                fetchAttempts++;
                if (fetchAttempts <= 1) {
                    const err = new Error("fetch failed with 503") as any;
                    err.response = { status: 503 };
                    throw err;
                }
                return { ok: true, data: "rpc-result" };
            });

            const promise = executeWithRetry(() => mockFetch());
            await vi.advanceTimersByTimeAsync(1000);
            const result = await promise;

            expect(result).toEqual({ ok: true, data: "rpc-result" });
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it("does not wait extra after final failure (no fourth delay)", async () => {
            const action = vi.fn().mockImplementation(async () => {
                const err = new Error("500") as any;
                err.response = { status: 500 };
                throw err;
            });

            const promise = executeWithRetry(action);
            promise.catch(() => {});

            await vi.advanceTimersByTimeAsync(1000);
            expect(action).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(2000);
            expect(action).toHaveBeenCalledTimes(3);
            await vi.advanceTimersByTimeAsync(4000);
            expect(action).toHaveBeenCalledTimes(4);

            expect(vi.getTimerCount()).toBe(0);

            await expect(promise).rejects.toThrow();
        });

        it("handles mixed retryable error types across attempts then succeeds", async () => {
            const errors = [
                (() => { const e = new Error("ETIMEDOUT") as any; e.code = "ETIMEDOUT"; return e; })(),
                (() => { const e = new Error("429") as any; e.response = { status: 429 }; return e; })(),
                (() => { const e = new Error("timeout in message") as any; e.message = "timeout in message"; return e; })(),
            ];

            let attempt = 0;
            const action = vi.fn().mockImplementation(async () => {
                if (attempt < errors.length) {
                    throw errors[attempt++];
                }
                return "success-mixed-errors";
            });

            const promise = executeWithRetry(action);
            await vi.advanceTimersByTimeAsync(1000);
            await vi.advanceTimersByTimeAsync(2000);
            await vi.advanceTimersByTimeAsync(4000);

            const result = await promise;
            expect(result).toBe("success-mixed-errors");
            expect(action).toHaveBeenCalledTimes(4);
        });

        it("identifies configurable retry parameters: MAX_RETRIES=3, initial 1000ms, multiplier 2x, retryable vs fatal", async () => {
            // This test documents the implementation's configurable parameters
            // MAX_RETRIES = 3 (4 total attempts)
            // Initial delay = 1000ms, multiplier = 2x, so delays = 1000, 2000, 4000
            // Retryable: ETIMEDOUT, ECONNRESET, message includes 'timeout', status 429, 500-599
            // Fatal: 4xx except 429, errors without retryable code/status/message

            const retryableExamples = [
                { code: "ETIMEDOUT" },
                { code: "ECONNRESET" },
                { message: "something timeout occurred" },
                { response: { status: 429 } },
                { response: { status: 500 } },
                { response: { status: 503 } },
                { response: { status: 599 } },
            ];

            for (const example of retryableExamples) {
                const err = new Error("retryable") as any;
                Object.assign(err, example);
                if (example.message) err.message = example.message;
                const action = vi.fn().mockImplementation(async () => {
                    if (action.mock.calls.length === 1) throw err;
                    return "ok";
                });

                // Need fresh attempt counting
                let firstCall = true;
                const trackingAction = vi.fn().mockImplementation(async () => {
                    if (firstCall) {
                        firstCall = false;
                        throw err;
                    }
                    return "ok";
                });

                const promise = executeWithRetry(trackingAction);
                await vi.advanceTimersByTimeAsync(1000);
                const result = await promise;
                expect(result).toBe("ok");
                expect(trackingAction).toHaveBeenCalledTimes(2);
                vi.clearAllMocks();
            }

            // Fatal examples should not retry
            const fatalExample = new Error("400") as any;
            fatalExample.response = { status: 400 };
            const fatalAction = vi.fn().mockRejectedValue(fatalExample);
            await expect(executeWithRetry(fatalAction)).rejects.toThrow();
            expect(fatalAction).toHaveBeenCalledTimes(1);
        });
    });

    describe("RPC unreachable errors", () => {
        it("wraps network failures in RpcUnreachableError, preserving the cause chain", async () => {
            const unreachableClient = new StellarRpcClient("testnet", "https://refused.com");

            let thrownError: any;
            try {
                await unreachableClient.checkHealth();
            } catch (err) {
                thrownError = err;
            }

            expect(thrownError).toBeInstanceOf(RpcUnreachableError);
            expect(thrownError.url).toBe("https://refused.com");
            expect(thrownError.cause.message).toBe("fetch failed");
            expect(thrownError.cause.cause.code).toBe("ECONNREFUSED");
        });

        it("produces a message naming the unreachable URL", async () => {
            const unreachableClient = new StellarRpcClient("testnet", "https://refused.com");
            await expect(unreachableClient.checkHealth()).rejects.toThrow(
                /RPC endpoint at https:\/\/refused\.com is unreachable/,
            );
        });

        it("does not wrap non-network errors (e.g. an unhealthy but reachable endpoint)", async () => {
            const unhealthyClient = new StellarRpcClient("testnet", "https://unhealthy.com");
            const result = await unhealthyClient.checkHealth();
            expect(result.status).toBe("offline");
        });
    });

    describe("isNetworkError", () => {
        it("recognizes known network error codes", () => {
            expect(isNetworkError({ code: "ECONNREFUSED" })).toBe(true);
            expect(isNetworkError({ code: "ETIMEDOUT" })).toBe(true);
        });

        it("recognizes network-shaped messages", () => {
            expect(isNetworkError({ message: "fetch failed" })).toBe(true);
            expect(isNetworkError({ message: "Connection unreachable" })).toBe(true);
        });

        it("recurses into the cause chain", () => {
            expect(isNetworkError({ message: "wrapped", cause: { code: "ENOTFOUND" } })).toBe(true);
        });

        it("returns false for unrelated errors", () => {
            expect(isNetworkError({ message: "Invalid Contract ID format" })).toBe(false);
            expect(isNetworkError(null)).toBe(false);
            expect(isNetworkError(undefined)).toBe(false);
        });

        it("does not infinite-loop on a self-referential cause chain", () => {
            const err: any = { message: "circular" };
            err.cause = err;
            expect(isNetworkError(err)).toBe(false);
        });
    });

    describe("handleRpcUnreachableError", () => {
        it("returns true and prints suggestions for an RpcUnreachableError", () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            const handled = handleRpcUnreachableError(new RpcUnreachableError("https://down.example.com"));
            expect(handled).toBe(true);
            expect(errorSpy.mock.calls.flat().join("\n")).toContain("https://down.example.com");
            errorSpy.mockRestore();
        });

        it("recognizes a plain string message (structured-result error paths)", () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            const handled = handleRpcUnreachableError("RPC endpoint at https://down.example.com is unreachable");
            expect(handled).toBe(true);
            errorSpy.mockRestore();
        });

        it("returns false for unrelated errors and prints nothing", () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            const handled = handleRpcUnreachableError(new Error("Invalid Contract ID format"));
            expect(handled).toBe(false);
            expect(errorSpy).not.toHaveBeenCalled();
            errorSpy.mockRestore();
        });
    });

});
