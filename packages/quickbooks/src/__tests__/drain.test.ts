import { describe, expect, it } from "vitest";
import { MAX_CONSECUTIVE_FAILURES, MAX_CREATES_PER_DAY, MAX_CREATES_PER_RUN, qbGate, runDrain } from "../drain";

type Outcome = "posted" | "failed" | "skipped";

const fresh = () => ({ posted: 0, failed: 0, skipped: 0 });
const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("runDrain", () => {
  it("posts every row when nothing stops it", async () => {
    const counts = fresh();
    const stop = await runDrain<number, Outcome>(rows(3), { counts, failures: ["failed"], post: async () => "posted" });
    expect(stop).toBeNull();
    expect(counts.posted).toBe(3);
  });

  it("stops at the run cap, and only with a row still to post", async () => {
    const over = fresh();
    expect(await runDrain<number, Outcome>(rows(MAX_CREATES_PER_RUN + 2), { counts: over, failures: [], post: async () => "posted" })).toEqual({ by: "count", remaining: 2 });
    expect(over.posted).toBe(MAX_CREATES_PER_RUN);
    expect(await runDrain<number, Outcome>(rows(MAX_CREATES_PER_RUN), { counts: fresh(), failures: [], post: async () => "posted" })).toBeNull();
  });

  it("checks the daily cap before the run cap", async () => {
    const counts = { ...fresh(), posted: MAX_CREATES_PER_RUN };
    const stop = await runDrain<number, Outcome>(rows(1), { counts, failures: [], createdToday: MAX_CREATES_PER_DAY - MAX_CREATES_PER_RUN, post: async () => "posted" });
    expect(stop).toEqual({ by: "day", remaining: 1 });
  });

  it("holds a lane with no createdToday to no daily cap", async () => {
    const stop = await runDrain<number, Outcome>(rows(1), { counts: fresh(), failures: [], post: async () => "posted" });
    expect(stop).toBeNull();
  });

  it("stops after the failure streak, counting what it left", async () => {
    const counts = fresh();
    const stop = await runDrain<number, Outcome>(rows(MAX_CONSECUTIVE_FAILURES + 2), { counts, failures: ["failed"], post: async () => "failed" });
    expect(stop).toEqual({ by: "failures", remaining: 2 });
    expect(counts.failed).toBe(MAX_CONSECUTIVE_FAILURES);
  });

  it("resets the streak on any other outcome, unless that outcome made no call", async () => {
    const script = (o: Outcome[]) => {
      const q = [...o];
      return async () => q.shift() as Outcome;
    };
    const pattern: Outcome[] = ["failed", "failed", "skipped", "failed"];
    expect(await runDrain<number, Outcome>(rows(4), { counts: fresh(), failures: ["failed"], post: script(pattern) })).toBeNull();
    expect(await runDrain<number, Outcome>(rows(4), { counts: fresh(), failures: ["failed"], noCall: ["skipped"], post: script(pattern) })).toEqual({ by: "failures", remaining: 0 });
  });

  it("ends the run when the lane's post returns null, tallying nothing", async () => {
    const counts = fresh();
    const stop = await runDrain<number, Outcome>(rows(2), { counts, failures: [], post: async () => null });
    expect(stop).toEqual({ by: "post", remaining: 2 });
    expect(counts).toEqual(fresh());
  });

  it("lets a throwing post end the run", async () => {
    const post = async (): Promise<Outcome> => {
      throw new Error("boom");
    };
    await expect(runDrain<number, Outcome>(rows(1), { counts: fresh(), failures: [], post })).rejects.toThrow("boom");
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
    expect(await runDrain<number, "posted">([1, 2, 3], { counts, failures: [], maxCreatesPerRun: 2, post: async () => "posted" })).toEqual({ by: "count", remaining: 1 });
    expect(counts.posted).toBe(2);
  });
  it("stops at the lane's per-day limit", async () => {
    expect(await runDrain<number, "posted">([1], { counts: fresh(), failures: [], createdToday: 3, maxCreatesPerDay: 3, post: async () => "posted" })).toEqual({ by: "day", remaining: 1 });
  });
});
