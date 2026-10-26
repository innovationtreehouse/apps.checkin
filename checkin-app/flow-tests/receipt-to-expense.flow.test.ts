/**
 * Receipt to expense, end to end: an upload that repeats an earlier one is flagged as a
 * duplicate, FINANCE reviews and clears it, its uploader confirms it, receiving applies it, FINANCE
 * puts its line in a bucket, the bucket's owner approves the line, and FINANCE sees the approved
 * line and the receipt in its review lists. Only routes with no external integration: the local OCR
 * mock reads the upload. Real HTTP against the running dev server.
 */
import { api, BASE, differentPurchases, loginAs, type Session } from "./helpers";

const SUBMITTER = "inventory.manager@example.com";
const FINANCE = "finance@example.com";
const BOARD = "boardmember@example.com";
const APPROVER = "keyholder1@example.com";

interface Receipt { id: string; state: string; duplicateSuspectReceiptId?: string | null }
type Received = { id: number; receiptId: string; state: string };
type Detail = { ReceivedReceipt: Received; ReceivedReceiptLineStatus: Array<{ id: number; recognitionStatus: string }> };
type Approval = { id: number; lineItemId: number; ownerId: number | null; status: string };
type ExpenseRow = { id: string; state: string };

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function upload(s: Session, text: string) {
  const form = new FormData();
  form.append("file", new Blob([text], { type: "text/plain" }), "receipt.txt");
  const req = new Request(BASE, { method: "POST", body: form });
  return api<Receipt>(s, "/api/receipts/upload", {
    method: "POST",
    body: await req.arrayBuffer(),
    headers: { "content-type": req.headers.get("content-type") ?? "" },
  });
}

const send = <T = unknown>(s: Session, method: string, path: string, body?: unknown) =>
  api<T>(s, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const post = <T = unknown>(s: Session, path: string, body: unknown = {}) => send<T>(s, "POST", path, body);

const approvals = async (s: Session, expenseId: string) =>
  (await api<{ LineItemOwnerApproval: Approval[] }>(s, `/api/expense/expenses/${expenseId}/line-item-approvals`)).json.LineItemOwnerApproval;

let submitter: Session;
let finance: Session;
let board: Session;
let approver: Session;
let bucketId: number | undefined;
let original: Receipt | undefined;

beforeAll(async () => {
  [submitter, finance, board, approver] = await Promise.all([loginAs(SUBMITTER), loginAs(FINANCE), loginAs(BOARD), loginAs(APPROVER)]);
  const bucket = await post<{ id: number }>(finance, "/api/budget-owners", { name: `Receipt journey ${stamp}` });
  expect(bucket.status).toBe(200);
  bucketId = bucket.json.id;
  expect((await send(board, "PUT", `/api/budget-owners/${bucketId}/owner`, { personId: approver.personaId })).status).toBe(200);
});

afterAll(async () => {
  // The sessions are all set before the bucket is, so a beforeAll that failed earlier leaves nothing to undo.
  if (bucketId !== undefined) {
    await send(board, "PUT", `/api/budget-owners/${bucketId}/owner`, { personId: null });
    // Archive is the only removal: the booked expense line still references the bucket by id.
    expect((await post(finance, `/api/budget-owners/${bucketId}/archive`)).status).toBe(200);
  }
  if (original) await post(submitter, `/api/receipts/${original.id}/submitter-discard`);
});

describe("receipt to expense journey", () => {
  it("flags a repeat upload, decides it on review, applies it and approves its line into finance review", async () => {
    // The OCR mock reads every upload as the same purchase, so the second copy repeats the first.
    const first = await upload(submitter, `journey original ${stamp}`);
    expect(first.status).toBe(200);
    original = first.json.state === "duplicate_flagged"
      ? (await differentPurchases<Receipt>(finance, first.json.id)).json
      : first.json;
    expect(original?.state).toBe("submitter_review");

    const copy = await upload(submitter, `journey copy ${stamp}`);
    expect(copy.status).toBe(200);
    expect(copy.json.state).toBe("duplicate_flagged");

    // FINANCE finds it in the duplicates queue, with the receipt it repeats named.
    const duplicates = await api<Receipt[]>(finance, "/api/receipts?state=duplicate_flagged");
    expect(duplicates.status).toBe(200);
    expect(duplicates.json.some((r) => r.id === copy.json.id)).toBe(true);
    const flagged = await api<Receipt>(finance, `/api/receipts/${copy.json.id}`);
    expect(flagged.status).toBe(200);
    expect(flagged.json.duplicateSuspectReceiptId).toEqual(expect.any(String));

    const group = await api<{ members: Array<{ id: string }> }>(finance, `/api/receipts/${copy.json.id}/duplicate-group`);
    expect(group.json.members.map((m) => m.id)).toEqual(expect.arrayContaining([original?.id, copy.json.id]));
    const cleared = await differentPurchases<Receipt>(finance, copy.json.id);
    expect(cleared.status).toBe(200);
    expect(cleared.json.state).toBe("submitter_review");
    const confirmed = await post<Receipt>(submitter, `/api/receipts/${copy.json.id}/submitter-confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.state).toBe("receipt_finalized");

    // Receiving has it; resolving its one line applies it and books the expense.
    const rows = (await api<Received[]>(submitter, "/api/workflow-mapping/receipts")).json.filter((r) => r.receiptId === copy.json.id);
    expect(rows).toEqual([expect.objectContaining({ state: "pending_review" })]);
    const detail = (await api<Detail>(submitter, `/api/workflow-mapping/receipts/${rows[0].id}`)).json;
    const [line] = detail.ReceivedReceiptLineStatus;
    expect((await post(submitter, `/api/workflow-mapping/receipts/${rows[0].id}/lines/${line.id}/non-inventory`)).status).toBe(200);
    expect((await api<Detail>(submitter, `/api/workflow-mapping/receipts/${rows[0].id}`)).json.ReceivedReceipt.state).toBe("resolved");

    // FINANCE puts the line in the approver's bucket; the bucket's owner approves it.
    const expenseId = copy.json.id;
    expect((await api(finance, `/api/expense/expenses/${expenseId}`)).status).toBe(200);
    const [unassigned] = await approvals(finance, expenseId);
    expect(unassigned).toMatchObject({ ownerId: null });
    const assigned = await post<Approval>(finance, `/api/expense/expenses/${expenseId}/line-item-approvals/${unassigned.id}/assign-owner`, { ownerId: bucketId });
    expect(assigned.status).toBe(200);
    expect(assigned.json).toMatchObject({ ownerId: bucketId, status: "pending" });

    const awaiting = await api<ExpenseRow[]>(approver, "/api/expense/expenses?view=owner_approval&page=1&limit=50");
    expect(awaiting.status).toBe(200);
    expect(awaiting.json.some((e) => e.id === expenseId)).toBe(true);
    const approved = await post<Approval>(approver, `/api/expense/expenses/${expenseId}/line-item-approvals/${unassigned.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.json.status).toBe("approved");

    // FINANCE sees the approved line on the expense in its list, and the receipt in its review.
    const listed = await api<ExpenseRow[]>(finance, "/api/expense/expenses?view=all&page=1&limit=50");
    expect(listed.status).toBe(200);
    expect(listed.json.some((e) => e.id === expenseId)).toBe(true);
    expect(await approvals(finance, expenseId)).toEqual([expect.objectContaining({ id: unassigned.id, ownerId: bucketId, status: "approved" })]);
    const receipts = await api<Receipt[]>(finance, "/api/receipts");
    expect(receipts.json.find((r) => r.id === copy.json.id)).toMatchObject({ state: "receipt_finalized" });
  });
});
