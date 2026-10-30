import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, lastPage, paged } from "./index";

afterEach(() => vi.unstubAllGlobals());

const stub = (status: number, body: string) => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("createClient api", () => {
  const { api } = createClient("/api/things");

  it("prefixes the base unless the path is already under /api/", async () => {
    const fetchMock = stub(200, "[]");
    await api("/x");
    await api("/api/other");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/things/x", "/api/other"]);
  });

  it("leaves the content type to the browser for a form body", async () => {
    const fetchMock = stub(200, "{}");
    await api("/upload", { method: "POST", body: new FormData() });
    expect(fetchMock.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it("throws the route's error, or the status for a non-JSON body", async () => {
    stub(403, JSON.stringify({ error: "Forbidden" }));
    await expect(api("/x")).rejects.toThrow("Forbidden");
    stub(502, "<html>");
    await expect(api("/x")).rejects.toThrow("HTTP 502");
    stub(200, "<html>");
    await expect(api("/x")).rejects.toThrow("Unexpected non-JSON response (HTTP 200)");
  });
});

describe("paging", () => {
  it("adds page and limit to a path with or without a query", () => {
    expect(paged("/a", 2)).toBe("/a?page=2&limit=50");
    expect(paged("/a?b=1", 1)).toBe("/a?b=1&page=1&limit=50");
  });

  it("lastPage is at least 1 and rounds partial pages up", () => {
    expect(lastPage(0)).toBe(1);
    expect(lastPage(51)).toBe(2);
    expect(lastPage(51, 25)).toBe(3);
  });
});
