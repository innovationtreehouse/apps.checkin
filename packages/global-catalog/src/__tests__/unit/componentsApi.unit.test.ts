import { afterEach, describe, expect, it, vi } from "vitest";
import { api, lastPage, latestGate } from "../../components/api";

function stubFetch(status: number, body: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status })));
}

describe("api()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the parsed body on success", async () => {
    stubFetch(200, JSON.stringify([{ id: 1 }]));
    await expect(api("/items")).resolves.toEqual([{ id: 1 }]);
  });

  it("surfaces the JSON error message on failure", async () => {
    stubFetch(403, JSON.stringify({ error: "Forbidden" }));
    await expect(api("/items")).rejects.toThrow("Forbidden");
  });

  it("falls back to the status for a non-JSON error body", async () => {
    stubFetch(502, "<html>Bad Gateway</html>");
    await expect(api("/items")).rejects.toThrow("HTTP 502");
  });

  it("rejects a non-JSON success body instead of returning it", async () => {
    stubFetch(200, "<html>sign in</html>");
    await expect(api("/items")).rejects.toThrow("HTTP 200");
  });
});

describe("latestGate()", () => {
  it("only the most recent request stays current", () => {
    const begin = latestGate();
    const first = begin();
    const second = begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});

describe("lastPage()", () => {
  it("is at least 1 and rounds partial pages up", () => {
    expect(lastPage(0, 50)).toBe(1);
    expect(lastPage(50, 50)).toBe(1);
    expect(lastPage(51, 50)).toBe(2);
  });
});
