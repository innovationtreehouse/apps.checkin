import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authUrl, exchangeCode, GMAIL_READONLY_SCOPE } from "./oauth";
import { INVALID_GRANT_MARKER, run, type CredentialStore } from "./refresher";

const NOW = 1_800_000_000_000;
const CLIENT = { clientId: "test-id", clientSecret: "test-secret" };
const store: CredentialStore = {
  loadClient: async () => CLIENT,
  loadGrant: async () => ({ refreshToken: "test-refresh", mailbox: "receipts@example.com" }),
};

const fetchMock = vi.fn<typeof fetch>();
const googleAnswers = (body: unknown, status = 200) => fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("run", () => {
  it.each(["current", "keepalive"])("%s refreshes and answers the shape the app parses", async (action) => {
    googleAnswers({ access_token: "new-access", expires_in: 3599 });

    await expect(run({ action }, store)).resolves.toEqual({ accessToken: "new-access", expiresAt: NOW + 3_599_000, mailbox: "receipts@example.com" });

    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("test-refresh");
  });

  it("rejects an unknown action without calling Google", async () => {
    await expect(run({ action: "rotate" }, store)).rejects.toThrow(/unknown action/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs the alarm marker on invalid_grant, without secrets", async () => {
    googleAnswers({ error: "invalid_grant", error_description: "detail" }, 400);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(run({ action: "current" }, store)).rejects.toThrow(/invalid_grant/);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorSpy.mock.calls[0]);
    expect(logged).toContain(INVALID_GRANT_MARKER);
    for (const secret of ["test-refresh", "test-secret"]) expect(logged).not.toContain(secret);
  });

  it("raises no alarm on other failures and keeps the body out of the error", async () => {
    googleAnswers({ error: "server_error", error_description: "echoed-detail" }, 500);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(run({ action: "current" }, store)).rejects.toThrow(/^Google token request failed 500: server_error$/);

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("consent", () => {
  it("asks for gmail.readonly alone, offline", () => {
    const q = new URL(authUrl("test-id", "http://localhost:8087/callback", "receipts@example.com", "st")).searchParams;
    expect(q.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
  });

  it("returns the refresh token of a gmail.readonly grant", async () => {
    googleAnswers({ access_token: "a", expires_in: 3599, refresh_token: "r", scope: GMAIL_READONLY_SCOPE });
    await expect(exchangeCode(CLIENT, "code", "http://localhost/cb")).resolves.toEqual({ accessToken: "a", refreshToken: "r" });
  });

  it("refuses a grant with any other scope", async () => {
    googleAnswers({ access_token: "a", expires_in: 3599, refresh_token: "r", scope: `${GMAIL_READONLY_SCOPE} openid` });
    await expect(exchangeCode(CLIENT, "code", "http://localhost/cb")).rejects.toThrow(/scope/);
  });

  it("refuses an answer without a refresh token", async () => {
    googleAnswers({ access_token: "a", expires_in: 3599, scope: GMAIL_READONLY_SCOPE });
    await expect(exchangeCode(CLIENT, "code", "http://localhost/cb")).rejects.toThrow(/refresh token/);
  });
});
