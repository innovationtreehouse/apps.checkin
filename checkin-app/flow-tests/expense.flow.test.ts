/**
 * Expense (#1272): the persona matrix over all 46 routes (anonymous, plain member, bucket
 * approver, Board, FINANCE), field stripping on the approver view, one FINANCE journey and one
 * approver sign-off journey. Real HTTP against the running dev server and the seeded expense DB
 * (docker-compose.flow.yml + packages/expense/prisma/seed.ts).
 *
 * The expense seed names checkin ids from a fresh baseline: bucket 2 is the first program's
 * ("Woodworking 101"), and person 10 (tool.certifier) submitted every seeded expense. The
 * approver is inventory.manager, made that program's lead for this suite and restored after.
 */
import { loginAs, api, type Session } from "./helpers";

// The first test to touch each of the 46 routes waits on the dev server compiling it.
jest.setTimeout(120_000);

const FINANCE = "finance@example.com";
const BOARD = "boardmember@example.com";
const APPROVER = "inventory.manager@example.com";
const PLAIN = "parent.family@example.com";
const SUBMITTER = "tool.certifier@example.com";
const REIMBURSEE = "certified.adult@example.com";
const PROGRAM = "Woodworking 101";

const PROGRAM_EXPENSE = "seed-expense-program";
const UNASSIGNED_EXPENSE = "seed-expense-unassigned";
const HELD_EXPENSE = "seed-expense-held";
const REIMBURSEMENT_EXPENSE = "seed-expense-reimbursement";

type Gate = "approver" | "signoff" | "financeOrBoard" | "finance";
type Route = [method: string, path: string, gate: Gate, body?: unknown];

const E = `/api/expense/expenses/${PROGRAM_EXPENSE}`;
// Every registered route, with concrete ids. Writes carry bodies that fail validation or
// target nothing, so the matrix checks admission without changing seeded state.
const ROUTES: Route[] = [
  ["GET", "/api/expense/expenses", "approver"],
  ["GET", "/api/expense/expenses/count", "approver"],
  ["GET", E, "approver"],
  ["GET", `${E}/line-item-approvals`, "approver"],
  ["POST", `${E}/line-item-approvals/0/approve`, "approver", {}],
  ["POST", `${E}/line-item-approvals/0/raise-exception`, "approver", {}],
  ["GET", `${E}/signoffs`, "approver"],
  ["POST", `${E}/line-items/0/signoffs`, "signoff", {}],
  ["GET", "/api/expense/queue?view=all", "approver"],
  ["GET", "/api/expense/counts", "approver"],
  ["GET", "/api/expense/expense-holds", "financeOrBoard"],
  ["GET", "/api/expense/account-mapping", "financeOrBoard"],
  ["GET", "/api/expense/account-mapping/catalog", "financeOrBoard"],
  ["GET", "/api/expense/qb-accounts", "financeOrBoard"],
  ["GET", "/api/expense/local-owners", "financeOrBoard"],
  ["GET", "/api/expense/ownership-map", "financeOrBoard"],
  ["GET", "/api/expense/provisional-items", "financeOrBoard"],
  ["GET", "/api/expense/expense-events", "financeOrBoard"],
  ["GET", "/api/expense/expense-events/count", "financeOrBoard"],
  ["GET", "/api/expense/received-expense-payloads", "financeOrBoard"],
  ["GET", "/api/expense/qb-exclusions", "financeOrBoard"],
  ["GET", "/api/expense/org-settings", "financeOrBoard"],
  ["PUT", "/api/expense/org-settings", "financeOrBoard", { unknownField: 1 }],
  ["GET", "/api/expense/flags", "financeOrBoard"],
  ["POST", "/api/expense/flags/0/check-off", "financeOrBoard", {}],
  ["POST", `${E}/line-item-approvals/0/reject`, "finance", {}],
  ["POST", `${E}/line-item-approvals/0/assign-owner`, "finance", {}],
  ["POST", `${E}/line-item-approvals/0/finance-assign`, "finance", {}],
  ["POST", `${E}/line-item-approvals/0/resolve-unknown`, "finance", {}],
  ["POST", `${E}/capital-review/submit`, "finance", {}],
  ["POST", `${E}/set-depreciation-cycle/submit`, "finance", {}],
  ["PUT", `${E}/reimbursee`, "finance", {}],
  ["PUT", `/api/expense/expense-holds/${HELD_EXPENSE}/line-items/0/account`, "finance", {}],
  ["POST", "/api/expense/expense-holds/no-such-expense/resubmit", "finance", {}],
  ["POST", "/api/expense/account-mapping", "finance", {}],
  ["PUT", "/api/expense/account-mapping/0", "finance", {}],
  ["DELETE", "/api/expense/account-mapping/0", "finance"],
  ["POST", "/api/expense/qb-accounts", "finance", {}],
  ["PUT", "/api/expense/qb-accounts/0", "finance", {}],
  ["DELETE", "/api/expense/qb-accounts/0", "finance"],
  ["PUT", "/api/expense/ownership-map", "finance", {}],
  ["POST", "/api/expense/capital-assets/seed", "finance", []],
  ["GET", "/api/expense/line-items/0/qb-candidates", "finance"],
  ["POST", "/api/expense/line-items/0/qb-match", "finance", {}],
  ["POST", "/api/expense/line-items/0/qb-create", "finance", {}],
  ["POST", "/api/expense/qb-exclusions", "finance", {}],
];

const send = (s: Session | null, method: string, path: string, body?: unknown) =>
  api(s, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const denied = (status: number) => status === 401 || status === 403;

type ProgramRow = { id: number; name: string; leadMentorId?: number | null };
type ExpenseRow = { id: string; submitterId?: number; state: string; vendorName: string | null };
type Approval = { id: number; lineItemId: number; ownerId: number | null; status: string };
type SignoffStatus = { lineItemId: number; filled: string[]; missing: string[] };

let program: ProgramRow;
let originalLead: number;

async function setLead(board: Session, personId: number): Promise<void> {
  const res = await send(board, "PATCH", `/api/programs/${program.id}`, { leadMentorId: personId });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  expect((await loginAs(SUBMITTER)).personaId).toBe(10); // the seed's submitter id
  const board = await loginAs(BOARD);
  const programs = await api<ProgramRow[]>(board, "/api/programs");
  program = programs.json.find((p) => p.name === PROGRAM)!;
  expect(program).toBeDefined();
  originalLead = program.leadMentorId ?? board.personaId;
  await setLead(board, (await loginAs(APPROVER)).personaId);
});

afterAll(async () => {
  await setLead(await loginAs(BOARD), originalLead);
});

describe("expense — persona matrix", () => {
  it("rejects every route without a session", async () => {
    for (const [method, path, , body] of ROUTES) {
      const { status } = await send(null, method, path, body);
      expect([method, path, denied(status)]).toEqual([method, path, true]);
    }
  });

  it("denies every route to a plain member", async () => {
    const member = await loginAs(PLAIN);
    for (const [method, path, , body] of ROUTES) {
      expect([method, path, (await send(member, method, path, body)).status]).toEqual([method, path, 403]);
    }
  });

  it("admits a bucket approver to the approver routes and sign-off only", async () => {
    const approver = await loginAs(APPROVER);
    for (const [method, path, gate, body] of ROUTES) {
      const { status } = await send(approver, method, path, body);
      const admitted = gate === "approver" || gate === "signoff";
      expect([method, path, denied(status)]).toEqual([method, path, !admitted]);
      if (admitted && method === "GET") expect([path, status]).toEqual([path, 200]);
    }
  });

  it("admits Board everywhere except the FINANCE-only routes", async () => {
    const board = await loginAs(BOARD);
    for (const [method, path, gate, body] of ROUTES) {
      const { status } = await send(board, method, path, body);
      expect([method, path, denied(status)]).toEqual([method, path, gate === "finance"]);
      if (gate !== "finance" && method === "GET") expect([path, status]).toEqual([path, 200]);
    }
  });

  it("admits FINANCE everywhere", async () => {
    const finance = await loginAs(FINANCE);
    for (const [method, path, , body] of ROUTES) {
      const { status } = await send(finance, method, path, body);
      expect([method, path, denied(status)]).toEqual([method, path, false]);
      // A GET naming line 0 is admitted and then finds nothing.
      if (method === "GET" && !path.includes("/0/")) expect([path, status]).toEqual([path, 200]);
    }
  });
});

describe("expense — field stripping", () => {
  it("serves an approver internal fields only, FINANCE the submitter too", async () => {
    const approver = await loginAs(APPROVER);
    const finance = await loginAs(FINANCE);
    const asApprover = await api<ExpenseRow>(approver, E);
    const asFinance = await api<ExpenseRow>(finance, E);
    expect(asApprover.status).toBe(200);
    expect(asApprover.json.vendorName).toBe("Seed Lumber");
    expect(asApprover.json.submitterId).toBeUndefined();
    expect(asFinance.json.submitterId).toBe(10);
  });

  it("confines an approver's list to their bucket's expenses", async () => {
    const approver = await loginAs(APPROVER);
    const { json } = await api<ExpenseRow[]>(approver, "/api/expense/expenses");
    expect(json.map((e) => e.id)).toEqual([PROGRAM_EXPENSE]);
    expect((await api(approver, `/api/expense/expenses/${HELD_EXPENSE}`)).status).toBe(404);
  });
});

describe("expense — approver sign-off journey", () => {
  it("approves the program line, then signs the program-approver seat", async () => {
    const approver = await loginAs(APPROVER);
    const counts = await api<Record<string, number>>(approver, "/api/expense/counts");
    expect(counts.json.owner_approval).toBe(1);

    const approvals = await api<{ LineItemOwnerApproval: Approval[] }>(approver, `${E}/line-item-approvals`);
    const [line] = approvals.json.LineItemOwnerApproval;
    expect(line.status).toBe("pending");

    const approved = await send(approver, "POST", `${E}/line-item-approvals/${line.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect((approved.json as Approval).status).toBe("approved");

    // Not the submitter, so not the submitter seat; not FINANCE, so not the Treasurer seat.
    expect((await send(approver, "POST", `${E}/line-items/${line.lineItemId}/signoffs`, { seat: "SUBMITTER" })).status).toBe(403);
    expect((await send(approver, "POST", `${E}/line-items/${line.lineItemId}/signoffs`, { seat: "TREASURER" })).status).toBe(403);
    const signed = await send(approver, "POST", `${E}/line-items/${line.lineItemId}/signoffs`, { seat: "PROGRAM_APPROVER" });
    expect(signed.status).toBe(200);
    expect((signed.json as SignoffStatus[])[0].filled).toEqual(["PROGRAM_APPROVER"]);
    // A filled seat cannot be signed again.
    expect((await send(approver, "POST", `${E}/line-items/${line.lineItemId}/signoffs`, { seat: "PROGRAM_APPROVER" })).status).toBe(403);

    // FINANCE fills the Treasurer seat; the submitter's seat is still open.
    const finance = await loginAs(FINANCE);
    expect((await send(finance, "POST", `${E}/line-items/${line.lineItemId}/signoffs`, { seat: "TREASURER" })).status).toBe(200);
    const status = await api<SignoffStatus[]>(approver, `${E}/signoffs`);
    expect(status.json[0]).toMatchObject({ filled: expect.arrayContaining(["PROGRAM_APPROVER", "TREASURER"]), missing: ["SUBMITTER"] });
    expect((await api(approver, "/my-programs/expense-approvals")).status).toBe(200);
  });
});

describe("expense — FINANCE journey", () => {
  it("edits settings, curates mapping and buckets, works holds and flags, and sets a reimbursee", async () => {
    const f = await loginAs(FINANCE);
    const stamp = Date.now();

    // Settings: one threshold changes; the response carries the new value.
    const settings = await send(f, "PUT", "/api/expense/org-settings", { boardReviewTotalCents: 250_000 });
    expect(settings.status).toBe(200);
    expect(settings.json).toMatchObject({ boardReviewTotalCents: 250_000, noteInLieuLimitCents: 5_000 });
    expect((await send(f, "PUT", "/api/expense/org-settings", { boardReviewTotalCents: -1 })).status).toBe(400);

    // QuickBooks accounts and an account-mapping rule: create, edit, delete.
    const account = await send(f, "POST", "/api/expense/qb-accounts", { name: `Supplies ${stamp}`, qbAccount: `6100-${stamp}` });
    expect(account.status).toBe(200);
    const accountId = (account.json as { id: number }).id;
    expect((await send(f, "PUT", `/api/expense/qb-accounts/${accountId}`, { name: `Supplies ${stamp}`, qbAccount: `6110-${stamp}` })).status).toBe(200);
    const rule = { category: "*", subcategory: "*", partNumber: `P-${stamp}`, isDelayed: null, isCapital: null, qbAccount: `6110-${stamp}` };
    const mapping = await send(f, "POST", "/api/expense/account-mapping", rule);
    expect(mapping.status).toBe(200);
    const mappingId = (mapping.json as { id: number }).id;
    expect((await send(f, "PUT", `/api/expense/account-mapping/${mappingId}`, { ...rule, isCapital: false })).status).toBe(200);
    expect((await send(f, "DELETE", `/api/expense/account-mapping/${mappingId}`)).status).toBe(200);

    // Buckets come from checkin's BudgetOwner table; map a part to the org-level bucket.
    const buckets = await api<{ id: number; name: string }[]>(f, "/api/expense/local-owners");
    const facility = buckets.json.find((b) => b.name === "Facility")!;
    expect(facility).toBeDefined();
    expect((await send(f, "PUT", "/api/expense/ownership-map", { gtin13: "0000000000017", ownerId: facility.id })).status).toBe(200);

    // Assign the unassigned line to the org-level bucket: assigning is the approval.
    const U = `/api/expense/expenses/${UNASSIGNED_EXPENSE}`;
    const [unassigned] = (await api<{ LineItemOwnerApproval: Approval[] }>(f, `${U}/line-item-approvals`)).json.LineItemOwnerApproval;
    const assigned = await send(f, "POST", `${U}/line-item-approvals/${unassigned.id}/assign-owner`, { ownerId: facility.id });
    expect(assigned.status).toBe(200);
    expect(assigned.json).toMatchObject({ ownerId: facility.id, status: "approved" });

    // Holds: set an account on the held line, then resubmit.
    const holds = await api<{ expenseId: string; lineItemId: number }[]>(f, "/api/expense/expense-holds");
    const hold = holds.json.find((h) => h.expenseId === HELD_EXPENSE)!;
    expect(hold).toBeDefined();
    const H = `/api/expense/expense-holds/${HELD_EXPENSE}`;
    expect((await send(f, "PUT", `${H}/line-items/${hold.lineItemId}/account`, { qbAccount: `6110-${stamp}` })).status).toBe(200);
    expect((await send(f, "POST", `${H}/resubmit`, {})).status).toBe(200);

    // Flags: the reimbursee flag stays open while the hold applies; the tax flag checks off.
    const flags = await api<{ id: number; kind: string; expenseId: string }[]>(f, "/api/expense/flags");
    const unknown = flags.json.find((x) => x.kind === "REIMBURSEE_UNKNOWN")!;
    const tax = flags.json.find((x) => x.kind === "TAX_ATTACHED")!;
    expect((await send(f, "POST", `/api/expense/flags/${unknown.id}/check-off`, {})).status).toBe(409);
    expect((await send(f, "POST", `/api/expense/flags/${tax.id}/check-off`, { notes: "seen" })).status).toBe(200);

    // Reimbursee: FINANCE names the person, which clears the hold's flag.
    const reimbursee = (await loginAs(REIMBURSEE)).personaId;
    const R = `/api/expense/expenses/${REIMBURSEMENT_EXPENSE}/reimbursee`;
    expect((await send(f, "PUT", R, { personId: f.personaId })).status).toBe(403);
    const set = await send(f, "PUT", R, { personId: reimbursee });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ reimburseePersonId: reimbursee });
    const open = await api<{ kind: string }[]>(f, "/api/expense/flags");
    expect(open.json.some((x) => x.kind === "REIMBURSEE_UNKNOWN")).toBe(false);

    // Capital seed, then QuickBooks: no candidates while unbound, exclusions record, no writes.
    const seed = await send(f, "POST", "/api/expense/capital-assets/seed", [{ assetNumber: `ITFA${String(stamp).slice(-4)}`, description: "Seed saw" }]);
    expect(seed.status).toBe(200);
    expect(seed.json).toMatchObject({ created: 1, errors: 0 });
    expect((await send(f, "POST", "/api/expense/qb-exclusions", { qbTxnId: `qb-${stamp}`, reason: "hand-booked" })).status).toBe(200);
    expect((await send(f, "POST", `/api/expense/line-items/${hold.lineItemId}/qb-create`, {})).status).toBe(503);
  });

  it("server-renders an expense page (proves the library tsx transpiles)", async () => {
    const f = await loginAs(FINANCE);
    expect((await api(f, "/expense/expenses")).status).toBe(200);
    expect((await api(f, `/expense/expenses/${PROGRAM_EXPENSE}`)).status).toBe(200);
  });
});
