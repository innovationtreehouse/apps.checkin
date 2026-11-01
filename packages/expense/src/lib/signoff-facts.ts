import type { Expense, Prisma } from "../generated/prisma/client";
import type { Db } from "../db";
import { getExpenseRuntime } from "../runtime";
import { isEveryday, lineKind, withinEverydayLimits, missingSeats, needsBoardApproval, needsBoardSeat, type FilledSeat, type Seat, type SignoffFacts, type StepSigner } from "./signoff";
import type { ExpenseSettings } from "../contract";
import { readExpenseSettings } from "../services/settingsService";
import { writeAudit } from "./audit";
import { advanceWorkflowInTx, type Actor } from "./workflow-engine";
import { ServiceError } from "@checkin/component-kit";
import { liveIds } from "./livePeople";

type SignoffExpense = Pick<
  Expense,
  | "id"
  | "orgId"
  | "submitterId"
  | "reimburseePersonId"
  | "needsReimbursement"
  | "receiptTotalCents"
  | "boardAuthorization"
  | "everydayWithinLimits"
>;

/** The submitter and the reimbursee when known. */
function partiesOf(expense: { submitterId: number; reimburseePersonId: number | null }): number[] {
  return expense.reimburseePersonId === null ? [expense.submitterId] : [expense.submitterId, expense.reimburseePersonId];
}

/**
 * Whether the person is the submitter, the reimbursee when known, or in either one's household,
 * each as the live person they name. A party naming nobody live cannot be checked, so everyone is conflicted.
 */
export async function isConflicted(expense: { submitterId: number; reimburseePersonId: number | null }, personId: number): Promise<boolean> {
  const stored = partiesOf(expense);
  const live = await liveIds(stored);
  const parties = stored.flatMap((id) => live.get(id) ?? []);
  if (parties.length < stored.length) return true;
  return parties.includes(personId) || (await getExpenseRuntime().signoff.householdOf(parties)).includes(personId);
}

/**
 * The expense's frozen Everyday amount check. An expense frozen at intake keeps its result; one
 * with none freezes now against the current limits, and a concurrent freeze's result wins. A
 * read-only caller gets the check against the current limits and freezes nothing.
 */
async function frozenWithinLimits(db: Db, expense: SignoffExpense, unitPricesCents: number[], readOnly: boolean, settings: () => Promise<ExpenseSettings>): Promise<boolean> {
  if (expense.everydayWithinLimits !== null) return expense.everydayWithinLimits;
  const limits = await settings();
  const withinLimits = withinEverydayLimits({ receiptTotalCents: expense.receiptTotalCents, unitPricesCents }, limits);
  if (readOnly) return withinLimits;
  await db.expense.updateMany({
    where: { id: expense.id, everydayWithinLimits: null },
    data: { everydayWithinLimits: withinLimits, everydayTotalLimitCents: limits.everydayTotalLimitCents, everydayItemLimitCents: limits.everydayItemLimitCents },
  });
  return (await db.expense.findUniqueOrThrow({ where: { id: expense.id }, select: { everydayWithinLimits: true } })).everydayWithinLimits!;
}

/** A line's bucket approval, as the sign-off rules and the line's acts read it. */
export interface LineApproval {
  lineItemId: number;
  ownerId: number | null;
  status: string;
  decidedByUserId: number | null;
  bucketFinal: boolean;
}

/** One expense's sign-off state: each line's facts, filled seats and approval, and whether the expense waits for the Board's approval. */
export interface ExpenseSignoffFacts {
  byLine: Map<number, SignoffFacts>;
  filled: Map<number, FilledSeat[]>;
  approvals: Map<number, LineApproval>;
  boardApprovalNeeded: boolean;
}

const unique = (ids: number[]) => [...new Set(ids)];

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
  return out;
}

/**
 * Sign-off facts for every line of the given expenses, read together: a fixed set of expense
 * queries and directory calls however many expenses, plus one bucketApprovers call per distinct
 * bucket and one isOrgMember call per distinct reimbursee. Everyone who signs a step is seated:
 * the lines' approvers, the seats' signers and whoever recorded the Board authorization (the Board
 * step); moving a line to a bucket signs none. `readOnly` is for counts, which must not freeze the
 * Everyday check. Every stored person is read as the live person they name. An expense with a party
 * naming nobody live has no approvers or role holders and no reimbursee to confirm, so nobody acts on it.
 */
export async function signoffFactsForExpenses(db: Db, expenses: SignoffExpense[], { readOnly = false } = {}): Promise<Map<string, ExpenseSignoffFacts>> {
  if (expenses.length === 0) return new Map();
  const dir = getExpenseRuntime().signoff;
  const ids = expenses.map((e) => e.id);
  const [lines, storedApprovals, storedSeats, storedRecorders, storedAudits, finance, board] = await Promise.all([
    db.expenseLineItem.findMany({ where: { expenseId: { in: ids } }, orderBy: { id: "asc" }, select: { id: true, expenseId: true, unitPriceCents: true } }),
    db.lineItemOwnerApproval.findMany({
      where: { expenseId: { in: ids } },
      select: { expenseId: true, lineItemId: true, ownerId: true, status: true, decidedByUserId: true, bucketFinal: true },
    }),
    db.expenseLineSignoff.findMany({ where: { expenseId: { in: ids } }, select: { expenseId: true, lineItemId: true, seat: true, signerUserId: true } }),
    db.expense.findMany({ where: { id: { in: ids } }, select: { id: true, boardAuthorizedByUserId: true } }),
    db.expenseAuditLog.findMany({
      where: { expenseId: { in: ids }, action: { in: ["reimbursee_set", "bucket_made_final"] } },
      orderBy: { id: "desc" },
      select: { expenseId: true, action: true, lineItemId: true, userId: true },
    }),
    dir.financeHolders(),
    dir.boardMembers(),
  ]);
  const live = await liveIds([
    ...expenses.flatMap(partiesOf),
    ...storedSeats.map((s) => s.signerUserId),
    ...storedApprovals.flatMap((a) => a.decidedByUserId ?? []),
    ...storedRecorders.flatMap((r) => r.boardAuthorizedByUserId ?? []),
    ...storedAudits.map((a) => a.userId),
  ]);
  const current = (id: number) => live.get(id) ?? id;
  const currentOrNull = (id: number | null) => (id === null ? null : current(id));
  const approvals = storedApprovals.map((a) => ({ ...a, decidedByUserId: currentOrNull(a.decidedByUserId) }));
  const seats = storedSeats.map((s) => ({ ...s, signerUserId: current(s.signerUserId) }));
  const recorders = storedRecorders.map((r) => ({ ...r, boardAuthorizedByUserId: currentOrNull(r.boardAuthorizedByUserId) }));
  const audits = storedAudits.map((a) => ({ ...a, userId: current(a.userId) }));
  const liveExpenses = expenses.map((e) => ({ ...e, submitterId: current(e.submitterId), reimburseePersonId: currentOrNull(e.reimburseePersonId) }));
  const unresolved = new Set(expenses.filter((e) => partiesOf(e).some((id) => live.get(id) == null)).map((e) => e.id));
  const reimbursees = unique(liveExpenses.flatMap((e) => (lineKind(e) === "reimbursement" && e.reimburseePersonId !== null ? [e.reimburseePersonId] : [])));
  const isMember = new Map(await Promise.all(reimbursees.map(async (id) => [id, await dir.isOrgMember(id)] as const)));
  const bucketIds = unique(approvals.flatMap((a) => (a.ownerId === null ? [] : [a.ownerId])));
  const buckets = new Map(await Promise.all(bucketIds.map(async (id) => [id, await dir.bucketApprovers(id)] as const)));

  const signersOf = new Map<string, StepSigner[]>(ids.map((id) => [id, []]));
  for (const r of recorders) if (r.boardAuthorizedByUserId !== null) signersOf.get(r.id)!.push({ step: "BOARD", userId: r.boardAuthorizedByUserId });
  for (const s of seats) signersOf.get(s.expenseId)!.push({ step: s.seat as Seat, userId: s.signerUserId });
  for (const a of approvals) if (a.status === "approved" && a.decidedByUserId !== null) signersOf.get(a.expenseId)!.push({ step: "APPROVAL", userId: a.decidedByUserId });

  const owners = [...buckets.values()].flatMap((b) => (b.owner === null ? [] : [b.owner]));
  const people = unique([...liveExpenses.flatMap(partiesOf), ...[...signersOf.values()].flat().map((s) => s.userId), ...owners]);
  const households = await dir.householdsOf(people);
  const householdOf = (id: number) => households.get(id) ?? [];

  const settingsByOrg = new Map<string, Promise<ExpenseSettings>>();
  const settingsOf = (orgId: string) => () => {
    if (!settingsByOrg.has(orgId)) settingsByOrg.set(orgId, readExpenseSettings(db, orgId));
    return settingsByOrg.get(orgId)!;
  };
  const linesOf = groupBy(lines, (l) => l.expenseId);
  const approvalsOf = groupBy(approvals, (a) => a.expenseId);
  const seatsOf = groupBy(seats, (s) => s.expenseId);
  const auditsOf = groupBy(audits, (a) => a.expenseId);

  const out = new Map<string, ExpenseSignoffFacts>();
  for (const expense of liveExpenses) {
    const nobodyActs = unresolved.has(expense.id);
    const expenseLines = linesOf.get(expense.id) ?? [];
    const approvalOf = new Map((approvalsOf.get(expense.id) ?? []).map((a) => [a.lineItemId, a]));
    const signers = signersOf.get(expense.id)!;
    const parties = partiesOf(expense);
    const conflicted = unique([...parties, ...parties.flatMap(householdOf)]);
    const seated = unique(unique(signers.map((s) => s.userId)).flatMap((s) => householdOf(s).filter((id) => id !== s)));
    const expenseAudits = auditsOf.get(expense.id) ?? [];
    const setter = expenseAudits.find((a) => a.action === "reimbursee_set")?.userId ?? null;
    const finalByConflicted = new Set(expenseAudits.filter((a) => a.action === "bucket_made_final" && conflicted.includes(a.userId)).map((a) => a.lineItemId));
    const kind = lineKind(expense);
    // A card charge, or a reimbursee not yet named, counts as a member.
    const reimburseeIsMember = kind === "reimbursement" && expense.reimburseePersonId !== null ? isMember.get(expense.reimburseePersonId)! : true;
    const settings = settingsOf(expense.orgId);
    const withinLimits = await frozenWithinLimits(db, expense, expenseLines.map((l) => l.unitPriceCents), readOnly, settings);
    const everyday = isEveryday({ withinLimits });
    const byLine = new Map(
      expenseLines.map((l) => {
        const approval = approvalOf.get(l.id);
        const bucket = approval?.ownerId ?? null;
        const b = bucket === null ? undefined : buckets.get(bucket);
        const approved = approval?.status === "approved";
        const facts: SignoffFacts = {
          kind,
          submitterId: expense.submitterId,
          reimburseeId: nobodyActs ? null : expense.reimburseePersonId,
          approvers: nobodyActs ? [] : (b?.approvers ?? []),
          orgLevel: b?.orgLevel ?? false,
          reimburseeIsMember,
          reimburseeUnknown: kind === "reimbursement" && expense.reimburseePersonId === null,
          finance: nobodyActs ? [] : finance,
          board: nobodyActs ? [] : board,
          conflicted,
          ownerHousehold: !b || b.owner === null ? [] : unique([b.owner, ...householdOf(b.owner)]),
          reimburseeSetter: setter ?? (expense.reimburseePersonId === null ? null : expense.submitterId),
          seatedHouseholds: seated,
          boardSeat: needsBoardSeat(kind, everyday, b !== undefined && !b.orgLevel, expense.boardAuthorization),
          conflictedFinal: finalByConflicted.has(l.id),
          approved,
          approver: approved ? (approval?.decidedByUserId ?? null) : null,
          expenseSigners: signers,
        };
        return [l.id, facts] as const;
      }),
    );
    const filled = new Map<number, FilledSeat[]>();
    for (const r of seatsOf.get(expense.id) ?? []) filled.set(r.lineItemId, [...(filled.get(r.lineItemId) ?? []), { seat: r.seat as Seat, signerUserId: r.signerUserId }]);
    const { boardReviewTotalCents } = await settings();
    out.set(expense.id, {
      byLine,
      filled,
      approvals: approvalOf,
      boardApprovalNeeded: needsBoardApproval(expense.receiptTotalCents, boardReviewTotalCents, expense.boardAuthorization),
    });
  }
  return out;
}

/**
 * Sign-off facts for each line of an expense, read once through the SignoffDirectory port.
 * `readOnly` is for counts, which must not freeze the Everyday check.
 */
export async function signoffFactsByLine(db: Db, expense: SignoffExpense, { readOnly = false } = {}): Promise<Map<number, SignoffFacts>> {
  return (await signoffFactsForExpenses(db, [expense], { readOnly })).get(expense.id)!.byLine;
}

export async function filledSeatsByLine(db: Db, expenseId: string): Promise<Map<number, FilledSeat[]>> {
  const rows = await db.expenseLineSignoff.findMany({ where: { expenseId }, select: { lineItemId: true, seat: true, signerUserId: true } });
  const live = await liveIds(rows.map((r) => r.signerUserId));
  const out = new Map<number, FilledSeat[]>();
  for (const r of rows) out.set(r.lineItemId, [...(out.get(r.lineItemId) ?? []), { seat: r.seat as Seat, signerUserId: live.get(r.signerUserId) ?? r.signerUserId }]);
  return out;
}

export type LineHold = Seat | "BOARD_APPROVAL";

/** Whether the expense is held for the Board's approval, against the org's current Board-review total. */
export async function boardApprovalNeeded(db: Db, expense: Pick<SignoffExpense, "orgId" | "receiptTotalCents" | "boardAuthorization">): Promise<boolean> {
  const { boardReviewTotalCents } = await readExpenseSettings(db, expense.orgId);
  return needsBoardApproval(expense.receiptTotalCents, boardReviewTotalCents, expense.boardAuthorization);
}

/** What still holds a line: its unfilled seats, then the Board's approval when the expense needs it. */
export function lineHolds(approvalNeeded: boolean, facts: SignoffFacts, filled: FilledSeat[]): LineHold[] {
  return [...missingSeats(facts, filled), ...(approvalNeeded ? (["BOARD_APPROVAL"] as const) : [])];
}

/**
 * Lines still missing a seat or the Board's approval. A held line keeps the whole expense out of
 * the QB outbox. The outbox commit settled a closed expense's Board seat and Board approval against
 * the facts of that moment, and no seat is signed or voided on it after, so neither holds it again.
 */
export async function unsignedLines(db: Db, expense: SignoffExpense & Pick<Expense, "state">): Promise<Map<number, LineHold[]>> {
  const [facts, filled, approval] = await Promise.all([signoffFactsByLine(db, expense), filledSeatsByLine(db, expense.id), boardApprovalNeeded(db, expense)]);
  const closed = expense.state === "qb_complete";
  const out = new Map<number, LineHold[]>();
  for (const [lineId, f] of facts) {
    const missing = lineHolds(approval, f, filled.get(lineId) ?? []).filter((hold) => !closed || (hold !== "BOARD" && hold !== "BOARD_APPROVAL"));
    if (missing.length > 0) out.set(lineId, missing);
  }
  return out;
}

/**
 * Locks the expense row for the rest of the transaction. Every path that reads sign-off facts
 * and then writes a seat, a reimbursee or a bucket takes it first, so those writes serialize.
 */
export async function lockExpense(tx: Prisma.TransactionClient, expenseId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM expenses WHERE id = ${expenseId} FOR UPDATE`;
}

/** A step on a line, in the order of its signatures: the submitter seat, the approval, the Treasurer seat. */
export type ClearedStep = "SUBMITTER" | "APPROVAL" | "TREASURER";

/** Open states past owner approval; an expense in one returns to owner approval when an approval reopens. */
const PAST_OWNER_APPROVAL = new Set(["capital_review", "set_depreciation_cycle", "qb_pending", "qb_on_hold", "qb_error"]);

/** QuickBooks match states once the entry is (or is being) booked; nothing before it reopens then. */
const IN_QUICKBOOKS = new Set(["POSTING", "CREATED", "MATCHED"]);

/**
 * Clears what every step after owner approval decided, so each is done again in order: the
 * capital review's designations, the depreciation cycles and the assets they minted, the
 * QuickBooks step's open holds and its unposted outbox row. Each clearing is audited. An entry
 * already in QuickBooks is corrected there, so the expense cannot go back.
 */
async function clearStepsAfterOwnerApproval(tx: Prisma.TransactionClient, actor: Actor, expenseId: string, reason: string): Promise<void> {
  const expense = (await tx.expense.findUnique({ where: { id: expenseId }, select: { qbMatchState: true, qbTxnId: true } }))!;
  if (IN_QUICKBOOKS.has(expense.qbMatchState) || expense.qbTxnId !== null) {
    throw new ServiceError(409, "The expense is already in QuickBooks; correct it there");
  }

  const designated = await tx.expenseLineItem.findMany({
    where: { expenseId, OR: [{ isCapital: true }, { capitalOwnerId: { not: null } }, { depreciationYears: { not: null } }] },
    orderBy: { id: "asc" },
  });
  await tx.expenseLineItem.updateMany({ where: { id: { in: designated.map((l) => l.id) } }, data: { isCapital: false, capitalOwnerId: null, depreciationYears: null } });
  for (const l of designated) {
    await writeAudit(tx, actor, {
      expenseId,
      action: "capital_designation_cleared",
      lineItemId: l.id,
      valueBefore: `${l.isCapital ? "capital" : "non_capital"}/owner:${l.capitalOwnerId ?? "none"}/${l.depreciationYears ?? "none"}y`,
      notes: reason,
    });
  }

  const assets = await tx.capitalAsset.findMany({ where: { sourceExpenseId: expenseId, seeded: false }, orderBy: { id: "asc" } });
  await tx.capitalAsset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
  for (const a of assets) {
    await writeAudit(tx, actor, { expenseId, action: "capital_asset_cleared", lineItemId: a.sourceLineItemId, valueBefore: a.assetNumber, notes: reason });
  }

  const holds = await tx.expenseHold.findMany({ where: { expenseId, status: "PENDING" }, orderBy: { id: "asc" } });
  await tx.expenseHold.deleteMany({ where: { id: { in: holds.map((h) => h.id) } } });
  for (const h of holds) {
    await writeAudit(tx, actor, { expenseId, action: "hold_cleared", lineItemId: h.lineItemId, valueBefore: h.reason, notes: reason });
  }

  const outbox = await tx.expenseEvent.deleteMany({ where: { expenseId } });
  if (outbox.count > 0) {
    // Finance's skip is final, so going back never makes the expense postable again.
    const qbMatchState = expense.qbMatchState === "SKIPPED" ? "SKIPPED" : "UNMATCHED";
    await tx.expense.update({ where: { id: expenseId }, data: { qbMatchState, qbPostAttempts: 0 } });
    await writeAudit(tx, actor, { expenseId, action: "qb_outbox_cleared", fieldChanged: "qbMatchState", valueBefore: expense.qbMatchState, valueAfter: qbMatchState, notes: reason });
  }
}

/**
 * Clears `from` and every later step on the given lines (every line when `lineItemIds` is null):
 * deletes the seats, reopens an approved approval to pending, and clears those lines' catalog
 * snapshots, so each step is given again in order. Each cleared seat is audited as
 * `signoff_voided` and each reopened approval as `approval_cleared`, naming `reason`. An expense
 * past owner approval whose approval reopens returns to owner approval, and every step after it
 * is cleared too.
 */
export async function clearFrom(
  tx: Prisma.TransactionClient,
  actor: Actor,
  expenseId: string,
  lineItemIds: number[] | null,
  from: ClearedStep,
  reason: string,
): Promise<void> {
  const lines = lineItemIds ? { lineItemId: { in: lineItemIds } } : {};
  const seats: Seat[] = from === "SUBMITTER" ? ["SUBMITTER", "TREASURER", "BOARD"] : ["TREASURER", "BOARD"];
  const voided = await tx.expenseLineSignoff.findMany({ where: { expenseId, seat: { in: seats }, ...lines }, orderBy: { id: "asc" } });
  const reopened = from === "TREASURER" ? [] : await tx.lineItemOwnerApproval.findMany({ where: { expenseId, status: "approved", ...lines }, orderBy: { id: "asc" } });
  if (voided.length === 0 && reopened.length === 0) return;

  await tx.expenseLineSignoff.deleteMany({ where: { id: { in: voided.map((v) => v.id) } } });
  await tx.lineItemOwnerApproval.updateMany({
    where: { id: { in: reopened.map((a) => a.id) } },
    data: { status: "pending", decidedAt: null, decidedByUserId: null, notes: null },
  });
  await tx.expenseLineItem.updateMany({
    where: { id: { in: [...new Set([...voided, ...reopened].map((v) => v.lineItemId))] } },
    data: { signedGtin13: null, signedCategory: null, signedSubcategory: null },
  });
  for (const a of reopened) {
    await writeAudit(tx, actor, {
      expenseId,
      action: "approval_cleared",
      lineItemId: a.lineItemId,
      fieldChanged: "status",
      valueBefore: "approved",
      valueAfter: "pending",
      notes: `approver ${a.decidedByUserId ?? "none"}: ${reason}`,
    });
  }
  for (const v of voided) {
    await writeAudit(tx, actor, {
      expenseId,
      action: "signoff_voided",
      lineItemId: v.lineItemId,
      fieldChanged: "seat",
      valueBefore: v.seat,
      notes: `signer ${v.signerUserId}: ${reason}`,
    });
  }

  const { state } = (await tx.expense.findUnique({ where: { id: expenseId }, select: { state: true } }))!;
  if (reopened.length > 0 && PAST_OWNER_APPROVAL.has(state)) {
    await clearStepsAfterOwnerApproval(tx, actor, expenseId, reason);
    await advanceWorkflowInTx(tx, { expenseId, currentState: state, event: { type: "APPROVAL_REOPENED" }, actor, action: "state_transition", auditNotes: reason });
  }
}
