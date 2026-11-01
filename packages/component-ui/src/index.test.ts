import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, createClient, lastPage, paged } from "./index";

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

  it("carries the field names a route refused, and none when it sends no usable list", async () => {
    const fieldsOf = async (body: string) => {
      stub(409, body);
      const thrown = await api("/x").catch((e: unknown) => e);
      return thrown instanceof HttpError ? thrown.fields : null;
    };
    expect(await fieldsOf(JSON.stringify({ error: "Taken", fields: ["email"] }))).toEqual(["email"]);
    expect(await fieldsOf(JSON.stringify({ error: "Taken", fields: ["email", 7] }))).toEqual(["email"]);
    expect(await fieldsOf(JSON.stringify({ error: "Taken", fields: "email" }))).toEqual([]);
    expect(await fieldsOf(JSON.stringify({ error: "Taken" }))).toEqual([]);
    expect(await fieldsOf("<html>")).toEqual([]);
  });

  it("throws an HttpError, still an Error with the route's words", async () => {
    stub(404, JSON.stringify({ error: "Gone" }));
    const thrown = await api("/x").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ message: "Gone", status: 404 });
  });

  it("does not hand the invalidate option to fetch", async () => {
    const fetchMock = stub(200, "{}");
    await api("/x", { method: "POST", invalidate: false });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("invalidate");
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
