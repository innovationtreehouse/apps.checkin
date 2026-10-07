import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_WINDOW_DAYS, QuickBooksClient, assertRealmAllowed, qboDate, qboRealmFromEnv, qboString } from "../client";
import type { AccessTokenSource } from "../types";

const tokens: AccessTokenSource = { current: async () => "tok" };
const sandbox = { env: "sandbox" as const, realmId: "123" };

let fetchMock: ReturnType<typeof vi.fn>;
const sql = (call: number): string => new URL(fetchMock.mock.calls[call][0] as string).searchParams.get("query")!;
const respond = (entity: string, rows: unknown[]) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ QueryResponse: { [entity]: rows } }), { headers: { intuit_tid: "tid-1" } }),
  );

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("query literals", () => {
  it("escapes quotes and backslashes", () => {
    expect(qboString("Bob's")).toBe("'Bob\\'s'");
    expect(qboString("a\\' OR '1'='1")).toBe("'a\\\\\\' OR \\'1\\'=\\'1'");
  });
  it("rejects control characters", () => {
    expect(() => qboString("a\nb")).toThrow(/control character/);
    expect(() => qboString("a\u0000")).toThrow(/control character/);
  });
  it("accepts only real YYYY-MM-DD dates", () => {
    expect(qboDate("2024-02-29")).toBe("'2024-02-29'");
    for (const bad of ["2023-02-29", "2024-13-01", "2024-1-01", "2024-01-01' OR 1=1", "", "0050-01-01"]) {
      expect(() => qboDate(bad)).toThrow(/Invalid QBO date/);
    }
  });
});

describe("realm guard", () => {
  it("allows production only when CHECKIN_ENV=prod", () => {
    const prod = { env: "production" as const, realmId: "9" };
    for (const env of [undefined, "", "dev", "local", "stg", "PROD"]) {
      vi.stubEnv("CHECKIN_ENV", env);
      expect(() => new QuickBooksClient(tokens, prod)).toThrow(/CHECKIN_ENV=prod/);
    }
    vi.stubEnv("CHECKIN_ENV", "prod");
    expect(() => new QuickBooksClient(tokens, prod)).not.toThrow();
  });
  it("allows sandbox anywhere", () => {
    vi.stubEnv("CHECKIN_ENV", "dev");
    expect(() => assertRealmAllowed(sandbox)).not.toThrow();
  });
  it("rejects a non-numeric realmId", () => {
    expect(() => assertRealmAllowed({ env: "sandbox", realmId: "1/../2" })).toThrow(/numeric/);
  });
  it("reads the realm from env and applies the guard", () => {
    vi.stubEnv("QBO_REALM_ID", "77");
    vi.stubEnv("QBO_ENVIRONMENT", "production");
    vi.stubEnv("CHECKIN_ENV", "dev");
    expect(() => qboRealmFromEnv()).toThrow(/CHECKIN_ENV=prod/);
    vi.stubEnv("CHECKIN_ENV", "prod");
    expect(qboRealmFromEnv()).toEqual({ env: "production", realmId: "77" });
    vi.stubEnv("QBO_ENVIRONMENT", "prodution");
    expect(() => qboRealmFromEnv()).toThrow(/sandbox or production/);
  });
});

describe("QuickBooksClient", () => {
  it("sends the source's token to the realm's host and never refreshes", async () => {
    const current = vi.fn(async () => "abc");
    respond("Deposit", []);
    await new QuickBooksClient({ current }, sandbox).depositsBetween("2025-01-01", "2025-01-08");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("https://sandbox-quickbooks.api.intuit.com/v3/company/123/query?")).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer abc");
    expect(current).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces an HTTP error with the intuit_tid", async () => {
    fetchMock.mockResolvedValueOnce(new Response("expired", { status: 401, headers: { intuit_tid: "t9" } }));
    await expect(new QuickBooksClient(tokens, sandbox).billsBetween("2025-01-01", "2025-01-02")).rejects.toThrow(
      /401 \(intuit_tid=t9\)/,
    );
  });

  it.each([
    ["purchasesBetween", "Purchase"],
    ["billsBetween", "Bill"],
    ["billPaymentsBetween", "BillPayment"],
    ["depositsBetween", "Deposit"],
  ] as const)("%s queries %s inside the window", async (method, entity) => {
    respond(entity, [{ Id: "1" }]);
    const client = new QuickBooksClient(tokens, sandbox);
    await expect(client[method]("2025-03-01", "2025-03-08")).resolves.toEqual([{ Id: "1" }]);
    expect(sql(0)).toBe(
      `SELECT * FROM ${entity} WHERE TxnDate >= '2025-03-01' AND TxnDate <= '2025-03-08' STARTPOSITION 1 MAXRESULTS 1000`,
    );
  });

  it("accepts a window of exactly MAX_WINDOW_DAYS", async () => {
    respond("Bill", []);
    // 2025-01-01..2025-04-03 inclusive is 93 days; one more day is refused
    expect(MAX_WINDOW_DAYS).toBe(93);
    await expect(new QuickBooksClient(tokens, sandbox).billsBetween("2025-01-01", "2025-04-03")).resolves.toEqual([]);
    await expect(new QuickBooksClient(tokens, sandbox).billsBetween("2025-01-01", "2025-04-04")).rejects.toThrow(/94 days/);
  });

  it("pages until a short page", async () => {
    respond("Deposit", Array.from({ length: 1000 }, (_, i) => ({ Id: String(i) })));
    respond("Deposit", [{ Id: "x" }]);
    const rows = await new QuickBooksClient(tokens, sandbox).depositsBetween("2025-01-01", "2025-01-31");
    expect(rows).toHaveLength(1001);
    expect(sql(1)).toMatch(/STARTPOSITION 1001 MAXRESULTS 1000$/);
  });

  it("rejects a bad or reversed window before any request", async () => {
    const client = new QuickBooksClient(tokens, sandbox);
    await expect(client.depositsBetween("2025-01-01' OR ''='", "2025-01-02")).rejects.toThrow(/Invalid QBO date/);
    await expect(client.purchasesBetween("2025-02-01", "2025-01-01")).rejects.toThrow(/reversed/);
    await expect(client.billPaymentsBetween("2024-01-01", "2025-01-01")).rejects.toThrow(/limit is 93/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks up accounts and classes by FullyQualifiedName, vendors by DisplayName", async () => {
    const client = new QuickBooksClient(tokens, sandbox);
    const acct = { Id: "1", Name: "Kid's Fund", FullyQualifiedName: "Programs:Kid's Fund" };
    respond("Account", [acct]);
    respond("Class", [{ Id: "2", Name: "Robotics", FullyQualifiedName: "Robotics" }]);
    respond("Vendor", [{ Id: "3", DisplayName: "O'Reilly" }]);
    respond("Vendor", []);
    await expect(client.accountNamed("Programs:Kid's Fund")).resolves.toEqual(acct);
    await expect(client.classNamed("Robotics")).resolves.toMatchObject({ Id: "2" });
    await expect(client.vendorNamed("O'Reilly")).resolves.toEqual({ Id: "3", DisplayName: "O'Reilly" });
    await expect(client.vendorNamed("Nobody")).resolves.toBeNull();
    expect(sql(0)).toBe("SELECT * FROM Account WHERE FullyQualifiedName = 'Programs:Kid\\'s Fund'");
    expect(sql(1)).toBe("SELECT * FROM Class WHERE FullyQualifiedName = 'Robotics'");
    expect(sql(2)).toBe("SELECT * FROM Vendor WHERE DisplayName = 'O\\'Reilly'");
  });
});
