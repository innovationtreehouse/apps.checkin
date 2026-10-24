import { db, isUniqueConstraintError, type Db } from "../db";
import type { AccountMapping, ExpenseLineItem } from "../db/schema";
import { HoldReason, type HoldReason as HoldReasonType } from "./expense-rules";
import { SYSTEM_ACTOR } from "./system-actor";
import { logError } from "./logger";
import { lookupItems, getItem, listCategories, listSubcategories } from "./catalog";
import { StaleStateError, advanceWorkflow, advanceWorkflowInTx, unlessRaceLost, type Actor } from "./workflow-engine";
import { writeAudit } from "./audit";
import { lockExpense, unsignedLines } from "./signoff-facts";
import { reimburseeUnknown } from "./signoff";
import { postExpenseToQb } from "./expense-qb-poster";
import type { Expense } from "../generated/prisma/client";

// ── Allocation helpers ────────────────────────────────────────────────────────

export function allocateAmount(
  items: { id: number; totalPriceCents: number }[],
  total: number,
): Map<number, number> {
  const result = new Map<number, number>();
  if (total === 0 || items.length === 0) {
    for (const item of items) result.set(item.id, 0);
    return result;
  }

  const grandTotal = items.reduce((s, i) => s + i.totalPriceCents, 0);
  if (grandTotal === 0) {
    for (const item of items) result.set(item.id, 0);
    return result;
  }

  let distributed = 0;
  const rawAllocs: { id: number; totalPriceCents: number; floored: number }[] = [];

  for (const item of items) {
    const floored = Math.floor((item.totalPriceCents * total) / grandTotal);
    rawAllocs.push({ id: item.id, totalPriceCents: item.totalPriceCents, floored });
    distributed += floored;
  }

  const remainder = total - distributed;
  const sorted = [...rawAllocs].sort((a, b) =>
    b.totalPriceCents !== a.totalPriceCents ? b.totalPriceCents - a.totalPriceCents : a.id - b.id,
  );

  for (let i = 0; i < sorted.length; i++) {
    const extra = i < remainder ? 1 : 0;
    result.set(sorted[i].id, sorted[i].floored + extra);
  }

  return result;
}

// ── Translation lookup ────────────────────────────────────────────────────────

type LineItemFields = {
  id: number;
  partNumber: string | null;
  manufacturer: string | null;
  description: string;
  isDelayed: boolean;
  isCapital: boolean;
  manualQbAccount: string | null;
  totalPriceCents: number;
};

type ResolvedItem = LineItemFields & { account: string; category: string | null; subcategory: string | null };

type ConflictItem = {
  lineItem: LineItemFields;
  reason: HoldReasonType;
  matchedRows: unknown[];
  category: string | null;
  subcategory: string | null;
};

function matchesRule(rule: AccountMapping, category: string, subcategory: string, item: LineItemFields, gtin13: string): boolean {
  if (rule.category !== "*" && rule.category !== category) return false;
  if (rule.subcategory !== "*" && rule.subcategory !== subcategory) return false;
  if (rule.partNumber !== "*" && rule.partNumber !== gtin13) return false;
  if (rule.isDelayed !== null && rule.isDelayed !== item.isDelayed) return false;
  if (rule.isCapital !== null && rule.isCapital !== item.isCapital) return false;
  return true;
}

// ── Catalog inputs: live lookup and the sign-off snapshot ────────────────────

export type CatalogInfo = { gtin13: string; category: string; subcategory: string };

type CatalogLine = Pick<ExpenseLineItem, "id" | "partNumber" | "manufacturer" | "description">;

/** Live catalog GTIN and category names for each part-numbered line; unmatched lines have no `info` entry. */
export async function lookupCatalogInfo(
  lines: CatalogLine[],
  vendorName: string,
): Promise<{ gtin13ByItemId: Map<number, string | null>; info: Map<number, CatalogInfo> }> {
  const withPartNumbers = lines.filter((li) => li.partNumber);
  const info = new Map<number, CatalogInfo>();
  if (withPartNumbers.length === 0) return { gtin13ByItemId: new Map(), info };

  const [categories, subcategories, lookupResults] = await Promise.all([
    listCategories(),
    listSubcategories(),
    lookupItems(
      vendorName,
      withPartNumbers.map((li) => ({
        index: li.id,
        partNumber: li.partNumber,
        manufacturer: li.manufacturer,
        description: li.description,
      })),
    ),
  ]);
  const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
  const subcategoryMap = new Map(subcategories.map((s) => [s.id, s.name]));
  const gtin13ByItemId = new Map(lookupResults.map((r) => [r.index, r.gtin13]));

  for (const li of withPartNumbers) {
    const gtin13 = gtin13ByItemId.get(li.id);
    if (!gtin13) continue;
    const item = await getItem(gtin13);
    if (!item) continue;
    const category = categoryMap.get(item.categoryId);
    const subcategory = subcategoryMap.get(item.subcategoryId);
    if (category && subcategory) info.set(li.id, { gtin13, category, subcategory });
  }
  return { gtin13ByItemId, info };
}

function snapshotOf(li: ExpenseLineItem): CatalogInfo | null {
  const { signedGtin13: gtin13, signedCategory: category, signedSubcategory: subcategory } = li;
  return gtin13 && category && subcategory ? { gtin13, category, subcategory } : null;
}

/** Fixes the catalog inputs of signed lines; a line that already has a snapshot keeps it. */
export async function saveCatalogSnapshots(info: Map<number, CatalogInfo>, client: Db = db): Promise<void> {
  for (const [id, { gtin13, category, subcategory }] of info) {
    await client.expenseLineItem.updateMany({
      where: { id, signedGtin13: null },
      data: { signedGtin13: gtin13, signedCategory: category, signedSubcategory: subcategory },
    });
  }
}

// ── Stage 1: resolve accounts for all line items ─────────────────────────────

/**
 * Callers run this only once every line is signed off. `snapshots` holds the live catalog inputs of
 * lines without one; the caller saves them, so later catalog edits cannot move those accounts.
 */
async function resolveAccountsForExpense(
  lineItems: ExpenseLineItem[],
  rules: AccountMapping[],
  vendorName: string,
): Promise<{ resolved: ResolvedItem[]; conflicts: ConflictItem[]; snapshots: Map<number, CatalogInfo> }> {
  const live = await lookupCatalogInfo(lineItems.filter((li) => !snapshotOf(li)), vendorName);
  const snapshots = new Map(live.info);

  const gtin13ByItemId = live.gtin13ByItemId;
  const itemInfoByItemId = live.info;
  for (const li of lineItems) {
    const snapshot = snapshotOf(li);
    if (!snapshot) continue;
    gtin13ByItemId.set(li.id, snapshot.gtin13);
    itemInfoByItemId.set(li.id, snapshot);
  }

  const resolved: ResolvedItem[] = [];
  const conflicts: ConflictItem[] = [];

  for (const li of lineItems) {
    if (!li.partNumber) continue;

    const info = itemInfoByItemId.get(li.id);
    if (!info) {
      conflicts.push({ lineItem: li, reason: HoldReason.NO_MATCH, matchedRows: [{ _lookupContext: { partNumber: gtin13ByItemId.get(li.id) ?? null, isDelayed: li.isDelayed, isCapital: li.isCapital } }], category: null, subcategory: null });
      continue;
    }

    const { category, subcategory } = info;
    const gtin13 = gtin13ByItemId.get(li.id)!;
    const matches = rules.filter((rule) => matchesRule(rule, category, subcategory, li, gtin13));

    const exactMatches = matches.filter((r) => r.partNumber === gtin13);
    const effectiveMatches = exactMatches.length > 0 ? exactMatches : matches;

    if (effectiveMatches.length === 0) {
      conflicts.push({ lineItem: li, reason: HoldReason.NO_MATCH, matchedRows: [{ _lookupContext: { category, subcategory, partNumber: gtin13ByItemId.get(li.id) ?? null, isDelayed: li.isDelayed, isCapital: li.isCapital } }], category, subcategory });
    } else if (effectiveMatches.length > 1) {
      conflicts.push({ lineItem: li, reason: HoldReason.MULTIPLE_MATCHES, matchedRows: effectiveMatches, category, subcategory });
    } else {
      resolved.push({ ...li, account: effectiveMatches[0].qbAccount, category, subcategory });
    }
  }

  if (conflicts.length === 0) {
    for (const li of lineItems) {
      if (li.partNumber) continue;
      if (li.manualQbAccount) {
        resolved.push({ ...li, account: li.manualQbAccount, category: null, subcategory: null });
      } else {
        conflicts.push({ lineItem: li, reason: HoldReason.NO_PART_NUMBER, matchedRows: [], category: null, subcategory: null });
      }
    }
  }

  return { resolved, conflicts, snapshots };
}

// ── Stage 2 (idempotent write): persist conflict holds ───────────────────────

async function persistConflicts(
  orgId: string,
  expenseId: string,
  conflicts: ConflictItem[],
): Promise<void> {
  const existing = await db.expenseHold.findMany({
    where: { orgId, expenseId, status: "PENDING" },
    select: { lineItemId: true, id: true },
  });

  const existingByLineItem = new Map(existing.map((h) => [h.lineItemId, h.id]));

  for (const c of conflicts) {
    const matchedRowsJson = JSON.stringify(c.matchedRows);
    const existingId = existingByLineItem.get(c.lineItem.id);
    if (existingId !== undefined) {
      await db.expenseHold.update({
        where: { id: existingId },
        data: { matchedRows: matchedRowsJson, reason: c.reason },
      });
    } else {
      await db.expenseHold.create({
        data: {
          orgId,
          expenseId,
          lineItemId: c.lineItem.id,
          reason: c.reason,
          matchedRows: matchedRowsJson,
          status: "PENDING",
        },
      });
    }
  }
}

// ── Stage 3 (pure): allocate tax, shipping and discount over the lines ────────

function allocationsFor(expense: Expense, lineItems: ExpenseLineItem[]) {
  const allocItems = lineItems.map((li) => ({ id: li.id, totalPriceCents: li.totalPriceCents }));
  return {
    taxAlloc: allocateAmount(allocItems, expense.taxCents),
    shippingAlloc: allocateAmount(allocItems, expense.shippingCents),
    discountAlloc: allocateAmount(allocItems, expense.discountCents),
  };
}

// ── Stage 4 (atomic): commit QB processing ───────────────────────────────────
// All domain writes (holds, allocations, resolved accounts, event) and the state transition are
// committed in a single interactive transaction so the expense can never be
// observed in qb_pending after the event has been persisted, nor vice-versa.
// The sign-off holds are re-read under the expense lock before anything is written,
// catalog snapshots included, so a seat void either lands first and holds the
// expense, or finds it closed.

async function commitQbProcessing(
  orgId: string,
  expenseId: string,
  lineItems: ExpenseLineItem[],
  resolved: ResolvedItem[],
  taxAlloc: Map<number, number>,
  shippingAlloc: Map<number, number>,
  discountAlloc: Map<number, number>,
  snapshots: Map<number, CatalogInfo>,
): Promise<boolean> {
  const resolvedLineItemIds = resolved.map((r) => r.id);

  return db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    const current = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
    if (reimburseeUnknown(current) || (await unsignedLines(tx, current)).size > 0) return false;
    await saveCatalogSnapshots(snapshots, tx);

    if (resolvedLineItemIds.length > 0) {
      await tx.expenseHold.updateMany({
        where: {
          orgId,
          expenseId,
          status: "PENDING",
          lineItemId: { in: resolvedLineItemIds },
        },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
    }

    const accountByLine = new Map(resolved.map((r) => [r.id, r.account]));
    for (const li of lineItems) {
      await tx.expenseLineItem.update({
        where: { id: li.id },
        data: {
          allocatedTaxCents: taxAlloc.get(li.id) ?? 0,
          allocatedShippingCents: shippingAlloc.get(li.id) ?? 0,
          allocatedDiscountCents: discountAlloc.get(li.id) ?? 0,
          resolvedQbAccount: accountByLine.get(li.id) ?? null,
        },
      });
    }

    await tx.expenseEvent.create({
      data: { orgId, expenseId },
    });

    await advanceWorkflowInTx(tx, {
      expenseId,
      currentState: "qb_pending",
      event: { type: "QB_COMPLETE" },
      actor: SYSTEM_ACTOR,
      action: "qb_event_emitted",
    });
    return true;
  });
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function checkAndProcessExpense(orgId: string, expenseId: string): Promise<void> {
  let expense = await db.expense.findFirst({ where: { id: expenseId } });
  if (!expense) return;

  // Recover expenses that previously errored: transition qb_error → qb_pending
  // so the machine path for QB_COMPLETE remains consistent.
  if (expense.state === "qb_error") {
    await advanceWorkflow({
      db,
      expenseId,
      currentState: "qb_error",
      event: { type: "RESUBMIT" },
      actor: SYSTEM_ACTOR,
      action: "qb_resubmitted",
    }).catch(unlessRaceLost);
    expense = await db.expense.findFirst({ where: { id: expenseId } });
    if (!expense) return;
  }

  // Historical backfill: already booked in QuickBooks. Skip the QB post entirely and land terminal.
  // Everything upstream (owner approval auto-resolved, capital review + depreciation) has already run.
  if (expense.backfill && expense.state === "qb_pending") {
    await advanceWorkflow({
      db,
      expenseId,
      currentState: "qb_pending",
      event: { type: "QB_SKIPPED" },
      actor: SYSTEM_ACTOR,
      action: "qb_skipped_backfill",
    }).catch(unlessRaceLost);
    return;
  }

  if (expense.state !== "qb_pending" && expense.state !== "qb_on_hold") return;

  const existing = await db.expenseEvent.findFirst({
    where: { orgId, expenseId },
  });
  if (existing) return;

  // An unknown reimbursee or a line with an unfilled sign-off seat holds the expense out of the
  // outbox; setting the reimbursee or the last sign-off drains it. The outbox commit re-checks under the lock.
  if (reimburseeUnknown(expense) || (await unsignedLines(db, expense)).size > 0) return;

  try {
    await processExpenseForQb(orgId, expenseId, expense);
  } catch (err) {
    // A concurrent drain moved the expense first and carries it on; this is not a QB failure.
    if (err instanceof StaleStateError) return;
    logError("qb_processing_failed", { expenseId, orgId, state: expense.state }, err);

    const current = await db.expense.findFirst({ where: { id: expenseId } });
    if (!current || (current.state !== "qb_pending" && current.state !== "qb_on_hold")) throw err;

    await advanceWorkflow({
      db,
      expenseId,
      currentState: current.state,
      event: { type: "QB_ERROR" },
      actor: SYSTEM_ACTOR,
      action: "qb_processing_failed",
      auditNotes: err instanceof Error ? err.message : String(err),
    }).catch(unlessRaceLost);
  }
}

async function processExpenseForQb(
  orgId: string,
  expenseId: string,
  expense: Expense,
): Promise<void> {
  const lineItems = await db.expenseLineItem.findMany({ where: { expenseId } });

  if (lineItems.length === 0) return;

  const rules = await db.accountMapping.findMany({ where: { orgId } });

  const { resolved, conflicts, snapshots } = await resolveAccountsForExpense(
    lineItems,
    rules,
    expense.vendorName ?? "",
  );

  if (conflicts.length > 0) {
    await saveCatalogSnapshots(snapshots);
    await persistConflicts(orgId, expenseId, conflicts);

    if (expense.state === "qb_pending") {
      await advanceWorkflow({
        db,
        expenseId,
        currentState: "qb_pending",
        event: { type: "HOLDS_CREATED" },
        actor: SYSTEM_ACTOR,
        action: "qb_holds_created",
      });
    }
    return;
  }

  if (expense.state === "qb_on_hold") {
    await advanceWorkflow({
      db,
      expenseId,
      currentState: "qb_on_hold",
      event: { type: "HOLDS_RESOLVED" },
      actor: SYSTEM_ACTOR,
      action: "qb_holds_resolved",
    });
  }

  const { taxAlloc, shippingAlloc, discountAlloc } = allocationsFor(expense, lineItems);

  try {
    const committed = await commitQbProcessing(
      orgId, expenseId,
      lineItems, resolved,
      taxAlloc, shippingAlloc, discountAlloc,
      snapshots,
    );
    if (!committed) return;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    // Unique constraint on expenseEvents → concurrent run already committed; safe to ignore
  }

  // Post right after the outbox commit; anything left is the catch-up drain's.
  await postExpenseToQb(orgId, expenseId).catch((err) => logError("qb_post_failed", { expenseId, orgId }, err));
}

// ── Stranded recovery (catch-up sweep) ────────────────────────────────────────
// Re-runs expenses left in qb_pending or qb_error without an outbox row (a crash between the
// state advance and QB processing, or an outage). The host's daily reconcile cron step calls it;
// checkAndProcessExpense is idempotent. Capped; returns counts only.

export async function recoverStrandedQbExpenses(limit = 50): Promise<{ checked: number; failed: number }> {
  const candidates = await db.expense.findMany({
    where: { state: { in: ["qb_pending", "qb_error"] } },
    select: { id: true, orgId: true },
    orderBy: { submittedAt: "asc" },
  });

  const processedIds = new Set(
    (await db.expenseEvent.findMany({
      where: { expenseId: { in: candidates.map((e) => e.id) } },
      select: { expenseId: true },
    })).map((e) => e.expenseId),
  );

  let checked = 0;
  let failed = 0;
  for (const { id, orgId } of candidates.filter((c) => !processedIds.has(c.id)).slice(0, limit)) {
    checked++;
    try {
      await checkAndProcessExpense(orgId, id);
    } catch (err) {
      failed++;
      logError("recovery_failed", { expenseId: id, orgId }, err);
    }
  }
  return { checked, failed };
}

// ── Finance retry of a failed QuickBooks post ─────────────────────────────────

/**
 * Re-arms an expense whose post failed: re-resolves each line's account from the current account
 * mappings (so a fixed mapping takes effect), resets the attempt count and records who asked, all
 * under the row lock so an in-flight post never reads half-rewritten accounts; then posts once.
 * Returns false when a line no longer resolves to one account; the expense stays as it is.
 */
export async function retryQbPost(orgId: string, expenseId: string, actor: Actor): Promise<boolean> {
  const rearmed = await db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    const expense = await tx.expense.findFirst({ where: { id: expenseId, orgId } });
    if (!expense || !["POST_FAILED", "NEEDS_FINANCE"].includes(expense.qbMatchState)) return false;
    const lineItems = await tx.expenseLineItem.findMany({ where: { expenseId } });
    const rules = await tx.accountMapping.findMany({ where: { orgId } });
    const { resolved, conflicts, snapshots } = await resolveAccountsForExpense(lineItems, rules, expense.vendorName ?? "");
    await saveCatalogSnapshots(snapshots, tx);
    if (conflicts.length > 0) return false;

    for (const r of resolved) {
      await tx.expenseLineItem.update({ where: { id: r.id }, data: { resolvedQbAccount: r.account } });
    }
    await tx.expense.update({ where: { id: expenseId }, data: { qbMatchState: "POST_FAILED", qbPostAttempts: 0 } });
    await writeAudit(tx, actor, { expenseId, action: "qb_post_retried" });
    return true;
  });
  if (rearmed) await postExpenseToQb(orgId, expenseId);
  return rearmed;
}
