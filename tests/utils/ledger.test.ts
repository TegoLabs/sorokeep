import { describe, it, expect } from "vitest";
import { AVG_LEDGER_CLOSE_SECONDS, LEDGERS_PER_DAY, ledgersToMilliseconds } from "../../src/utils/ledger.js";
import { convertLedgerCloseTimeToSeconds } from "../../src/utils/formatting.js";
import * as rentProjection from "../../src/core/rent_projection.js";
import fs from "node:fs";
import path from "node:path";

describe("ledger timing constants", () => {
    it("exposes one close time, used consistently by every consumer", () => {
        // Guards the drift this module was created to end. `formatting` and
        // `rent_projection` each used to carry their own copy, and `monitor`
        // and `status` each carried a different one (5 s vs 5.5 s).
        expect(convertLedgerCloseTimeToSeconds(1)).toBe(AVG_LEDGER_CLOSE_SECONDS);
        expect(rentProjection.AVG_LEDGER_CLOSE_SECONDS).toBe(AVG_LEDGER_CLOSE_SECONDS);
        expect(rentProjection.LEDGERS_PER_DAY).toBe(LEDGERS_PER_DAY);
        expect(ledgersToMilliseconds(1)).toBe(AVG_LEDGER_CLOSE_SECONDS * 1000);
    });

    it("keeps ledgersToMilliseconds consistent with the seconds conversion", () => {
        for (const ledgers of [0, 1, 17, 20_000, -5]) {
            expect(ledgersToMilliseconds(ledgers)).toBeCloseTo(
                convertLedgerCloseTimeToSeconds(ledgers) * 1000,
                6,
            );
        }
    });

    it("has no module redeclaring a local ledger-close constant", () => {
        // A unit test cannot catch a fifth copy appearing in a new file, so this
        // asserts on the source itself. The failure mode being guarded is not a
        // wrong number, it is two correct-looking numbers in different files.
        const offenders: string[] = [];
        const walk = (dir: string): void => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith(".ts") && p !== path.join("src", "utils", "ledger.ts")) {
                    const src = fs.readFileSync(p, "utf8");
                    for (const line of src.split("\n")) {
                        if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue;
                        if (/\b(?:SECONDS_PER_LEDGER|LEDGER_CLOSE[A-Z_]*)\s*=\s*[\d.]/.test(line)) {
                            offenders.push(`${p}: ${line.trim()}`);
                        }
                    }
                }
            }
        };
        walk("src");
        expect(offenders, "declare it in src/utils/ledger.ts and import it").toEqual([]);
    });
});
