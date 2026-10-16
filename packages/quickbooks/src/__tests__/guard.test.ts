import { describe, expect, it } from "vitest";
import { TEST_NOTE_MARKER, assertPayloadMarked, assertQboClientId, assertQboTarget, type QboTargetConfig } from "../guard";

const SANDBOX = "1111";
const PROD = "9999";

const nonProd = (over: Partial<QboTargetConfig> = {}): QboTargetConfig => ({
  checkinEnv: "dev",
  realm: { env: "sandbox", realmId: SANDBOX },
  sandboxRealmAllowed: SANDBOX,
  ...over,
});

const prod = (over: Partial<QboTargetConfig> = {}): QboTargetConfig => ({
  checkinEnv: "prod",
  realm: { env: "production", realmId: PROD },
  sandboxRealmAllowed: undefined,
  ...over,
});

describe("assertQboTarget off prod", () => {
  it("allows the allowlisted sandbox realm on dev", () => {
    expect(() => assertQboTarget(nonProd())).not.toThrow();
  });
  it("reaches nothing on stg, local or an unset env", () => {
    for (const checkinEnv of ["stg", "local", "PROD", undefined, ""]) {
      expect(() => assertQboTarget(nonProd({ checkinEnv }))).toThrow(/only on CHECKIN_ENV=prod or dev/);
    }
  });
  it("keeps stg off a production realm even when it is configured like prod", () => {
    const stg = nonProd({ checkinEnv: "stg", realm: { env: "production", realmId: PROD }, sandboxRealmAllowed: undefined });
    expect(() => assertQboTarget(stg)).toThrow(/only on CHECKIN_ENV=prod or dev/);
  });
  it("refuses the production API", () => {
    expect(() => assertQboTarget(nonProd({ realm: { env: "production", realmId: SANDBOX } }))).toThrow(/Only CHECKIN_ENV=prod/);
  });
  it("refuses a missing allowlist", () => {
    expect(() => assertQboTarget(nonProd({ sandboxRealmAllowed: undefined }))).toThrow(/QBO_SANDBOX_REALM_ALLOWED/);
  });
  it("refuses a realm the allowlist does not name", () => {
    expect(() => assertQboTarget(nonProd({ realm: { env: "sandbox", realmId: "2222" } }))).toThrow(/allowlisted/);
  });
});

describe("assertQboTarget on prod", () => {
  it("allows the configured realm through the production API", () => {
    expect(() => assertQboTarget(prod())).not.toThrow();
  });
  it("refuses the sandbox API", () => {
    expect(() => assertQboTarget(prod({ realm: { env: "sandbox", realmId: PROD } }))).toThrow(/must use the production/);
  });
});

it("refuses a non-numeric realm everywhere", () => {
  expect(() => assertQboTarget(nonProd({ realm: { env: "sandbox", realmId: "1 OR 1" }, sandboxRealmAllowed: "1 OR 1" }))).toThrow(/numeric/);
  expect(() => assertQboTarget(prod({ realm: { env: "production", realmId: "x" } }))).toThrow(/numeric/);
});

describe("assertQboClientId", () => {
  it("off prod, requires the development keys", () => {
    expect(() => assertQboClientId("dev", "dev-id", "dev-id")).not.toThrow();
    expect(() => assertQboClientId(undefined, "prod-id", "dev-id")).toThrow(/development keys/);
  });
  it("on prod, refuses the development keys", () => {
    expect(() => assertQboClientId("prod", "prod-id", "dev-id")).not.toThrow();
    expect(() => assertQboClientId("prod", "dev-id", "dev-id")).toThrow(/refuses the development/);
  });
  it("needs the development client id configured", () => {
    expect(() => assertQboClientId("prod", "prod-id", undefined)).toThrow(/QBO_DEV_CLIENT_ID/);
  });
});

describe("assertPayloadMarked", () => {
  const note = (PrivateNote: string) => ({ TxnDate: "2026-01-02", PrivateNote });
  it("sandbox writes must carry the marker", () => {
    expect(() => assertPayloadMarked("sandbox", "Deposit", note(`${TEST_NOTE_MARKER} [checkin:k-1]`))).not.toThrow();
    expect(() => assertPayloadMarked("sandbox", "Deposit", note("[checkin:k-1]"))).toThrow(/missing the test marker/);
    expect(() => assertPayloadMarked("sandbox", "Deposit", { TxnDate: "2026-01-02" })).toThrow(/missing the test marker/);
    expect(() => assertPayloadMarked("sandbox", "Vendor", { DisplayName: "TEST-Ann Lee" })).not.toThrow();
    expect(() => assertPayloadMarked("sandbox", "Vendor", { DisplayName: "Ann Lee" })).toThrow(/missing the test marker/);
  });
  it("sandbox writes must not name the org, anywhere in the body", () => {
    expect(() => assertPayloadMarked("sandbox", "Vendor", { DisplayName: "TEST-Treehouse Supply" })).toThrow(/names the org/);
    const body = { ...note(`${TEST_NOTE_MARKER} [checkin:k-1]`), Line: [{ Description: "TREEHOUSE camp" }] };
    expect(() => assertPayloadMarked("sandbox", "Deposit", body)).toThrow(/names the org/);
  });
  it("production writes must not carry the marker", () => {
    expect(() => assertPayloadMarked("production", "Bill", note("Treehouse camp [checkin:k-1]"))).not.toThrow();
    expect(() => assertPayloadMarked("production", "Bill", note(`${TEST_NOTE_MARKER} [checkin:k-1]`))).toThrow(/carries the test marker/);
    expect(() => assertPayloadMarked("production", "Vendor", { DisplayName: "TEST-Ann Lee" })).toThrow(/carries the test marker/);
    expect(() => assertPayloadMarked("production", "Vendor", { DisplayName: "Ann Lee" })).not.toThrow();
  });
});
