import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickBooksClient, WRITABLE_ENTITIES, appKeyOf, assertAppKey, qbKey, type TxnWrite, type WriteRequest } from "../client";
import { createVendor, findOrCreate, type FindOrCreateRequest } from "../write";
import type { AccessTokenSource, QboDeposit } from "../types";
import { CREATE } from "../internal";
import * as pkg from "../index";

const tokens: AccessTokenSource = { current: async () => "tok" };
const sandbox = { env: "sandbox" as const, realmId: "123" };
const KEY = qbKey("income", "gid://shopify/ShopifyPaymentsPayout/9001");

let fetchMock: ReturnType<typeof vi.fn>;
type Call = { url: URL; method: string; body?: Record<string, unknown> };
const calls = (): Call[] =>
  fetchMock.mock.calls.map(([u, init]) => {
    const i = (init ?? {}) as RequestInit;
    return { url: new URL(u as string), method: i.method ?? "GET", body: i.body ? JSON.parse(i.body as string) : undefined };
  });
const posts = () => calls().filter((c) => c.method === "POST");
const queries = () => calls().filter((c) => c.method === "GET").map((c) => c.url.searchParams.get("query")!);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { intuit_tid: "tid-w" } });
const rows = (entity: string, list: unknown[]) => json({ QueryResponse: list.length ? { [entity]: list } : {} });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const deposit: TxnWrite = {
  entity: "Deposit",
  fields: {
    txnDate: "2025-03-05",
    depositToAccountId: "35",
    lines: [
      { amountCents: 100_00, accountId: "80", classId: "7", description: "Camp" },
      { amountCents: 23_45, accountId: "81" },
      { amountCents: -3_00, accountId: "90" },
    ],
    memo: "Shopify payout",
  },
};
const purchase: TxnWrite = {
  entity: "Purchase",
  fields: { txnDate: "2025-03-05", paymentType: "CreditCard", accountId: "41", vendorId: "5", lines: [{ amountCents: 19_99, accountId: "60", classId: "7" }] },
};
const bill: TxnWrite = {
  entity: "Bill",
  fields: { txnDate: "2025-03-05", vendorId: "5", dueDate: "2025-04-04", lines: [{ amountCents: 42_10, accountId: "60" }] },
};

const req = (over: Partial<FindOrCreateRequest> = {}): FindOrCreateRequest => ({
  write: deposit,
  key: KEY,
  window: { from: "2025-03-03", to: "2025-03-10" },
  takeoverLine: "2025-03-01",
  claimedIds: new Set(),
  excludedIds: new Set(),
  ...over,
});

const client = () => new QuickBooksClient(tokens, sandbox);
const qboDeposit = (Id: string, TxnDate: string, TotalAmt: number, PrivateNote?: string): QboDeposit => ({
  Id,
  TxnDate,
  TotalAmt,
  DepositToAccountRef: { value: "35" },
  PrivateNote,
});

describe("closed-enum writer", () => {
  it("writes only Purchase, Bill, Deposit and Vendor", () => {
    expect(WRITABLE_ENTITIES).toEqual(["Purchase", "Bill", "Deposit", "Vendor"]);
  });

  it.each(["BillPayment", "Payment", "JournalEntry", "Customer", "Account", "Transfer"])("refuses %s before any request", async (entity) => {
    const forged = { entity, fields: deposit.fields } as unknown as WriteRequest;
    await expect(client()[CREATE](forged, KEY)).rejects.toThrow(/not writable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a Check-type Purchase", async () => {
    const check = { entity: "Purchase", fields: { ...purchase.fields, paymentType: "Check" } } as unknown as WriteRequest;
    await expect(client()[CREATE](check, KEY)).rejects.toThrow(/Cash or CreditCard/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("has exactly one QuickBooks POST in the package source, the create path", () => {
    const dir = join(__dirname, "..");
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "oauth.ts")
      .flatMap((f) => (readFileSync(join(dir, f), "utf-8").match(/method:\s*"(POST|PUT|PATCH|DELETE)"/g) ?? []).map((m) => `${f}:${m}`));
    expect(hits).toEqual(['client.ts:method: "POST"']);
  });

  it("sends only allowlisted fields: never Id, SyncToken, sparse or an operation", async () => {
    fetchMock.mockResolvedValueOnce(json({ Deposit: { Id: "500" } }));
    await expect(client()[CREATE](deposit, KEY)).resolves.toEqual({ Id: "500" });
    const [c] = posts();
    expect(c.url.pathname).toBe("/v3/company/123/deposit");
    expect(c.url.searchParams.get("operation")).toBeNull();
    expect(c.body).toEqual({
      TxnDate: "2025-03-05",
      DepositToAccountRef: { value: "35" },
      Line: [
        { Amount: 100, DetailType: "DepositLineDetail", DepositLineDetail: { AccountRef: { value: "80" }, ClassRef: { value: "7" } }, Description: "Camp" },
        { Amount: 23.45, DetailType: "DepositLineDetail", DepositLineDetail: { AccountRef: { value: "81" } } },
        { Amount: -3, DetailType: "DepositLineDetail", DepositLineDetail: { AccountRef: { value: "90" } } },
      ],
      PrivateNote: `Shopify payout\n[checkin:${KEY}]`,
    });
  });

  it("builds a Purchase against the paying account and a Bill to the vendor", async () => {
    fetchMock.mockResolvedValueOnce(json({ Purchase: { Id: "1" } })).mockResolvedValueOnce(json({ Bill: { Id: "2" } }));
    await client()[CREATE](purchase, "k-1");
    await client()[CREATE](bill, "k-2");
    const [p, b] = posts();
    expect(p.body).toEqual({
      TxnDate: "2025-03-05",
      PaymentType: "CreditCard",
      AccountRef: { value: "41" },
      EntityRef: { value: "5", type: "Vendor" },
      Line: [{ Amount: 19.99, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "60" }, ClassRef: { value: "7" } } }],
      PrivateNote: "[checkin:k-1]",
    });
    expect(b.body).toEqual({
      TxnDate: "2025-03-05",
      VendorRef: { value: "5" },
      DueDate: "2025-04-04",
      Line: [{ Amount: 42.1, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "60" } } }],
      PrivateNote: "[checkin:k-2]",
    });
  });

  it("sends the caller's key as requestid on every write", async () => {
    const writes: WriteRequest[] = [deposit, purchase, bill, { entity: "Vendor", fields: { displayName: "Ann" } }];
    for (const w of writes) fetchMock.mockResolvedValueOnce(json({ [w.entity]: { Id: "9" } }));
    for (const [i, w] of writes.entries()) await client()[CREATE](w, `key-${i}`);
    expect(posts().map((c) => [c.url.pathname.split("/").pop(), c.url.searchParams.get("requestid")])).toEqual([
      ["deposit", "key-0"],
      ["purchase", "key-1"],
      ["bill", "key-2"],
      ["vendor", "key-3"],
    ]);
  });

  it.each([
    ["a quote", "k'1"],
    ["a space", "k 1"],
    ["empty", ""],
    ["51 chars", "k".repeat(51)],
  ])("rejects a key with %s", async (_, key) => {
    await expect(client()[CREATE](deposit, key)).rejects.toThrow(/app key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-integer cents, non-numeric refs, empty lines and a forged key marker", async () => {
    const bad: TxnWrite[] = [
      { entity: "Deposit", fields: { ...deposit.fields, lines: [{ amountCents: 1.5, accountId: "80" }] } },
      { entity: "Deposit", fields: { ...deposit.fields, depositToAccountId: "35' OR 1=1" } },
      { entity: "Deposit", fields: { ...deposit.fields, lines: [] } },
      { entity: "Deposit", fields: { ...deposit.fields, memo: "[checkin:other]" } },
      { entity: "Deposit", fields: { ...deposit.fields, txnDate: "2025-02-30" } },
    ];
    for (const w of bad) await expect(client()[CREATE](w, KEY)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a QBO rejection with the intuit_tid and fault codes, never the fault text", async () => {
    const fault = { Fault: { Error: [{ Message: "Duplicate Name Exists Error", Detail: "The name supplied already exists: Pat O'Neil", code: "6240" }], type: "ValidationFault" } };
    fetchMock.mockResolvedValueOnce(json(fault, 400));
    const err = await client()[CREATE](deposit, KEY).catch((e: Error) => e);
    expect(String(err)).toMatch(/create Deposit failed 400 \(intuit_tid=tid-w\): codes 6240$/);
    expect(String(err)).not.toMatch(/Pat|Duplicate/);
  });

  it("has no public create: the package exports no way to write without the key lookup", () => {
    const c = client() as unknown as Record<string, unknown>;
    expect(c.create).toBeUndefined();
    expect(Object.values(pkg)).not.toContain(CREATE);
    const pkgJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8")) as { exports: Record<string, unknown> };
    expect(Object.keys(pkgJson.exports)).toEqual(["."]);
  });
});

describe("request limits", () => {
  it("sends every request with a timeout signal", async () => {
    fetchMock.mockResolvedValueOnce(rows("Deposit", [])).mockResolvedValueOnce(json({ Deposit: { Id: "1" } }));
    await findOrCreate(client(), req());
    for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("retries a 429 once after Retry-After, with the same requestid", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(json({ Deposit: { Id: "5" } }));
    await expect(client()[CREATE](deposit, KEY)).resolves.toEqual({ Id: "5" });
    expect(posts().map((c) => c.url.searchParams.get("requestid"))).toEqual([KEY, KEY]);
  });

  it("fails on a second 429", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "0" } }));
    await expect(client()[CREATE](deposit, KEY)).rejects.toThrow(/failed 429/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns failed when a request times out, without posting", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(findOrCreate(client(), req())).resolves.toMatchObject({ kind: "failed", error: expect.stringMatching(/timeout/) });
    expect(posts()).toEqual([]);
  });
});

describe("prod-realm guard on writes", () => {
  const prod = { env: "production" as const, realmId: "9" };

  it("writes to production only while CHECKIN_ENV=prod", async () => {
    vi.stubEnv("CHECKIN_ENV", "prod");
    const c = new QuickBooksClient(tokens, prod);
    fetchMock.mockResolvedValueOnce(json({ Deposit: { Id: "1" } }));
    await c[CREATE](deposit, KEY);
    expect(posts()[0].url.host).toBe("quickbooks.api.intuit.com");

    for (const env of ["dev", "local", "", "PROD"]) {
      vi.stubEnv("CHECKIN_ENV", env);
      await expect(c[CREATE](deposit, KEY)).rejects.toThrow(/CHECKIN_ENV=prod/);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("writes to the sandbox from any env", async () => {
    vi.stubEnv("CHECKIN_ENV", "dev");
    fetchMock.mockResolvedValueOnce(json({ Deposit: { Id: "1" } }));
    await client()[CREATE](deposit, KEY);
    expect(posts()[0].url.host).toBe("sandbox-quickbooks.api.intuit.com");
  });
});

describe("qbKey", () => {
  it("keeps a short source id readable", () => {
    expect(qbKey("income", "gid://shopify/ShopifyPaymentsPayout/9001")).toBe("income:gid://shopify/ShopifyPaymentsPayout/9001");
  });

  it("hashes a key that would pass 50 chars, deterministically", () => {
    const long = "org_cm1x2y3z4a5b6c7d8e9f0g1h2:disb_cm9z8y7x6w5v4u3t2s1r0q9p8";
    const key = qbKey("bulk-donation", long);
    expect(key).toMatch(/^bulk-donation:h:[0-9a-f]{32}$/);
    expect(key.length).toBeLessThanOrEqual(50);
    expect(qbKey("bulk-donation", long)).toBe(key);
    expect(qbKey("bulk-donation", `${long}x`)).not.toBe(key);
    expect(() => assertAppKey(key)).not.toThrow();
  });

  it("hashes a source id outside the key charset", () => {
    expect(qbKey("expense", "line 7")).toMatch(/^expense:h:[0-9a-f]{32}$/);
  });

  it("rejects a bad lane or empty source id", () => {
    for (const lane of ["", "Income", "in:come", "a-lane-name-too-long"]) expect(() => qbKey(lane, "1")).toThrow(/lane/);
    expect(() => qbKey("income", "")).toThrow(/sourceId/);
  });
});

describe("appKeyOf", () => {
  it("reads the key a created entry carries and ignores hand memos", () => {
    expect(appKeyOf({ PrivateNote: `Shopify payout\n[checkin:${KEY}]` })).toBe(KEY);
    expect(appKeyOf({ PrivateNote: "Deposit from bank feed" })).toBeUndefined();
    expect(appKeyOf({})).toBeUndefined();
  });

  it("reads a well-formed marker anywhere in the note, standing alone", () => {
    expect(appKeyOf({ PrivateNote: `[checkin:${KEY}]` })).toBe(KEY);
    expect(appKeyOf({ PrivateNote: `[checkin:${KEY}]\nnote added after` })).toBe(KEY);
    expect(appKeyOf({ PrivateNote: `Shopify payout [checkin:${KEY}] copied` })).toBe(KEY);
    expect(appKeyOf({ PrivateNote: `[checkin:${KEY}]\n[checkin:${KEY}]` })).toBe(KEY);
  });

  it("reads a marker next to punctuation or text", () => {
    expect(appKeyOf({ PrivateNote: "Memo:[checkin:k-1]" })).toBe("k-1");
    expect(appKeyOf({ PrivateNote: "([checkin:k-1])" })).toBe("k-1");
    expect(appKeyOf({ PrivateNote: "x[checkin:k-1]x" })).toBe("k-1");
  });

  it("ignores a malformed marker", () => {
    expect(appKeyOf({ PrivateNote: "[checkin:k 1]" })).toBeUndefined();
    expect(appKeyOf({ PrivateNote: "[checkin:]" })).toBeUndefined();
    expect(appKeyOf({ PrivateNote: "[ checkin:k-1]" })).toBeUndefined();
    expect(appKeyOf({ PrivateNote: `[checkin:${"k".repeat(51)}]` })).toBeUndefined();
  });

  it("returns two different markers space-joined, so they equal no key", () => {
    expect(appKeyOf({ PrivateNote: "[checkin:k-1]\n[checkin:k-2]" })).toBe("k-1 k-2");
  });
});

describe("findOrCreate", () => {
  it("found on amount: links the hand entry and posts nothing", async () => {
    fetchMock.mockResolvedValueOnce(rows("Deposit", [qboDeposit("10", "2025-03-06", 120.45)]));
    await expect(findOrCreate(client(), req())).resolves.toEqual({ kind: "found", id: "10", via: "amount" });
    expect(queries()).toEqual([
      "SELECT * FROM Deposit WHERE TxnDate >= '2025-03-03' AND TxnDate <= '2025-03-10' STARTPOSITION 1 MAXRESULTS 1000",
    ]);
    expect(posts()).toEqual([]);
  });

  it("ambiguous: returns every candidate for finance and posts nothing", async () => {
    fetchMock.mockResolvedValueOnce(rows("Deposit", [qboDeposit("10", "2025-03-04", 120.45), qboDeposit("11", "2025-03-07", 120.45)]));
    await expect(findOrCreate(client(), req())).resolves.toEqual({ kind: "ambiguous", ids: ["10", "11"] });
    expect(posts()).toEqual([]);
  });

  it("not found after the line: creates once, keyed", async () => {
    fetchMock.mockResolvedValueOnce(rows("Deposit", [qboDeposit("10", "2025-03-06", 99)])).mockResolvedValueOnce(json({ Deposit: { Id: "77" } }));
    await expect(findOrCreate(client(), req())).resolves.toEqual({ kind: "created", id: "77" });
    const [c] = posts();
    expect(c.url.searchParams.get("requestid")).toBe(KEY);
    expect(appKeyOf({ PrivateNote: c.body?.PrivateNote as string })).toBe(KEY);
  });

  it("not found before the line: too old, never created", async () => {
    fetchMock.mockResolvedValueOnce(rows("Deposit", []));
    await expect(findOrCreate(client(), req({ takeoverLine: "2025-03-05" }))).resolves.toEqual({ kind: "too-old" });
    expect(posts()).toEqual([]);
  });

  it("no takeover line: never created", async () => {
    fetchMock.mockResolvedValueOnce(rows("Deposit", []));
    await expect(findOrCreate(client(), req({ takeoverLine: null }))).resolves.toEqual({ kind: "no-line" });
    expect(posts()).toEqual([]);
  });

  it("failed: a QBO rejection of the create is returned, not thrown", async () => {
    fetchMock.mockResolvedValueOnce(rows("Deposit", [])).mockResolvedValueOnce(json({ Fault: {} }, 400));
    await expect(findOrCreate(client(), req())).resolves.toMatchObject({ kind: "failed", error: expect.stringMatching(/failed 400/) });
  });

  it("failed: a read error never falls through to a create", async () => {
    fetchMock.mockResolvedValueOnce(new Response("expired", { status: 401 }));
    await expect(findOrCreate(client(), req())).resolves.toMatchObject({ kind: "failed", error: expect.stringMatching(/401/) });
    expect(posts()).toEqual([]);
  });

  it("failed: a TxnDate outside the window is refused before any request", async () => {
    const late: TxnWrite = { entity: "Deposit", fields: { ...deposit.fields, txnDate: "2025-03-11" } };
    await expect(findOrCreate(client(), req({ write: late }))).resolves.toMatchObject({ kind: "failed", error: expect.stringMatching(/outside the match window/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("failed: an unescapable window date is refused before any request", async () => {
    await expect(findOrCreate(client(), req({ window: { from: "2025-03-03' OR 1=1", to: "2025-03-10" } }))).resolves.toMatchObject({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches Purchases on the paying account and Bills on the vendor", async () => {
    fetchMock
      .mockResolvedValueOnce(rows("Purchase", [{ Id: "p1", TxnDate: "2025-03-05", TotalAmt: 19.99, AccountRef: { value: "99" } }, { Id: "p2", TxnDate: "2025-03-05", TotalAmt: 19.99, AccountRef: { value: "41" } }]))
      .mockResolvedValueOnce(rows("Bill", [{ Id: "b1", TxnDate: "2025-03-05", TotalAmt: 42.1, VendorRef: { value: "5" } }]));
    await expect(findOrCreate(client(), req({ write: purchase }))).resolves.toEqual({ kind: "found", id: "p2", via: "amount" });
    await expect(findOrCreate(client(), req({ write: bill }))).resolves.toEqual({ kind: "found", id: "b1", via: "amount" });
    expect(queries().map((q) => q.split(" ")[3])).toEqual(["Purchase", "Bill"]);
  });

  it("crash after QBO accepts: the next run finds the entry by key and posts nothing", async () => {
    // Run 1: nothing matches, QBO accepts the create, and the caller crashes before recording the id.
    fetchMock.mockResolvedValueOnce(rows("Deposit", [])).mockResolvedValueOnce(json({ Deposit: { Id: "77" } }));
    await findOrCreate(client(), req());
    const sent = posts()[0].body as { TxnDate: string; PrivateNote: string };

    // Run 2: the windowed read returns QBO's stored copy of that entry, plus a hand entry of the same amount.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      rows("Deposit", [qboDeposit("77", sent.TxnDate, 120.45, sent.PrivateNote), qboDeposit("10", "2025-03-06", 120.45)]),
    );
    await expect(findOrCreate(client(), req())).resolves.toEqual({ kind: "found", id: "77", via: "key" });
    expect(posts()).toEqual([]);
  });
});

describe("createVendor", () => {
  it("appends (Vendor) when a Customer holds the name", async () => {
    fetchMock
      .mockResolvedValueOnce(rows("Customer", [{ Id: "3", DisplayName: "Pat O'Neil" }]))
      .mockResolvedValueOnce(rows("Vendor", []))
      .mockResolvedValueOnce(json({ Vendor: { Id: "40" } }));
    await expect(createVendor(client(), "Pat O'Neil", "vendor-person-12")).resolves.toEqual({
      kind: "created",
      id: "40",
      displayName: "Pat O'Neil (Vendor)",
    });
    expect(queries()).toEqual([
      "SELECT * FROM Customer WHERE DisplayName = 'Pat O\\'Neil'",
      "SELECT * FROM Vendor WHERE DisplayName = 'Pat O\\'Neil (Vendor)'",
    ]);
    const [c] = posts();
    expect(c.body).toEqual({ DisplayName: "Pat O'Neil (Vendor)" });
    expect(c.url.searchParams.get("requestid")).toBe("vendor-person-12");
  });

  it("keeps the name when no Customer holds it", async () => {
    fetchMock.mockResolvedValueOnce(rows("Customer", [])).mockResolvedValueOnce(rows("Vendor", [])).mockResolvedValueOnce(json({ Vendor: { Id: "41" } }));
    await expect(createVendor(client(), "Ann Lee", "v-1")).resolves.toEqual({ kind: "created", id: "41", displayName: "Ann Lee" });
  });

  it("returns an existing Vendor of that name as found, so a retry never creates twice", async () => {
    fetchMock.mockResolvedValueOnce(rows("Customer", [])).mockResolvedValueOnce(rows("Vendor", [{ Id: "41", DisplayName: "Ann Lee" }]));
    await expect(createVendor(client(), "Ann Lee", "v-1")).resolves.toEqual({ kind: "found", via: "name", id: "41", displayName: "Ann Lee" });
    expect(posts()).toEqual([]);
  });

  it("rejects a control character in the name before any request", async () => {
    await expect(createVendor(client(), "Ann\nLee", "v-1")).rejects.toThrow(/control character/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
