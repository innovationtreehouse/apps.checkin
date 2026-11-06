import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, createClient, errorMessage, lastPage, paged } from "./index";

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
    stub(500, "<html>");
    await expect(api("/x")).rejects.toThrow("HTTP 500");
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

  it("says a sleeping app is starting up on a non-JSON 503, with write wording for a write", async () => {
    stub(503, "<html>Waking up</html>");
    await expect(api("/x", { method: "PUT", body: "{}" })).rejects.toThrow(
      "The app was asleep and is starting up. Nothing was saved. Try again in a minute.",
    );
    stub(503, "<html>Waking up</html>");
    await expect(api("/x")).rejects.toThrow("The app was asleep and is starting up. Try again in a minute.");
  });

  it("treats a 503 with Retry-After and no route error as a sleeping app", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503, headers: { "Retry-After": "30" } })));
    await expect(api("/x", { method: "POST" })).rejects.toMatchObject({
      message: "The app was asleep and is starting up. Nothing was saved. Try again in a minute.",
      status: 503,
    });
  });

  it("keeps a route's own JSON 503 message", async () => {
    stub(503, JSON.stringify({ error: "QuickBooks is not connected." }));
    await expect(api("/x", { method: "PUT" })).rejects.toThrow("QuickBooks is not connected.");
  });

  it.each([502, 504])("says the server is unavailable on a read that gets a non-JSON %i", async (status) => {
    stub(status, "<html>");
    await expect(api("/x")).rejects.toThrow("The server is unavailable. Try again in a minute.");
  });

  it.each([502, 504])("asks to check before retrying a write that gets a non-JSON %i, since it may have saved", async (status) => {
    stub(status, "<html>");
    await expect(api("/x", { method: "POST" })).rejects.toThrow("The server didn't answer. Check whether it saved before trying again.");
  });

  it("sends a write once when the app is asleep", async () => {
    const fetchMock = stub(503, "<html>");
    await api("/x", { method: "POST" }).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says the server is unreachable when the request never lands", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const thrown = await api("/x").catch((e: unknown) => e);
    expect(thrown).not.toBeInstanceOf(HttpError);
    expect(errorMessage(thrown)).toBe("Couldn't reach the server. Check your connection and try again.");
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
