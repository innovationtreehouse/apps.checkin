import { catalogSettingsMessage, isNotWired, kindOf, ServiceError } from "@checkin/component-kit";
import { db, isUniqueConstraintError, type Db } from "../db";
import type { AccountMapping, ExpenseLineItem } from "../db/schema";
import { HoldReason, type HoldReason as HoldReasonType } from "./expense-rules";
import { SYSTEM_ACTOR } from "./system-actor";
import { logError } from "./logger";
import { lookupItems, getItem, listCategories, listSubcategories } from "./catalog";
import { matchingRules, type CatalogInfo } from "./account-rules";
import { StaleStateError, advanceWorkflow, advanceWorkflowInTx, unlessRaceLost, type Actor } from "./workflow-engine";
import { writeAudit } from "./audit";
import { lockExpense, OUTBOX_HOLD_FIELDS, outboxHeldIds } from "./signoff-facts";
import { postExpenseToQb, type PostOutcome } from "./expense-qb-poster";
import { getExpenseRuntime } from "../runtime";
import { sendOutcomeNotices } from "./outcome-notices";
import { allocationsFor } from "../qb-write";
import type { Expense } from "../generated/prisma/client";

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

// ── Catalog inputs: live lookup and the sign-off snapshot ────────────────────

type CatalogLine = Pick<ExpenseLineItem, "id" | "partNumber" | "manufacturer" | "description" | "nonInventory">;

/** A part-numbered inventory line resolves its account through the catalog; any other line takes finance's manual account. */
function resolvesThroughCatalog(li: Pick<ExpenseLineItem, "partNumber" | "nonInventory">): boolean {
  return !!li.partNumber && !li.nonInventory;
}

/**
 * Live catalog GTIN and category names for each catalog-resolved line; unmatched lines have no `info` entry.
 * An unbound catalog matches nothing and sets `catalogNotConnected`.
 */
export async function lookupCatalogInfo(
  lines: CatalogLine[],
  vendorName: string,
): Promise<{ gtin13ByItemId: Map<number, string | null>; info: Map<number, CatalogInfo>; catalogNotConnected?: true }> {
  const withPartNumbers = lines.filter(resolvesThroughCatalog);
  const info = new Map<number, CatalogInfo>();
  if (withPartNumbers.length === 0) return { gtin13ByItemId: new Map(), info };

  const reads = await Promise.all([
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
  ]).catch((err: unknown) => {
    if (isNotWired(err)) return null;
    throw err;
  });
  if (!reads) return { gtin13ByItemId: new Map(), info, catalogNotConnected: true };
  const [categories, subcategories, lookupResults] = reads;
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

/** Fixes the catalog inputs of signed lines; a line that already has a snapshot keeps it unless `replace`. */
export async function saveCatalogSnapshots(info: Map<number, CatalogInfo>, client: Db = db, replace = false): Promise<void> {
  for (const [id, { gtin13, category, subcategory }] of info) {
    await client.expenseLineItem.updateMany({
      where: replace ? { id } : { id, signedGtin13: null },
      data: { signedGtin13: gtin13, signedCategory: category, signedSubcategory: subcategory },
    });
  }
}

const describeAccount = (category: string | null, subcategory: string | null, account: string | null) =>
  `${category && subcategory ? `${category}/${subcategory}` : "no category"} → ${account ?? "no account"}`;

/** The one account the rules give `info`, or null. */
function singleAccount(rules: AccountMapping[], info: CatalogInfo | null, li: ExpenseLineItem): string | null {
  const matches = info ? matchingRules(rules, info, li) : [];
  return matches.length === 1 ? matches[0].qbAccount : null;
}

/**
 * After a person's Retry or Resubmit read the live catalog: sets each catalog line's snapshot to that read
 * (clearing it where the catalog no longer has the part) and audits, as that person, each line whose category
 * or account moved from its previous attempt. A line with no previous read has nothing to compare; an
 * unconnected catalog read nothing, so it changes nothing.
 */
async function recordLiveRead(
  client: Db,
  actor: Actor,
  expenseId: string,
  lineItems: ExpenseLineItem[],
  rules: AccountMapping[],
  { resolved, snapshots, catalogNotConnected }: Resolution,
): Promise<void> {
  if (catalogNotConnected) return;
  const accountByLine = new Map(resolved.map((r) => [r.id, r.account]));
  for (const li of lineItems) {
    if (li.manualQbAccount || !resolvesThroughCatalog(li)) continue;
    const read = snapshots.get(li.id) ?? null;
    if (!read) {
      await client.expenseLineItem.update({ where: { id: li.id }, data: { signedGtin13: null, signedCategory: null, signedSubcategory: null } });
    }
    const previous = snapshotOf(li);
    if (!previous && !li.resolvedQbAccount) continue;
    const before = describeAccount(li.signedCategory, li.signedSubcategory, li.resolvedQbAccount ?? singleAccount(rules, previous, li));
    const after = describeAccount(read?.category ?? null, read?.subcategory ?? null, accountByLine.get(li.id) ?? null);
    if (before === after) continue;
    await writeAudit(client, actor, { expenseId, action: "qb_account_reresolved", lineItemId: li.id, fieldChanged: "qbAccount", valueBefore: before, valueAfter: after });
  }
  await saveCatalogSnapshots(snapshots, client, true);
}

// ── Stage 1: resolve accounts for all line items ─────────────────────────────

/**
 * Callers run this only once every line is signed off. `snapshots` holds the live catalog inputs of
 * lines without one; the caller saves them, so later catalog edits cannot move those accounts.
 * `liveCatalog` ignores the snapshots and reads every line live, for a person's Retry or Resubmit.
 */
type Resolution = { resolved: ResolvedItem[]; conflicts: ConflictItem[]; snapshots: Map<number, CatalogInfo>; catalogNotConnected?: true };

async function resolveAccountsForExpense(
  lineItems: ExpenseLineItem[],
  rules: AccountMapping[],
  vendorName: string,
  liveCatalog = false,
): Promise<Resolution> {
  const snapshotFor = (li: ExpenseLineItem) => (liveCatalog ? null : snapshotOf(li));
  const live = await lookupCatalogInfo(lineItems.filter((li) => !snapshotFor(li)), vendorName);
  const snapshots = new Map(live.info);

  const gtin13ByItemId = live.gtin13ByItemId;
  const itemInfoByItemId = live.info;
  for (const li of lineItems) {
    const snapshot = snapshotFor(li);
    if (!snapshot) continue;
    gtin13ByItemId.set(li.id, snapshot.gtin13);
    itemInfoByItemId.set(li.id, snapshot);
  }

  const resolved: ResolvedItem[] = [];
  const conflicts: ConflictItem[] = [];

  for (const li of lineItems) {
    // An account finance set by hand on a held line wins over every rule, whatever the hold reason.
    if (li.manualQbAccount) {
      resolved.push({ ...li, account: li.manualQbAccount, category: null, subcategory: null });
      continue;
    }
    if (!resolvesThroughCatalog(li)) continue;

    const info = itemInfoByItemId.get(li.id);
    if (!info) {
      const lookupContext = { partNumber: gtin13ByItemId.get(li.id) ?? null, isDelayed: li.isDelayed, isCapital: li.isCapital, ...(live.catalogNotConnected && { catalogNotConnected: true }) };
      conflicts.push({ lineItem: li, reason: HoldReason.NO_MATCH, matchedRows: [{ _lookupContext: lookupContext }], category: null, subcategory: null });
      continue;
    }

    const { category, subcategory } = info;
    const effectiveMatches = matchingRules(rules, info, li);

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
      if (resolvesThroughCatalog(li) || li.manualQbAccount) continue;
      const reason = li.nonInventory ? HoldReason.NON_INVENTORY : HoldReason.NO_PART_NUMBER;
      conflicts.push({ lineItem: li, reason, matchedRows: [], category: null, subcategory: null });
    }
  }

  return { resolved, conflicts, snapshots, ...(live.catalogNotConnected && { catalogNotConnected: true }) };
}

// ── Stage 2 (idempotent write): persist conflict holds ───────────────────────

async function persistConflicts(
  client: Db,
  orgId: string,
  expenseId: string,
  conflicts: ConflictItem[],
): Promise<void> {
  const existing = await client.expenseHold.findMany({
    where: { orgId, expenseId, status: "PENDING" },
    select: { lineItemId: true, id: true },
  });

  const existingByLineItem = new Map(existing.map((h) => [h.lineItemId, h.id]));

  for (const c of conflicts) {
    const matchedRowsJson = JSON.stringify(c.matchedRows);
    const existingId = existingByLineItem.get(c.lineItem.id);
    if (existingId !== undefined) {
      await client.expenseHold.update({
        where: { id: existingId },
        data: { matchedRows: matchedRowsJson, reason: c.reason },
      });
    } else {
      await client.expenseHold.create({
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

// ── Stage 4 (atomic): commit QB processing ───────────────────────────────────
// All domain writes (holds, allocations, resolved accounts, event) and the state transition are
// committed in a single interactive transaction so the expense can never be
// observed in qb_pending after the event has been persisted, nor vice-versa.
// The sign-off holds, lines, rules and accounts are re-read under the expense lock before anything
// is written, catalog snapshots included, so a seat void or an account change either lands first
// and is used, or finds the expense closed. A line that no longer resolves leaves the expense in
// qb_pending for the stranded sweep, which holds it.

async function commitQbProcessing(orgId: string, expenseId: string, resubmittedBy: Actor | undefined): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    const current = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
    if ((await outboxHeldIds(tx, [current])).size > 0) return false;
    const lineItems = await tx.expenseLineItem.findMany({ where: { expenseId } });
    const rules = await tx.accountMapping.findMany({ where: { orgId } });
    const resolution = await resolveAccountsForExpense(lineItems, rules, current.vendorName ?? "", !!resubmittedBy);
    if (resolution.conflicts.length > 0) return false;
    if (resubmittedBy) await recordLiveRead(tx, resubmittedBy, expenseId, lineItems, rules, resolution);
    else await saveCatalogSnapshots(resolution.snapshots, tx);

    const resolvedLineItemIds = resolution.resolved.map((r) => r.id);
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

    const accountByLine = new Map(resolution.resolved.map((r) => [r.id, r.account]));
    const { taxAlloc, shippingAlloc, discountAlloc } = allocationsFor(current, lineItems);
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
    await tx.expense.update({ where: { id: expenseId }, data: { qbFirstFailedAt: null, qbLastError: null, qbFaultText: null } });

    await advanceWorkflowInTx(tx, {
      expenseId,
      currentState: "qb_pending",
      event: { type: "QB_COMPLETE" },
      actor: SYSTEM_ACTOR,
      action: "qb_event_emitted",
    });
    return true;
  }, { timeout: 15_000 });
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/** `resubmittedBy` is the person who pressed Resubmit; their run reads the live catalog instead of the sign-off snapshot. */
export async function checkAndProcessExpense(orgId: string, expenseId: string, resubmittedBy?: Actor): Promise<void> {
  let expense = await db.expense.findFirst({ where: { id: expenseId } });
  if (!expense) return;

  // A retry of a qb_error expense goes back to qb_pending, so the machine path for QB_COMPLETE holds.
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

  // A held expense stays out of the outbox; the step that clears the hold drains it. The outbox commit re-checks under the lock.
  if ((await outboxHeldIds(db, [expense])).size > 0) return;

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

  try {
    await processExpenseForQb(orgId, expenseId, expense, resubmittedBy);
  } catch (err) {
    // A concurrent drain moved the expense first and carries it on; this is not a QB failure.
    if (err instanceof StaleStateError) return;
    logError("qb_processing_failed", { expenseId, orgId, state: expense.state }, err);

    const current = await db.expense.findFirst({ where: { id: expenseId } });
    if (!current || (current.state !== "qb_pending" && current.state !== "qb_on_hold")) throw err;

    const error = err instanceof Error ? err.message : String(err);
    await advanceWorkflow({
      db,
      expenseId,
      currentState: current.state,
      event: { type: "QB_ERROR" },
      actor: SYSTEM_ACTOR,
      action: "qb_processing_failed",
      auditNotes: error,
    }).catch(unlessRaceLost);
    // Stuck in qb_error until a person retries it; the first failure's time is kept.
    await db.expense.updateMany({ where: { id: expenseId, state: "qb_error" }, data: { qbLastError: error, qbFaultText: null } });
    await db.expense.updateMany({ where: { id: expenseId, state: "qb_error", qbFirstFailedAt: null }, data: { qbFirstFailedAt: new Date() } });
  }
}

async function processExpenseForQb(orgId: string, expenseId: string, expense: Expense, resubmittedBy: Actor | undefined): Promise<void> {
  const lineItems = await db.expenseLineItem.findMany({ where: { expenseId } });

  if (lineItems.length === 0) return;

  const rules = await db.accountMapping.findMany({ where: { orgId } });

  const resolution = await resolveAccountsForExpense(lineItems, rules, expense.vendorName ?? "", !!resubmittedBy);
  const { conflicts, snapshots } = resolution;

  if (conflicts.length > 0) {
    // Under the lock, so a drain that outboxed the expense first is left alone.
    const held = await db.$transaction(async (tx) => {
      await lockExpense(tx, expenseId);
      const current = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
      if (current.state !== "qb_pending" && current.state !== "qb_on_hold") return false;
      if (await tx.expenseEvent.findFirst({ where: { orgId, expenseId } })) return false;
      if (resubmittedBy) await recordLiveRead(tx, resubmittedBy, expenseId, lineItems, rules, resolution);
      else await saveCatalogSnapshots(snapshots, tx);
      await persistConflicts(tx, orgId, expenseId, conflicts);
      return true;
    });
    if (!held) return;

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
    await db.expense.update({ where: { id: expenseId }, data: { qbFirstFailedAt: null, qbLastError: null, qbFaultText: null } });
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

  try {
    const committed = await commitQbProcessing(orgId, expenseId, resubmittedBy);
    if (!committed) return;
    await sendOutcomeNotices([expenseId]);
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    // Unique constraint on expenseEvents → concurrent run already committed; safe to ignore
  }

  // Post right after the outbox commit; anything left is the catch-up drain's.
  await postExpenseToQb(orgId, expenseId).catch((err) => logError("qb_post_failed", { expenseId, orgId }, err));
}

// ── Stranded recovery (catch-up sweep) ────────────────────────────────────────
// Re-runs expenses left in qb_pending without an outbox row (a crash between the state advance and
// QB processing). A held expense or a qb_error one waits for a person, so neither takes a slot. The
// host's daily cron step calls it; checkAndProcessExpense is idempotent. Capped; returns counts only.

export async function recoverStrandedQbExpenses(limit = 50): Promise<{ checked: number; failed: number }> {
  const candidates = await db.expense.findMany({
    where: { state: "qb_pending" },
    orderBy: { submittedAt: "asc" },
    select: OUTBOX_HOLD_FIELDS,
  });

  const processedIds = new Set(
    (await db.expenseEvent.findMany({
      where: { expenseId: { in: candidates.map((e) => e.id) } },
      select: { expenseId: true },
    })).map((e) => e.expenseId),
  );

  let checked = 0;
  let failed = 0;
  const unprocessed = candidates.filter((c) => !processedIds.has(c.id));
  // Hold checks read sign-off facts, so they run a batch at a time and stop once the batch is full.
  for (let start = 0; start < unprocessed.length && checked < limit; start += limit) {
    const page = unprocessed.slice(start, start + limit);
    const held = await outboxHeldIds(db, page);
    for (const { id, orgId } of page.filter((c) => !held.has(c.id)).slice(0, limit - checked)) {
      checked++;
      try {
        await checkAndProcessExpense(orgId, id);
      } catch (err) {
        failed++;
        logError("recovery_failed", { expenseId: id, orgId }, err);
      }
    }
  }
  return { checked, failed };
}

// ── Finance retry of a failed QuickBooks post ─────────────────────────────────

/** A missing or unreachable catalog as the 503 finance reads; the lookup already answers an unbound catalog as matching nothing. */
function refuseMissingCatalog(err: unknown): never {
  const message = catalogSettingsMessage(err) ?? (kindOf(err) === "system" ? "The catalog is unavailable; try again" : null);
  throw message ? new ServiceError(503, message) : err;
}

/**
 * Re-arms an expense whose post failed: re-resolves each line's account from the current account
 * mappings and the live catalog (so a fixed mapping or catalog entry takes effect), audits each
 * account that moves, and records who asked, all under the row lock so an
 * in-flight post never reads half-rewritten accounts; then posts once. A post that books leaves
 * NEEDS_FINANCE, which clears the QB_POST_FAILED reason (read from that state) and the failure,
 * and checks off any open QB_POST_HELD flag; one that fails keeps its first failure time.
 * Returns the post's outcome; "unbound" when QuickBooks is not connected, and false when a line no
 * longer resolves to one account. Either refusal before the re-arm leaves the expense as it is.
 */
export async function retryQbPost(orgId: string, expenseId: string, actor: Actor): Promise<PostOutcome | "unbound" | false> {
  if (!(await getExpenseRuntime().quickbooks.posting())) return "unbound";
  const rearmed = await db.$transaction(async (tx) => {
    await lockExpense(tx, expenseId);
    const expense = await tx.expense.findFirst({ where: { id: expenseId, orgId } });
    if (!expense || !["POST_FAILED", "NEEDS_FINANCE"].includes(expense.qbMatchState)) return false;
    const lineItems = await tx.expenseLineItem.findMany({ where: { expenseId } });
    const rules = await tx.accountMapping.findMany({ where: { orgId } });
    const resolution = await resolveAccountsForExpense(lineItems, rules, expense.vendorName ?? "", true).catch(refuseMissingCatalog);
    const { resolved, conflicts } = resolution;
    if (conflicts.length > 0) return false;
    await recordLiveRead(tx, actor, expenseId, lineItems, rules, resolution);

    for (const r of resolved) {
      await tx.expenseLineItem.update({ where: { id: r.id }, data: { resolvedQbAccount: r.account } });
    }
    await tx.expense.update({ where: { id: expenseId }, data: { qbMatchState: "POST_FAILED" } });
    await writeAudit(tx, actor, { expenseId, action: "qb_post_retried" });
    return true;
  });
  if (!rearmed) return false;
  return postExpenseToQb(orgId, expenseId);
}
