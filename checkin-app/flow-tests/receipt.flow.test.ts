/**
 * Receipts (#1265): the route + auth matrix (submitter vs FINANCE vs BOARD vs a non-viewer vs
 * anonymous), the file route's delivery headers, and the submitter journey on the local OCR
 * mock: an auto upload finalizes and shows in "My receipts"; an owed receipt reads "not yet
 * paid" and stays when completed ones are hidden. Real HTTP against the running dev server and
 * the empty receipt DB (docker-compose.flow.yml). The S1 push (X6) is unbound, so finalized
 * receipts wait unpushed.
 */
import { api, BASE, loginAs, type Session } from "./helpers";

const SUBMITTER = "inventory.manager@example.com";
const OTHER_VIEWER = "keyholder1@example.com";
const NON_VIEWER = "parent.family@example.com";
const FINANCE = "finance@example.com";
const BOARD = "boardmember@example.com";

interface Line { id: number; description: string; uploadedByUserId?: number }
interface Receipt {
  id: string;
  state: string;
  retailer: string | null;
  uploadedByUserId: number;
  needsReimbursement: boolean;
  reimbursement?: { paidOn: string | null } | null;
  complete?: boolean;
  lineItems?: Line[];
}

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const today = new Date().toISOString().slice(0, 10);
const cookie = (s: Session) => [...s.jar].map(([k, v]) => `${k}=${v}`).join("; ");

const details = (retailer: string, receiptDate = today) => ({
  retailer,
  receiptDate,
  receiptTotal: "10",
  lineItems: [{ description: "Flow widget", quantity: 1, unitPrice: 10 }],
});

/** Multipart upload of a text receipt; `data` is the JSON upload input. */
async function upload(s: Session | null, text: string, data?: unknown) {
  const form = new FormData();
  form.append("file", new Blob([text], { type: "text/plain" }), "receipt.txt");
  if (data !== undefined) form.append("data", JSON.stringify(data));
  const req = new Request(BASE, { method: "POST", body: form });
  return api<Receipt>(s, "/api/receipts/upload", {
    method: "POST",
    body: await req.arrayBuffer(),
    headers: { "content-type": req.headers.get("content-type") ?? "" },
  });
}

const post = (s: Session | null, path: string, body: unknown = {}) => api<Receipt>(s, path, { method: "POST", body: JSON.stringify(body) });

const SUBMITTER_READS = ["/api/receipts/mine", "/api/receipts/needs-attention"];
const FINANCE_READS = ["/api/receipts", "/api/receipts/settings"];

describe("receipts — route auth", () => {
  it("rejects every receipt route without a session", async () => {
    for (const path of [...SUBMITTER_READS, ...FINANCE_READS]) {
      expect([path, [401, 403].includes((await api(null, path)).status)]).toEqual([path, true]);
    }
    expect([401, 403]).toContain((await upload(null, `anon ${stamp}`)).status);
  });

  it("denies a person outside the submitter audience", async () => {
    const member = await loginAs(NON_VIEWER);
    for (const path of [...SUBMITTER_READS, ...FINANCE_READS]) {
      expect([path, (await api(member, path)).status]).toEqual([path, 403]);
    }
    expect((await upload(member, `member ${stamp}`)).status).toBe(403);
  });

  it("serves a submitter their own lists and denies them the finance side", async () => {
    const submitter = await loginAs(SUBMITTER);
    for (const path of SUBMITTER_READS) expect([path, (await api(submitter, path)).status]).toEqual([path, 200]);
    for (const path of FINANCE_READS) expect([path, (await api(submitter, path)).status]).toEqual([path, 403]);
    expect((await api(submitter, "/api/receipts/settings", { method: "PUT", body: "{}" })).status).toBe(403);
    expect((await post(submitter, "/api/receipts/import", [])).status).toBe(403);
  });

  it("serves the board the finance reads and denies it finance actions", async () => {
    const board = await loginAs(BOARD);
    for (const path of FINANCE_READS) expect([path, (await api(board, path)).status]).toEqual([path, 200]);
    expect((await api(board, "/api/receipts/settings", { method: "PUT", body: "{}" })).status).toBe(403);
    expect((await post(board, "/api/receipts/import", [])).status).toBe(403);
  });

  it("server-renders the receipt pages (proves the library tsx transpiles)", async () => {
    const finance = await loginAs(FINANCE);
    for (const path of ["/receipts", "/receipts/upload", "/receipts/review", "/receipts/settings"]) {
      expect([path, (await api(finance, path)).status]).toEqual([path, 200]);
    }
  });
});

describe("receipts — submitter journey", () => {
  it("auto-reads an upload to finalized and lists it with the owed one, which stays when completed are hidden", async () => {
    const submitter = await loginAs(SUBMITTER);

    // The uploader is always the principal: a payload-asserted id is refused, never used.
    expect((await upload(submitter, `forged ${stamp}`, { localUserId: 1 })).status).toBe(400);
    // The type is checked by content: a NUL byte is not text.
    expect((await upload(submitter, `bad\u0000${stamp}`)).status).toBe(400);

    // Auto: no details, so the local OCR mock reads it in the request.
    const auto = await upload(submitter, `auto receipt ${stamp}`);
    expect(auto.status).toBe(200);
    expect(auto.json).toMatchObject({ state: "receipt_finalized", retailer: "Fixture Hardware", uploadedByUserId: submitter.personaId });
    expect(auto.json).not.toHaveProperty("fileBlob");

    // Owed: stops at the submitter's review, then finalizes on confirm.
    const owed = await upload(submitter, `owed receipt ${stamp}`, { details: details(`Flow Store ${stamp}`), needsReimbursement: true });
    expect(owed.status).toBe(200);
    expect(owed.json.state).toBe("submitter_review");
    const confirmed = await post(submitter, `/api/receipts/${owed.json.id}/submitter-confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.state).toBe("receipt_finalized");

    const mine = (await api<Receipt[]>(submitter, "/api/receipts/mine")).json;
    expect(mine.find((r) => r.id === auto.json.id)).toMatchObject({ complete: true, reimbursement: null });
    expect(mine.find((r) => r.id === owed.json.id)).toMatchObject({ complete: false, reimbursement: { paidOn: null } });
    const open = (await api<Receipt[]>(submitter, "/api/receipts/mine?hideCompleted=1")).json;
    expect(open.some((r) => r.id === auto.json.id)).toBe(false);
    expect(open.some((r) => r.id === owed.json.id)).toBe(true);

    // Detail: the submitter's own lines survive the stripper; the reimbursee name (pii) does not.
    const detail = await api<Receipt & { reimbursementFor?: string }>(submitter, `/api/receipts/${owed.json.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.lineItems).toHaveLength(1);
    expect(detail.json.lineItems?.[0]).toMatchObject({ description: "Flow widget" });
    expect(detail.json).not.toHaveProperty("reimbursementFor");

    // Another viewer sees neither the receipt nor its file.
    const other = await loginAs(OTHER_VIEWER);
    expect((await api(other, `/api/receipts/${auto.json.id}`)).status).toBe(404);
    expect((await fetch(`${BASE}/api/receipts/${auto.json.id}/file`, { headers: { cookie: cookie(other) } })).status).toBe(404);

    // The file: text only as an attachment, never sniffed.
    const file = await fetch(`${BASE}/api/receipts/${auto.json.id}/file`, { headers: { cookie: cookie(submitter) } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(file.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await file.text()).toBe(`auto receipt ${stamp}`);

    // Finance sees the read in the audit log; the push waits for X6.
    const finance = await loginAs(FINANCE);
    const audit = await api<{ action: string }[]>(finance, `/api/receipts/${auto.json.id}/audit-logs`);
    expect(audit.json.map((a) => a.action)).toContain("file_viewed");
    const push = await post(finance, `/api/receipts/${auto.json.id}/push-to-inventory`);
    expect(push.status).toBe(200);
    expect(push.json).toEqual({ pushed: false });
  });
});

describe("receipts — finance review", () => {
  it("sends an old receipt to finance review, refuses a self-decision, and approves another's", async () => {
    const submitter = await loginAs(SUBMITTER);
    const finance = await loginAs(FINANCE);
    const board = await loginAs(BOARD);

    const theirs = await upload(submitter, `old receipt ${stamp}`, { details: details(`Old Store ${stamp}`, "2020-01-15") });
    expect(theirs.json.state).toBe("financial_review");
    const own = await upload(finance, `finance old receipt ${stamp}`, { details: details(`Finance Store ${stamp}`, "2020-01-15") });
    expect(own.json.state).toBe("financial_review");

    const queue = (await api<Receipt[]>(finance, "/api/receipts?state=financial_review")).json;
    expect(queue.map((r) => r.id)).toEqual(expect.arrayContaining([theirs.json.id, own.json.id]));

    expect((await post(finance, `/api/receipts/${own.json.id}/approve`, { note: "mine" })).status).toBe(409);
    expect((await post(board, `/api/receipts/${theirs.json.id}/approve`, {})).status).toBe(403);
    expect((await post(submitter, `/api/receipts/${theirs.json.id}/approve`, {})).status).toBe(403);
    const approved = await post(finance, `/api/receipts/${theirs.json.id}/approve`, { note: "Backlog receipt" });
    expect(approved.status).toBe(200);
    expect(approved.json.state).toBe("receipt_finalized");

    const missing = await post(finance, "/api/receipts/00000000-0000-0000-0000-000000000000/approve", {});
    expect(missing.status).toBe(404);
  });
});
