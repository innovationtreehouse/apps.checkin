import { describe, expect, it } from "vitest";
import { MAX_CREATES_PER_DAY, MAX_CREATES_PER_RUN, MAX_CREATES_PER_RUN_CEILING, qbGate, runDrain } from "../drain";

type Outcome = "posted" | "failed" | "skipped";

const fresh = () => ({ posted: 0, failed: 0, skipped: 0 });
const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("runDrain", () => {
  it("posts every row when nothing stops it", async () => {
    const counts = fresh();
    const stop = await runDrain<number, Outcome>(rows(3), { counts, post: async () => "posted" });
    expect(stop).toBeNull();
    expect(counts.posted).toBe(3);
  });

  it("stops at the run cap, and only with a row still to post", async () => {
    const over = fresh();
    expect(await runDrain<number, Outcome>(rows(MAX_CREATES_PER_RUN + 2), { counts: over, post: async () => "posted" })).toEqual({ by: "count", remaining: 2 });
    expect(over.posted).toBe(MAX_CREATES_PER_RUN);
    expect(await runDrain<number, Outcome>(rows(MAX_CREATES_PER_RUN), { counts: fresh(), post: async () => "posted" })).toBeNull();
  });

  it("checks the daily cap before the run cap", async () => {
    const counts = { ...fresh(), posted: MAX_CREATES_PER_RUN };
    const stop = await runDrain<number, Outcome>(rows(1), { counts, createdToday: MAX_CREATES_PER_DAY - MAX_CREATES_PER_RUN, post: async () => "posted" });
    expect(stop).toEqual({ by: "day", remaining: 1 });
  });

  it("holds a lane with no createdToday to no daily cap", async () => {
    const stop = await runDrain<number, Outcome>(rows(1), { counts: fresh(), post: async () => "posted" });
    expect(stop).toBeNull();
  });

  it("ends the run when the lane's post returns null, tallying nothing", async () => {
    const counts = fresh();
    const stop = await runDrain<number, Outcome>(rows(2), { counts, post: async () => null });
    expect(stop).toEqual({ by: "post", remaining: 2 });
    expect(counts).toEqual(fresh());
  });

  it("lets a throwing post end the run", async () => {
    const post = async (): Promise<Outcome> => {
      throw new Error("boom");
    };
    await expect(runDrain<number, Outcome>(rows(1), { counts: fresh(), post })).rejects.toThrow("boom");
  });

  it("tries a throttled record again once, then ends the run on the second throttle, leaving that record to post", async () => {
    type T = Outcome | "throttled";
    const script: T[] = ["posted", "throttled", "posted", "throttled"];
    const counts = { ...fresh(), throttled: 0 };
    const seen: number[] = [];
    const stop = await runDrain<number, T>(rows(5), {
      counts,
      throttled: "throttled",
      post: async (row) => {
        seen.push(row);
        return script.shift() ?? "posted";
      },
    });
    expect(seen).toEqual([0, 1, 1, 2]);
    expect(stop).toEqual({ by: "throttled", remaining: 3 });
    expect(counts).toMatchObject({ posted: 2, throttled: 2, failed: 0 });
  });

  it("ends the run when the retried record is throttled again", async () => {
    type T = Outcome | "throttled";
    const counts = { ...fresh(), throttled: 0 };
    const stop = await runDrain<number, T>(rows(5), { counts, throttled: "throttled", post: async () => "throttled" });
    expect(stop).toEqual({ by: "throttled", remaining: 5 });
    expect(counts.throttled).toBe(2);
  });

  it("renews the posting slot before each record and before a throttle's retry, and marks a second throttle as a yield", async () => {
    type T = Outcome | "throttled";
    const script: T[] = ["posted", "throttled", "throttled"];
    let renews = 0;
    const turn = { yielded: false, renew: async () => (renews++, true) };
    const stop = await runDrain<number, T>(rows(3), { counts: { ...fresh(), throttled: 0 }, throttled: "throttled", turn, post: async () => script.shift() ?? "posted" });
    expect(stop).toEqual({ by: "throttled", remaining: 2 });
    expect(renews).toBe(3);
    expect(turn.yielded).toBe(true);
  });

  it("stops before the next record once another run holds the slot", async () => {
    let held = 2;
    const turn = { yielded: false, renew: async () => held-- > 0 };
    const counts = fresh();
    const stop = await runDrain<number, Outcome>(rows(5), { counts, turn, post: async () => "posted" });
    expect(stop).toEqual({ by: "slot", remaining: 3 });
    expect(counts.posted).toBe(2);
    expect(turn.yielded).toBe(false);
  });
});

describe("qbGate", () => {
  const onAt = new Date("2026-09-01T00:00:00Z");
  const after = new Date("2026-09-02T00:00:00Z");

  it("creates nothing on a failed closing-date read", () => {
    expect(qbGate("2026-09-10", { ok: false, error: "x" }, onAt, after, true)).toEqual({ closedThrough: "2026-09-09", mayCreate: false });
  });

  it("falls back to the day before switch-on with no closing date", () => {
    expect(qbGate("2026-09-10", { ok: true, date: null }, onAt, after, false)).toEqual({ closedThrough: "2026-08-31", mayCreate: true });
  });

  it("creates nothing with neither date", () => {
    expect(qbGate("2026-09-10", { ok: true, date: null }, null, after, true)).toEqual({ closedThrough: "2026-09-09", mayCreate: false });
  });

  it("lets only a record after switch-on, or finance's book-it, create", () => {
    const close = { ok: true as const, date: "2026-08-15" };
    expect(qbGate("2026-09-10", close, onAt, onAt, false).mayCreate).toBe(false);
    expect(qbGate("2026-09-10", close, onAt, onAt, true).mayCreate).toBe(true);
    expect(qbGate("2026-09-10", close, null, after, false).mayCreate).toBe(false);
  });
});

describe("runDrain limits passed by the lane", () => {
  const fresh = () => ({ posted: 0 });
  it("stops at the lane's per-run limit", async () => {
    const counts = fresh();
    expect(await runDrain<number, "posted">([1, 2, 3], { counts, maxCreatesPerRun: 2, post: async () => "posted" })).toEqual({ by: "count", remaining: 1 });
    expect(counts.posted).toBe(2);
  });
  it("holds a per-run limit above the ceiling to the ceiling", async () => {
    const counts = fresh();
    const rows = Array.from({ length: MAX_CREATES_PER_RUN_CEILING + 5 }, (_, i) => i);
    expect(await runDrain<number, "posted">(rows, { counts, maxCreatesPerRun: 500, post: async () => "posted" })).toEqual({ by: "count", remaining: 5 });
    expect(counts.posted).toBe(MAX_CREATES_PER_RUN_CEILING);
  });
  it("stops at the lane's per-day limit", async () => {
    expect(await runDrain<number, "posted">([1], { counts: fresh(), createdToday: 3, maxCreatesPerDay: 3, post: async () => "posted" })).toEqual({ by: "day", remaining: 1 });
  });
});
