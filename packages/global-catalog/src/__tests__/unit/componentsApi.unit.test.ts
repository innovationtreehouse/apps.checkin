import { afterEach, describe, expect, it, vi } from "vitest";
import { api, clampPage, lastPage } from "../../components/api";

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

describe("clampPage()", () => {
  it("moves back to the last page when the list shrinks, and never below 1", () => {
    expect(clampPage(3, 100, 50)).toBe(2);
    expect(clampPage(2, 100, 50)).toBe(2);
    expect(clampPage(1, 100, 50)).toBe(1);
    expect(clampPage(2, 0, 50)).toBe(1);
  });
});

describe("lastPage()", () => {
  it("is at least 1 and rounds partial pages up", () => {
    expect(lastPage(0, 50)).toBe(1);
    expect(lastPage(50, 50)).toBe(1);
    expect(lastPage(51, 50)).toBe(2);
  });
});
