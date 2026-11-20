import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pacer } from "../pacer";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Starts `n` acquires and records when each one gets its turn. */
function start(p: Pacer, n: number) {
  const got: number[] = [];
  const releases: (() => void)[] = [];
  for (let i = 0; i < n; i++) {
    void p.acquire().then((release) => {
      got.push(i);
      releases.push(release);
    });
  }
  return { got, releases };
}

describe("Pacer", () => {
  it("lets 4 requests in flight at once and the next in when one finishes", async () => {
    const p = new Pacer();
    const { got, releases } = start(p, 6);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(got).toEqual([0, 1, 2, 3]);
    releases[0]();
    releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([0, 1, 2, 3, 4]);
  });

  it("holds requests to 5 a second after a burst of 5", async () => {
    const p = new Pacer();
    const got: number[] = [];
    for (let i = 0; i < 15; i++) void p.acquire().then((release) => (got.push(Date.now()), release()));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(got).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(got).toHaveLength(15);
    const t0 = got[0];
    const inFirstSecond = got.filter((t) => t - t0 < 1_000).length;
    expect(inFirstSecond).toBeLessThanOrEqual(9);
  });

  it("pauses every request 60 seconds after a 429 with no Retry-After", async () => {
    const p = new Pacer();
    const resumeAt = p.throttle(null);
    expect(resumeAt.getTime() - Date.now()).toBe(60_000);
    const { got } = start(p, 2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(got).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toEqual([0, 1]);
  });

  it("pauses for Retry-After up to 120 seconds, and never shortens a pause already in force", () => {
    const p = new Pacer();
    expect(p.throttle("5").getTime() - Date.now()).toBe(5_000);
    expect(p.throttle("600").getTime() - Date.now()).toBe(120_000);
    expect(p.throttle("1").getTime() - Date.now()).toBe(120_000);
  });

  it("holds a request already waiting for a token when a pause starts", async () => {
    const p = new Pacer();
    const got: number[] = [];
    for (let i = 0; i < 6; i++) void p.acquire().then((release) => (got.push(i), release()));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toHaveLength(5);
    p.throttle("10");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(got).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toHaveLength(6);
  });

  it("logs the day's request count at the first request of the next UTC day", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const p = new Pacer();
    for (let i = 0; i < 3; i++) (await p.acquire())();
    expect(info).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-11-19T00:00:01Z"));
    (await p.acquire())();
    expect(info).toHaveBeenCalledWith("[quickbooks] requests per day", { day: "2026-11-18", requests: 3 });
  });

  it("answers the pause in force, and none once it has passed", () => {
    const p = new Pacer();
    expect(p.pauseEnds()).toBeNull();
    p.throttle(null);
    expect(p.pauseEnds()).toEqual(new Date("2026-11-18T12:01:00Z"));
    vi.setSystemTime(new Date("2026-11-18T12:01:00Z"));
    expect(p.pauseEnds()).toBeNull();
  });

  it("counts today's requests, and none on a day with no request yet", async () => {
    const p = new Pacer();
    expect(p.requestsToday()).toBe(0);
    for (let i = 0; i < 2; i++) (await p.acquire())();
    expect(p.requestsToday()).toBe(2);
    vi.setSystemTime(new Date("2026-11-19T00:00:01Z"));
    expect(p.requestsToday()).toBe(0);
  });
});
