import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../..");
const SCANNED = ["lib", "services", "routes", "repositories"];
const PERSON_READ = /\.(submitterId|reimburseePersonId|signerUserId|decidedByUserId|boardAuthorizedByUserId)([^A-Za-z]|$)|(submitterId|reimburseePersonId|signerUserId|decidedByUserId|boardAuthorizedByUserId): (true|\{|me|mine|personId)|\b(expense|approvals|signoffs): true/;

/** These read people through the resolver, or are pure rules over the facts it resolved. */
const RESOLVED_FILES = new Set(["lib/livePeople.ts", "lib/signoff-facts.ts", "lib/signoff.ts", "lib/line-actions.ts"]);

/** Each line is reviewed: it hands the id to the resolver, or cannot clear anyone by reading it stored. */
const REVIEWED = [
  // Passed to withLiveParties on the next lines.
  "lib/outcome-notices.ts: select: { submitterId: true, reimburseePersonId: true, vendorName: true, receiptDate: true },",
  "routes/expenses.ts: submitterId: true,",
  "routes/expenses.ts: select: { expense: { select: { submitterId: true } }, approvals: { select: { ownerId: true } } },",
  // Passed to the resolver on the same line.
  "routes/expenses.ts: if ((await liveIdOf(line.expense.submitterId)) === me) return true;",
  "services/reimburseeVendorService.ts: const personId = await liveIdOf(expense.reimburseePersonId);",
  "services/reimburseeVendorService.ts: const personId = await liveIdOf(expense.reimburseePersonId);",
  'services/reimburseeVendorService.ts: if (await sameHousehold(await liveIdOf(holder.reimburseePersonId), actor.userId)) await refuse("That QuickBooks Vendor is linked to you or your household");',
  // The Vendor lookups resolve inside reimburseeVendorLink.
  "lib/expense-qb-poster.ts: expense.needsReimbursement && expense.reimburseePersonId !== null",
  "lib/expense-qb-poster.ts: ? await reimburseeVendorLink(client, orgId, expense.reimburseePersonId)",
  "services/qbMatchService.ts: const personId = expense.reimburseePersonId;",
  'services/reasonService.ts: expense.qbMatchState === "AMBIGUOUS" && expense.needsReimbursement && expense.reimburseePersonId !== null',
  "services/reasonService.ts: ? (await reimburseeVendorId(expense.reimburseePersonId)) !== null",
  // isConflicted resolves what it is handed.
  "services/signoffService.ts: const expense = await db.expense.findFirst({ where: { id: expenseId, orgId }, select: { submitterId: true } });",
  "services/signoffService.ts: if (await isConflicted({ submitterId: expense.submitterId, reimburseePersonId: null }, actor.userId)) return [];",
  'services/signoffService.ts: if ("newPerson" in choice && await isConflicted({ submitterId: expense.submitterId, reimburseePersonId: null }, actor.userId)) {',
  "services/signoffService.ts: if (await isConflicted({ submitterId: expense.submitterId, reimburseePersonId: personId }, actor.userId)) {",
  // Null checks, and writes of a live person.
  "services/reimburseeVendorService.ts: const expense = await db.expense.findFirst({ where: { id: expenseId, orgId }, select: { reimburseePersonId: true } });",
  "services/reimburseeVendorService.ts: if (expense.reimburseePersonId === null) return { link: null, reimbursee: null };",
  'services/reimburseeVendorService.ts: if (expense.reimburseePersonId === null) throw new ServiceError(409, "Set the reimbursee before linking a Vendor");',
  "services/reimburseeVendorService.ts: const row = await tx.expenseReimburseeVendor.create({ data: { orgId, reimburseePersonId: personId, qbVendorId } });",
  'services/reimburseeVendorService.ts: where: { orgId, reimburseePersonId: { in: storedIds }, needsReimbursement: true, backfill: false, qbTxnId: null, qbMatchState: "AMBIGUOUS" },',
  "services/signoffService.ts: await tx.expense.update({ where: { id: expenseId }, data: { reimburseePersonId: personId } });",
  "services/intakeService.ts: const reimburseePersonId = await resolvedReimbursee(receipt.reimburseePersonId ?? null);",
  "services/intakeService.ts: submitterId: receipt.submitterId,",
  // The receipt library resolves `awaiting`'s stored id and hands it back to `confirm`, which resolves it.
  'services/submitterSeatService.ts: const onBehalf = signer.userId === confirmation.reimburseePersonId ? "" : ` on behalf of ${confirmation.reimburseePersonId}`;',
  'services/submitterSeatService.ts: where: { orgId: await getOrgId(), ...TAKES_SUBMITTER_SEAT, reimburseePersonId: { not: null }, lineItems: { some: { signoffs: { none: { seat: "SUBMITTER" } } } } },',
  "services/submitterSeatService.ts: select: { id: true, reimburseePersonId: true },",
  "services/submitterSeatService.ts: return expenses.map((e) => ({ receiptId: e.id, reimburseePersonId: e.reimburseePersonId!, changedFields: latest.get(e.id) ?? [] }));",
  // A prefilter that only excludes; the resolved facts decide on what stays.
  'services/badgeCounts.ts: where: { orgId: await getOrgId(), state: "qb_pending", backfill: false, submitterId: { not: me } },',
  // Skips redoing one's own approval; a merged approver's line falls through to approveLocked, which refuses it.
  'services/approvalService.ts: const todo = approvals.filter((a) => a.status !== "approved" || a.decidedByUserId !== actor.userId);',
  // Nothing reads these: the summary list and the sibling approvals' parties.
  "repositories/expense.ts: submitterId: true,",
  "repositories/expense.ts: select: { id: true, expenseId: true, lineItemId: true, expense: { select: { submitterId: true, reimburseePersonId: true } } },",
  // The detail response carries each signoff's stored signer, and no page reads it.
  'routes/expenses.ts: lineItems: { where: lines, orderBy: { lineNumber: "asc" }, include: { signoffs: true } },',
  // Not yet resolved: the holds list returns the stored submitter and reimbursee. This line goes when the route resolves them.
  "routes/finance.ts: include: { lineItem: true, expense: true },",
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sources(join(dir, entry.name));
    return entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [];
  });
}

describe("a stored person id is read only through the live-people resolver", () => {
  it("every read outside the resolved files is one reviewed here, line for line", () => {
    const reads = SCANNED.flatMap((dir) => sources(join(SRC, dir)))
      .map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }))
      .filter(({ path }) => !RESOLVED_FILES.has(path))
      .flatMap(({ path, text }) => text.split("\n").filter((line) => PERSON_READ.test(line)).map((line) => `${path}: ${line.trim()}`));
    expect(reads.sort()).toEqual([...REVIEWED].sort());
  });
});
