import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeCode, refreshTokens, type OauthConfig } from "../oauth";
import type { QboTokens } from "../types";

const cfg: OauthConfig = { clientId: "id", clientSecret: "secret", redirectUri: "http://localhost/cb" };
const stored: QboTokens = { accessToken: "old-access", refreshToken: "old-refresh", expiresIn: 3600, obtainedAt: 0, realmId: "123" };
const good = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, token_type: "bearer" };

let fetchMock: ReturnType<typeof vi.fn>;
const respond = (body: unknown) =>
  fetchMock.mockResolvedValueOnce(
    new Response(typeof body === "string" ? body : JSON.stringify(body), { headers: { intuit_tid: "tid-9" } }),
  );

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const calls = [
  { name: "refreshTokens", run: () => refreshTokens(cfg, stored) },
  { name: "exchangeCode", run: () => exchangeCode(cfg, "code", "123") },
];

describe.each(calls)("$name", ({ run }) => {
  it("returns the new tokens from a well-formed response", async () => {
    respond(good);
    await expect(run()).resolves.toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600, realmId: "123" });
  });

  it.each([
    ["refresh_token", { ...good, refresh_token: undefined }, /missing refresh_token/],
    ["refresh_token", { ...good, refresh_token: "" }, /missing refresh_token/],
    ["access_token", { ...good, access_token: undefined }, /missing access_token/],
    ["expires_in", { ...good, expires_in: "3600" }, /expires_in/],
    ["expires_in", { ...good, expires_in: 0 }, /expires_in/],
    ["the object", [good], /not a JSON object/],
    ["the JSON", "not json", /not valid JSON/],
  ])("refuses a response with a bad %s, naming the intuit_tid", async (_field, body, message) => {
    respond(body);
    const err: unknown = await run().catch((e: unknown) => e);
    if (!(err instanceof Error)) throw new Error("expected the call to reject with an Error");
    expect(err.message).toMatch(message);
    expect(err.message).toContain("intuit_tid=tid-9");
    expect(err.message).not.toMatch(/new-access|new-refresh/);
  });
});
