import { describe, it, expect } from "vitest";
import { depositWindows, depositsIn } from "../../lib/qb-deposits";
import type { QbDepositSource } from "../../contract";

describe("depositWindows", () => {
  it("keeps a range of exactly 93 days as one window", () => {
    expect(depositWindows([["2026-01-01", "2026-04-03"]])).toEqual([["2026-01-01", "2026-04-03"]]);
  });

  it("splits a 94-day range into 93 days and 1 day", () => {
    expect(depositWindows([["2026-01-01", "2026-04-04"]])).toEqual([
      ["2026-01-01", "2026-04-03"],
      ["2026-04-04", "2026-04-04"],
    ]);
  });

  it("merges overlapping ranges given in any order", () => {
    expect(depositWindows([["2026-06-05", "2026-06-12"], ["2026-06-01", "2026-06-08"], ["2026-06-03", "2026-06-04"]])).toEqual([
      ["2026-06-01", "2026-06-12"],
    ]);
  });

  it("merges adjacent ranges and keeps a one-day gap apart", () => {
    expect(depositWindows([["2026-06-01", "2026-06-08"], ["2026-06-09", "2026-06-10"], ["2026-06-12", "2026-06-12"]])).toEqual([
      ["2026-06-01", "2026-06-10"],
      ["2026-06-12", "2026-06-12"],
    ]);
  });

  it("returns nothing for no ranges", () => {
    expect(depositWindows([])).toEqual([]);
  });
});

describe("depositsIn", () => {
  it("reads each window once and never one wider than 93 days", async () => {
    const calls: [string, string][] = [];
    const source: QbDepositSource = {
      depositsBetween: async (from, to) => {
        calls.push([from, to]);
        return [{ id: from, txnDate: from, totalCents: 1, depositToAccount: null }];
      },
    };
    const got = await depositsIn(source, [["2026-01-01", "2026-12-31"]]);
    expect(calls).toHaveLength(4);
    for (const [from, to] of calls) expect((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1).toBeLessThanOrEqual(93);
    expect(calls[0][0]).toBe("2026-01-01");
    expect(calls.at(-1)?.[1]).toBe("2026-12-31");
    expect(got.map((d) => d.id)).toEqual(calls.map(([from]) => from));
  });
});
