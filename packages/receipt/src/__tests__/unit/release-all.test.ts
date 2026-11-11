import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, invalidateLoads } from "@checkin/component-ui";
import { releaseAll } from "../../components/releaseAll";

vi.mock("@checkin/component-ui", async (actual) => ({
  ...(await actual<typeof import("@checkin/component-ui")>()),
  invalidateLoads: vi.fn(),
}));

const refuse = (status: number, message = `HTTP ${status}`) => new HttpError(message, status);

beforeEach(() => vi.mocked(invalidateLoads).mockClear());

describe("releaseAll", () => {
  it("releases every item in order, one at a time, reporting progress", async () => {
    const calls: number[] = [];
    const progress: number[] = [];
    const out = await releaseAll(
      [1, 2, 3],
      async (id) => calls.push(id),
      (n) => progress.push(n),
    );
    expect(out).toEqual({ released: 3, skipped: 0, error: null, notReached: 0 });
    expect(calls).toEqual([1, 2, 3]);
    expect(progress).toEqual([1, 2, 3]);
  });

  it("skips items already handled or conflicted and carries on", async () => {
    const statuses: Record<number, number> = { 1: 409, 2: 200, 3: 404, 4: 403, 5: 200 };
    const out = await releaseAll([1, 2, 3, 4, 5], async (id) => {
      if (statuses[id] !== 200) throw refuse(statuses[id]);
    });
    expect(out).toEqual({ released: 2, skipped: 3, error: null, notReached: 0 });
  });

  it("stops at the first other failure, naming it and counting what was not tried", async () => {
    const calls: number[] = [];
    const out = await releaseAll([1, 2, 3, 4], async (id) => {
      calls.push(id);
      if (id === 2) throw refuse(500, "Internal error");
    });
    expect(out).toEqual({ released: 1, skipped: 0, error: "Internal error", notReached: 2 });
    expect(calls).toEqual([1, 2]);
  });

  it("stops on a network failure", async () => {
    const out = await releaseAll([1, 2], async () => {
      throw new Error("offline");
    });
    expect(out).toEqual({ released: 0, skipped: 0, error: "offline", notReached: 1 });
  });

  it("invalidates once for N releases", async () => {
    await releaseAll([1, 2, 3, 4], async () => {});
    expect(invalidateLoads).toHaveBeenCalledTimes(1);
  });

  it("invalidates once when a run stops at a failure", async () => {
    await releaseAll([1, 2, 3], async () => {
      throw refuse(500);
    });
    expect(invalidateLoads).toHaveBeenCalledTimes(1);
  });
});
