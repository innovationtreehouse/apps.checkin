/**
 * @jest-environment node
 */
import { accessTokenFrom, qboAccessTokenSource, qboRealm } from "@/lib/quickbooks/connection";

describe("qboRealm", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("is null without QBO_REALM_ID", () => {
    delete process.env.QBO_REALM_ID;
    expect(qboRealm()).toBeNull();
  });

  it("uses the production company only when CHECKIN_ENV=prod", () => {
    process.env.QBO_REALM_ID = "123";
    for (const [checkinEnv, qboEnv] of [["prod", "production"], ["dev", "sandbox"], ["local", "sandbox"], [undefined, "sandbox"]]) {
      if (checkinEnv === undefined) delete process.env.CHECKIN_ENV;
      else process.env.CHECKIN_ENV = checkinEnv;
      expect(qboRealm()).toEqual({ env: qboEnv, realmId: "123" });
    }
  });
});

describe("accessTokenFrom", () => {
  it("reads a bare token or a JSON accessToken", () => {
    expect(accessTokenFrom(" tok-1 \n")).toBe("tok-1");
    expect(accessTokenFrom('{"accessToken":"tok-2","refreshToken":"r"}')).toBe("tok-2");
  });

  it("rejects JSON without an accessToken", () => {
    expect(() => accessTokenFrom('{"refreshToken":"r"}')).toThrow("no accessToken");
  });
});

describe("qboAccessTokenSource", () => {
  it("fails closed when no token is published", async () => {
    delete process.env.QBO_ACCESS_TOKEN_SECRET_ID;
    delete process.env.QBO_ACCESS_TOKEN;
    await expect(qboAccessTokenSource().current()).rejects.toThrow("QBO_ACCESS_TOKEN is not set");
  });
});
