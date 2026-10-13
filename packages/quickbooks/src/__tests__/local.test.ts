import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envAccessTokenSource, fileAccessTokenSource, loadTokens, saveTokens, tokenFileFromEnv } from "../local";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const tokenFile = () => join(mkdtempSync(join(tmpdir(), "qbo-")), "tokens.json");
const saved = { accessToken: "old", refreshToken: "r1", expiresIn: 3600, realmId: "1" };

describe("local token sources", () => {
  it("requires an explicit token file path", () => {
    vi.stubEnv("QBO_TOKEN_FILE", "");
    expect(() => tokenFileFromEnv()).toThrow(/QBO_TOKEN_FILE/);
  });

  it("env source returns QBO_ACCESS_TOKEN", async () => {
    vi.stubEnv("QBO_ACCESS_TOKEN", "envtok");
    await expect(envAccessTokenSource().current()).resolves.toBe("envtok");
  });

  it("file source returns a fresh token without calling Intuit", async () => {
    const path = tokenFile();
    saveTokens(path, { ...saved, obtainedAt: Date.now() });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fileAccessTokenSource(path).current()).resolves.toBe("old");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("file source refreshes an expired token and saves the rotated refresh token", async () => {
    const path = tokenFile();
    saveTokens(path, { ...saved, obtainedAt: 0 });
    vi.stubEnv("QBO_CLIENT_ID", "id");
    vi.stubEnv("QBO_CLIENT_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "new", refresh_token: "r2", expires_in: 3600 })),
    );
    await expect(fileAccessTokenSource(path).current()).resolves.toBe("new");
    expect(loadTokens(path)).toMatchObject({ accessToken: "new", refreshToken: "r2", realmId: "1" });
  });
});
