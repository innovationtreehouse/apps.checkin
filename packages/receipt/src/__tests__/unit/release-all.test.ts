import { describe, expect, it } from "vitest";
import { releaseAll } from "../../components/releaseAll";

const reply = (status: number, error?: string) =>
  new Response(error ? JSON.stringify({ error }) : "{}", { status, headers: { "Content-Type": "application/json" } });

describe("releaseAll", () => {
  it("releases every item in order, one at a time, reporting progress", async () => {
    const calls: number[] = [];
    const progress: number[] = [];
    const out = await releaseAll(
      [1, 2, 3],
      async (id) => (calls.push(id), reply(200)),
      (n) => progress.push(n),
    );
    expect(out).toEqual({ released: 3, skipped: 0, error: null, notReached: 0 });
    expect(calls).toEqual([1, 2, 3]);
    expect(progress).toEqual([1, 2, 3]);
  });

  it("skips items already handled or conflicted and carries on", async () => {
    const statuses: Record<number, number> = { 1: 409, 2: 200, 3: 404, 4: 403, 5: 200 };
    const out = await releaseAll([1, 2, 3, 4, 5], async (id) => reply(statuses[id]));
    expect(out).toEqual({ released: 2, skipped: 3, error: null, notReached: 0 });
  });

  it("stops at the first other failure, naming it and counting what was not tried", async () => {
    const calls: number[] = [];
    const out = await releaseAll([1, 2, 3, 4], async (id) => (calls.push(id), id === 2 ? reply(500, "Internal error") : reply(200)));
    expect(out).toEqual({ released: 1, skipped: 0, error: "Internal error", notReached: 2 });
    expect(calls).toEqual([1, 2]);
  });

  it("stops on a network failure", async () => {
    const out = await releaseAll([1, 2], async () => {
      throw new Error("offline");
    });
    expect(out).toEqual({ released: 0, skipped: 0, error: "offline", notReached: 1 });
  });
});
