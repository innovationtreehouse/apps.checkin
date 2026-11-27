import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedAccessToken, createDirectoryClient, GoogleApiError, refreshAccessToken } from "./client";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const sleep = vi.fn(async () => {});
const client = () => createDirectoryClient({ getAccessToken: async () => "SECRET-TOKEN", sleep });

describe("directory client", () => {
  it("follows pageToken", async () => {
    const m = (email: string) => ({ email, role: "MEMBER", type: "USER", status: "ACTIVE", id: "x" });
    fetchMock.mockResolvedValueOnce(reply(200, { members: [m("a@x.org")], nextPageToken: "p2" })).mockResolvedValueOnce(reply(200, { members: [m("b@x.org")] }));
    const got = await client().listMembers("g@x.org");
    expect(got.map((x) => x.email)).toEqual(["a@x.org", "b@x.org"]);
    expect(got[0]).toEqual({ email: "a@x.org", role: "MEMBER", type: "USER", status: "ACTIVE" });
    expect(String(fetchMock.mock.calls[1][0])).toContain("pageToken=p2");
  });

  it("treats insert 409 and remove 404 as success", async () => {
    fetchMock.mockResolvedValueOnce(reply(409, { error: { errors: [{ reason: "duplicate" }] } })).mockResolvedValueOnce(reply(404));
    await client().insertMember("g@x.org", "a@x.org");
    await client().removeMember("g@x.org", "a@x.org");
  });

  it("retries 429/5xx then succeeds", async () => {
    fetchMock.mockResolvedValueOnce(reply(429)).mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200, {}));
    await client().insertMember("g@x.org", "a@x.org");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after bounded retries, error omits the token", async () => {
    fetchMock.mockImplementation(async () => reply(500, { error: "boom" }));
    const err = await client().removeMember("g@x.org", "a@x.org").catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.stringify([err.message, err.stack])).not.toContain("SECRET-TOKEN");
  });

  it("does not retry a 403", async () => {
    fetchMock.mockResolvedValueOnce(reply(403));
    await expect(client().insertMember("g@x.org", "a@x.org")).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("tokens", () => {
  it("refreshes and caches", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    fetchMock.mockImplementation(async () => reply(200, { access_token: "a", expires_in: 3600 }));
    const creds = { clientId: "id", clientSecret: "sec", refreshToken: "ref" };
    await expect(refreshAccessToken(creds)).resolves.toEqual({ accessToken: "a", expiresAt: 1_000_000 + 3_600_000 });
    const get = cachedAccessToken(() => refreshAccessToken(creds));
    await get();
    await get();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("error names Google's code, never the secrets", async () => {
    fetchMock.mockImplementation(async () => reply(400, { error: "invalid_grant", error_description: "ref sec" }));
    const err = await refreshAccessToken({ clientId: "id", clientSecret: "sec", refreshToken: "ref" }).catch((e) => e);
    expect(err.message).toBe("Google token request failed 400: invalid_grant");
  });
});
