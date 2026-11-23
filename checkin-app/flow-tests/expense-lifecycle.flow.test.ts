/**
 * Expense line actions and capital review on expenses booked from fresh receipts: FINANCE assigns,
 * rejects and moves a line while the bucket approver and the Board are refused, and an expense at
 * the org's capital thresholds goes through capital review, minting one asset per unit, while one
 * under both skips it. Each case books its own receipt into its own buckets, so no case depends on
 * another or on seed rows. Real HTTP against the running dev server.
 */
import { api, BASE, loginAs, newClassId, type Session } from "./helpers";

const SUBMITTER = "inventory.manager@example.com";
const FINANCE = "finance@example.com";
const BOARD = "boardmember@example.com";
const APPROVER = "keyholder1@example.com";

type Receipt = { id: string; state: string };
type Received = { id: number; receiptId: string; state: string };
type Detail = { ReceivedReceipt: Received; ReceivedReceiptLineStatus: Array<{ id: number }> };
type Approval = { id: number; lineItemId: number; ownerId: number | null; status: string };
type ExpenseState = { Expense: { id: string; state: string } };
type SeedResult = { created: number; skipped: number; errors: number };

// The first test to touch each route waits on the dev server compiling it.
jest.setTimeout(120_000);

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const today = new Date().toISOString().slice(0, 10);

const send = <T = unknown>(s: Session, method: string, path: string, body?: unknown) =>
  api<T>(s, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const post = <T = unknown>(s: Session, path: string, body: unknown = {}) => send<T>(s, "POST", path, body);
const denied = (status: number) => status === 401 || status === 403;

let submitter: Session;
let finance: Session;
let board: Session;
let approver: Session;
const buckets: number[] = [];
type Thresholds = { capitalTotalThresholdCents: number | null; capitalLineItemThresholdCents: number | null };
let priorThresholds: Thresholds | undefined;

async function newBucket(name: string, ownerId: number | null): Promise<number> {
  const bucket = await post<{ id: number }>(finance, "/api/budget-owners", { name: `${name} ${stamp}`, quickBooksClassId: newClassId() });
  expect(bucket.status).toBe(200);
  buckets.push(bucket.json.id);
  if (ownerId !== null) expect((await send(board, "PUT", `/api/budget-owners/${bucket.json.id}/owner`, { personId: ownerId, acknowledgeCheck: true })).status).toBe(200);
  return bucket.json.id;
}

/**
 * Books a typed-in receipt of one non-inventory line through receiving into expense. The retailer
 * is unique to the run, so it is never flagged as a duplicate. Returns the expense id (the
 * receipt's) and its line's unassigned approval.
 */
async function bookExpense(label: string, quantity: number, unitPrice: number): Promise<{ expenseId: string; approval: Approval }> {
  const form = new FormData();
  form.append("file", new Blob([`${label} ${stamp}`], { type: "text/plain" }), "receipt.txt");
  form.append("data", JSON.stringify({
    details: { retailer: `${label} ${stamp}`, receiptDate: today, receiptTotal: String(quantity * unitPrice), lineItems: [{ description: `${label} item`, quantity, unitPrice }] },
  }));
  const req = new Request(BASE, { method: "POST", body: form });
  const uploaded = await api<Receipt>(submitter, "/api/receipts/upload", {
    method: "POST",
    body: await req.arrayBuffer(),
    headers: { "content-type": req.headers.get("content-type") ?? "" },
  });
  expect(uploaded.status).toBe(200);
  // Typed in by its uploader, a card charge needs no confirmation.
  expect(uploaded.json.state).toBe("receipt_finalized");

  const [row] = (await api<Received[]>(submitter, "/api/workflow-mapping/receipts")).json.filter((r) => r.receiptId === uploaded.json.id);
  const [line] = (await api<Detail>(submitter, `/api/workflow-mapping/receipts/${row.id}`)).json.ReceivedReceiptLineStatus;
  expect((await post(submitter, `/api/workflow-mapping/receipts/${row.id}/lines/${line.id}/non-inventory`)).status).toBe(200);

  const [approval] = await approvals(uploaded.json.id);
  expect(approval).toMatchObject({ ownerId: null, status: "pending" });
  return { expenseId: uploaded.json.id, approval };
}

async function approvals(expenseId: string): Promise<Approval[]> {
  return (await api<{ LineItemOwnerApproval: Approval[] }>(finance, `/api/expense/expenses/${expenseId}/line-item-approvals`)).json.LineItemOwnerApproval;
}

/** The expense's one line approval, read back after an action: a single-key response arrives unwrapped. */
async function lineOf(expenseId: string): Promise<Approval> {
  const [line] = await approvals(expenseId);
  return line;
}

async function stateOf(expenseId: string): Promise<string> {
  return (await api<ExpenseState>(finance, `/api/expense/expenses/${expenseId}`)).json.Expense.state;
}

const action = (expenseId: string, approvalId: number, verb: string) => `/api/expense/expenses/${expenseId}/line-item-approvals/${approvalId}/${verb}`;

/** Every persona but FINANCE is refused the action, and the line is left as it was. */
async function refusedToOthers(expenseId: string, approval: Approval, verb: string, body: unknown): Promise<void> {
  for (const s of [approver, board, submitter]) {
    expect([verb, denied((await post(s, action(expenseId, approval.id, verb), body)).status)]).toEqual([verb, true]);
  }
  expect(await approvals(expenseId)).toEqual([expect.objectContaining({ id: approval.id, ownerId: approval.ownerId, status: approval.status })]);
}

/** Puts the line in `bucketId` as FINANCE; the expense moves on to its bucket's approval. */
async function assign(expenseId: string, approval: Approval, bucketId: number): Promise<Approval> {
  expect((await post(finance, action(expenseId, approval.id, "assign-owner"), { ownerId: bucketId })).status).toBe(200);
  return lineOf(expenseId);
}

/** The bucket approver raises an exception on the line, which FINANCE then settles. */
async function raise(expenseId: string, approval: Approval): Promise<Approval> {
  expect((await post(approver, action(expenseId, approval.id, "raise-exception"), { notes: "Not this bucket's purchase" })).status).toBe(200);
  const raised = await lineOf(expenseId);
  expect(raised.status).toBe("exception_raised");
  return raised;
}

beforeAll(async () => {
  [submitter, finance, board, approver] = await Promise.all([loginAs(SUBMITTER), loginAs(FINANCE), loginAs(BOARD), loginAs(APPROVER)]);
});

afterAll(async () => {
  // A threshold cannot go back to unset; 0 holds every expense at capital review, as unset does.
  if (priorThresholds) {
    const restore = {
      capitalTotalThresholdCents: priorThresholds.capitalTotalThresholdCents ?? 0,
      capitalLineItemThresholdCents: priorThresholds.capitalLineItemThresholdCents ?? 0,
    };
    expect((await send(board, "PUT", "/api/expense/org-settings", restore)).status).toBe(200);
  }
  // The buckets stay: their expenses are left open, and a bucket with open lines cannot be archived.
  for (const id of buckets) await send(board, "PUT", `/api/budget-owners/${id}/owner`, { personId: null });
});

describe("expense line actions", () => {
  let bucket: number;
  let otherBucket: number;

  beforeAll(async () => {
    bucket = await newBucket("Line actions", approver.personaId);
    otherBucket = await newBucket("Line actions other", null);
  });

  it("assign-owner: FINANCE puts an unassigned line in a bucket; no one else can", async () => {
    const { expenseId, approval } = await bookExpense("Assign", 1, 11);
    expect(await stateOf(expenseId)).toBe("assign_ownership");
    await refusedToOthers(expenseId, approval, "assign-owner", { ownerId: bucket });

    expect(await assign(expenseId, approval, bucket)).toMatchObject({ ownerId: bucket, status: "pending" });
    expect(await stateOf(expenseId)).toBe("owner_approval");
  });

  it("reject: FINANCE rejects a raised exception, which rejects the expense; no one else can", async () => {
    const { expenseId, approval } = await bookExpense("Reject", 1, 12);
    const raised = await raise(expenseId, await assign(expenseId, approval, bucket));
    await refusedToOthers(expenseId, raised, "reject", { notes: "Not an org purchase" });

    expect((await post(finance, action(expenseId, raised.id, "reject"), { notes: "Not an org purchase" })).status).toBe(200);
    expect((await lineOf(expenseId)).status).toBe("rejected");
    expect(await stateOf(expenseId)).toBe("rejected");
  });

  it("finance-assign: FINANCE moves a raised exception to another bucket, where it waits; no one else can", async () => {
    const { expenseId, approval } = await bookExpense("Move", 1, 13);
    const raised = await raise(expenseId, await assign(expenseId, approval, bucket));
    await refusedToOthers(expenseId, raised, "finance-assign", { ownerId: otherBucket });

    expect((await post(finance, action(expenseId, raised.id, "finance-assign"), { ownerId: otherBucket })).status).toBe(200);
    expect(await lineOf(expenseId)).toMatchObject({ ownerId: otherBucket, status: "finance_assigned" });
    expect(await stateOf(expenseId)).toBe("owner_approval");
    // The first bucket's approver no longer sees it.
    expect((await post(approver, action(expenseId, raised.id, "approve"))).status).toBe(404);
  });

  it("resolve-unknown: refused to everyone but FINANCE, and to FINANCE on a line whose bucket is known", async () => {
    // No route or job sets a line's bucket to unknown, so FINANCE's resolution itself is not reachable here.
    const { expenseId, approval } = await bookExpense("Unknown", 1, 14);
    const assigned = await assign(expenseId, approval, bucket);
    await refusedToOthers(expenseId, assigned, "resolve-unknown", { ownerId: otherBucket });

    const resolved = await post(finance, action(expenseId, assigned.id, "resolve-unknown"), { ownerId: otherBucket });
    expect(resolved.status).toBe(400);
    expect(JSON.stringify(resolved.json)).toMatch(/not in unknown status/);
    expect(await approvals(expenseId)).toEqual([expect.objectContaining({ id: assigned.id, ownerId: bucket, status: "pending" })]);
  });
});

describe("expense capital review", () => {
  it("reviews an expense at the thresholds, minting one asset per unit, and skips one under both", async () => {
    const bucket = await newBucket("Capital", approver.personaId);

    const current = await api<Thresholds>(board, "/api/expense/org-settings");
    expect(current.status).toBe(200);
    const prior = { capitalTotalThresholdCents: current.json.capitalTotalThresholdCents, capitalLineItemThresholdCents: current.json.capitalLineItemThresholdCents };
    // Setting a threshold from unset loosens it, which is the Board's.
    const settings = await send(board, "PUT", "/api/expense/org-settings", { capitalTotalThresholdCents: 2500, capitalLineItemThresholdCents: 1250 });
    expect(settings.status).toBe(200);
    priorThresholds = prior;

    const approve = async (expenseId: string, approval: Approval) => {
      await assign(expenseId, approval, bucket);
      expect((await post(approver, action(expenseId, approval.id, "approve"))).status).toBe(200);
    };

    // Under both thresholds: approval goes straight on towards QuickBooks.
    const small = await bookExpense("Small tool", 1, 10);
    await approve(small.expenseId, small.approval);
    expect(await stateOf(small.expenseId)).toBe("qb_pending");

    // Two units at the line threshold and a total at the total threshold.
    const big = await bookExpense("Capital saw", 2, 12.5);
    await approve(big.expenseId, big.approval);
    expect(await stateOf(big.expenseId)).toBe("capital_review");

    const E = `/api/expense/expenses/${big.expenseId}`;
    const lineItemId = big.approval.lineItemId;
    expect((await post(finance, `${E}/capital-review/submit`, { lineItems: [{ lineItemId, isCapital: true, capitalOwnerId: bucket }] })).status).toBe(200);
    expect(await stateOf(big.expenseId)).toBe("set_depreciation_cycle");

    // No route lists the register, so the mint is read through the seed route: a number it
    // already holds is refused. Seeding a number above every other makes the mint's numbers next.
    const base = Math.floor(Date.now() / 1000);
    const seed = (n: number) => post<SeedResult>(finance, "/api/expense/capital-assets/seed", [{ assetNumber: `ITFA${n}`, description: `Probe ${stamp}` }]);
    expect((await seed(base)).json).toMatchObject({ created: 1 });

    expect((await post(finance, `${E}/set-depreciation-cycle/submit`, { items: [{ lineItemId, depreciationYears: 5, ownerId: bucket }] })).status).toBe(200);
    expect(await stateOf(big.expenseId)).toBe("qb_pending");

    expect((await seed(base + 1)).json).toMatchObject({ created: 0, skipped: 0, errors: 1 });
    expect((await seed(base + 2)).json).toMatchObject({ created: 0, skipped: 0, errors: 1 });
    expect((await seed(base + 3)).json).toMatchObject({ created: 1, skipped: 0 });

    // A second submit mints nothing more: the expense has left the depreciation step.
    expect((await post(finance, `${E}/set-depreciation-cycle/submit`, { items: [{ lineItemId, depreciationYears: 5, ownerId: bucket }] })).status).toBe(400);
  });
});
