// Capital review, depreciation cycle and the ITFA capital register (FE4). FINANCE only.
import { z } from "zod";
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit, writeOrgAudit } from "../lib/audit";
import { dropHandSetAccount } from "../lib/account-types";
import { drainExpense } from "../lib/financial-flow";
import { advanceWorkflowInTx } from "../lib/workflow-engine";
import { formatItfa, fullyDepreciatedDate, linkAssets, parseItfa, raiseHighestIssued, registerAssets, unitCosts, unitsOf } from "../lib/capital-register";
import { bookedLineCents } from "../qb-write";
import { reimburseeUnknown } from "../lib/signoff";
import { assertExpectedState, isLegalTransition } from "../workflows/expense.invariants";
import { NEUTRAL_CONTEXT } from "../workflows/expense.guards";
import { createExpenseRepository } from "../repositories/expense";
import { requireFinance, requireLiveBuckets } from "./approvalService";
import { ServiceError } from "@checkin/component-kit";

const expenseRepo = createExpenseRepository(db);

export const CapitalReviewSchema = z.object({
  lineItems: z
    .array(
      z.object({
        lineItemId: z.number().int().positive(),
        isCapital: z.boolean(),
        capitalOwnerId: z.number().int().positive().nullable().optional(),
        depreciationYears: z.number().int().positive().nullable().optional(),
      }).strict(),
    )
    .min(1),
}).strict();

export const SetDepreciationCycleSchema = z.object({
  items: z
    .array(
      z.object({
        lineItemId: z.number().int().positive(),
        depreciationYears: z.number().int().positive(),
        ownerId: z.number().int().positive(),
        // A backfilled expense's historical labels, one per unit in unit order.
        seededAssetNumbers: z.array(z.string().min(1).max(20)).min(1).max(1000).optional(),
      }),
    )
    .min(1),
});

/** One physical asset per record; the producer expands QB ranges/lists to individual numbers. */
export const CapitalSeedSchema = z.array(z.object({
  assetNumber: z.string().min(1).max(20),
  description: z.string().min(1).max(500),
  acquisitionDate: z.string().max(50).nullable().optional(),
  costCents: z.number().int().nullable().optional(),
  depreciationYears: z.number().int().positive().nullable().optional(),
  parentAssetNumber: z.string().max(20).nullable().optional(),
  sourceQbTxnId: z.string().max(100).nullable().optional(),
  sourceQbTxnEntity: z.enum(["Bill", "Purchase"]).nullable().optional(),
})).min(1).max(2000);

async function loadExpense(expenseId: string, eventType: string, stateName: string) {
  const expense = await expenseRepo.findExpenseById(expenseId, await getOrgId());
  if (!expense) throw new ServiceError(404, "Expense not found");
  if (!isLegalTransition(expense.state, eventType)) throw new ServiceError(400, `Expense is not in ${stateName} state`);
  if (reimburseeUnknown(expense)) throw new ServiceError(409, "The reimbursee is unknown; FINANCE sets it before capital review");
  return expense;
}

export async function submitCapitalReview(
  principal: ExpensePrincipal,
  expenseId: string,
  input: z.infer<typeof CapitalReviewSchema>,
): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const expense = await loadExpense(expenseId, "CAPITAL_REVIEW_SUBMITTED", "capital_review");
  const { lineItems } = input;

  const submittedIds = new Set(lineItems.map((li) => li.lineItemId));
  for (const { id } of await expenseRepo.listLineItemIds(expenseId)) {
    if (!submittedIds.has(id)) throw new ServiceError(400, `Missing designation for line item ${id}`);
  }
  await requireLiveBuckets(lineItems.flatMap((li) => (li.isCapital && li.capitalOwnerId != null ? [li.capitalOwnerId] : [])));

  const hasAnyCapital = lineItems.some((li) => li.isCapital);
  const event = { type: "CAPITAL_REVIEW_SUBMITTED" as const, hasCapitalItems: hasAnyCapital };
  const nextState = hasAnyCapital ? "set_depreciation_cycle" : "qb_pending";
  assertExpectedState("capital_review", event, NEUTRAL_CONTEXT, nextState);

  // Line item writes, audit records, and state transition are a single atomic unit.
  await db.$transaction(async (tx) => {
    const before = new Map((await tx.expenseLineItem.findMany({ where: { expenseId }, select: { id: true, isCapital: true, manualQbAccount: true } })).map((l) => [l.id, l]));
    for (const li of lineItems) {
      const was = before.get(li.lineItemId);
      if (was && was.isCapital !== li.isCapital) await dropHandSetAccount(tx, actor, expenseId, was);
      await tx.expenseLineItem.update({
        where: { id: li.lineItemId, expenseId },
        data: {
          isCapital: li.isCapital,
          capitalOwnerId: li.isCapital ? (li.capitalOwnerId ?? null) : null,
          depreciationYears: null,
        },
      });
      await writeAudit(tx, actor, {
        expenseId,
        action: "capital_designation_set",
        lineItemId: li.lineItemId,
        valueAfter: li.isCapital ? "capital" : "non_capital",
      });
    }
    await advanceWorkflowInTx(tx, {
      expenseId,
      currentState: "capital_review",
      event,
      actor,
      action: "capital_review_submitted",
    });
  });

  if (nextState === "qb_pending") await drainExpense(expense.orgId, expenseId);
}

/** Sets each capital line's cycle and registers one ITFA asset per unit; a backfilled line links its seeded assets instead. */
export async function setDepreciationCycle(
  principal: ExpensePrincipal,
  expenseId: string,
  input: z.infer<typeof SetDepreciationCycleSchema>,
): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const expense = await loadExpense(expenseId, "DEPRECIATION_SET", "set_depreciation_cycle");
  const { items } = input;

  const lines = await db.expenseLineItem.findMany({ where: { expenseId } });
  const capitalLines = lines.filter((li) => li.isCapital);
  const capLineById = new Map(capitalLines.map((li) => [li.id, li]));
  const booked = bookedLineCents(expense, lines);
  const submittedIds = new Set(items.map((i) => i.lineItemId));
  for (const { id } of capitalLines) {
    if (!submittedIds.has(id)) throw new ServiceError(400, `Missing depreciation for capital line item ${id}`);
  }
  for (const item of items) {
    const line = capLineById.get(item.lineItemId);
    if (!line) throw new ServiceError(400, `Line item ${item.lineItemId} is not a capital item`);
    if (!expense.backfill && item.seededAssetNumbers) throw new ServiceError(400, "Only a backfilled expense links seeded asset numbers");
    if (expense.backfill && item.seededAssetNumbers?.length !== unitsOf(line.quantity)) {
      throw new ServiceError(400, `Line item ${line.id} needs a seeded asset number for each of its ${unitsOf(line.quantity)} units`);
    }
  }
  await requireLiveBuckets(items.map((i) => i.ownerId));

  assertExpectedState("set_depreciation_cycle", { type: "DEPRECIATION_SET" }, NEUTRAL_CONTEXT, "qb_pending");

  await db.$transaction(async (tx) => {
    for (const item of items) {
      await tx.expenseLineItem.update({
        where: { id: item.lineItemId, expenseId },
        data: { depreciationYears: item.depreciationYears, capitalOwnerId: item.ownerId },
      });
      await writeAudit(tx, actor, {
        expenseId,
        action: "depreciation_cycle_set",
        lineItemId: item.lineItemId,
        valueAfter: `${item.depreciationYears}y/owner:${item.ownerId}`,
      });

      const line = capLineById.get(item.lineItemId)!;
      const source = { kind: "expense_line" as const, expenseId, lineItemId: line.id };
      if (item.seededAssetNumbers) {
        await linkAssets(tx, actor, expense.orgId, source, item.seededAssetNumbers);
      } else {
        const units = unitCosts(booked.get(line.id)!, unitsOf(line.quantity)).map((costCents) => ({
          costCents, acquisitionDate: expense.receiptDate, depreciationYears: item.depreciationYears, description: line.description,
        }));
        await registerAssets(tx, actor, expense.orgId, source, units);
      }
    }
    await advanceWorkflowInTx(tx, {
      expenseId,
      currentState: "set_depreciation_cycle",
      event: { type: "DEPRECIATION_SET" },
      actor,
      action: "depreciation_cycle_set",
    });
  });

  await drainExpense(expense.orgId, expenseId);
}

export interface CapitalSeedResult {
  created: number;
  skipped: number;
  errors: number;
  results: { assetNumber: string; status: "created" | "skipped" | "error"; error?: string }[];
}

/** Seeds the register from historical QuickBooks asset numbers. Idempotent per (orgId, assetNumber). */
export async function seedCapitalAssets(
  principal: ExpensePrincipal,
  rows: z.infer<typeof CapitalSeedSchema>,
): Promise<CapitalSeedResult> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const orgId = await getOrgId();
  const results: CapitalSeedResult["results"] = [];
  for (const r of rows) {
    const seq = parseItfa(r.assetNumber);
    if (seq === null) { results.push({ assetNumber: r.assetNumber, status: "error", error: "not an ITFA number" }); continue; }
    const assetNumber = formatItfa(seq); // canonicalize (no space/dash, zero-padded)
    const parentSeq = r.parentAssetNumber ? parseItfa(r.parentAssetNumber) : null;
    const created = await db.$transaction(async (tx) => {
      // Raising the mark first waits out a mint in flight, so the seed sees any number it took.
      await raiseHighestIssued(tx, orgId, seq);
      const result = await tx.capitalAsset.createMany({
        data: [{
          orgId,
          assetNumber,
          parentAssetNumber: parentSeq === null ? null : formatItfa(parentSeq),
          description: r.description,
          acquisitionDate: r.acquisitionDate ?? null,
          costCents: r.costCents ?? null,
          depreciationYears: r.depreciationYears ?? null,
          fullyDepreciatedDate: fullyDepreciatedDate(r.acquisitionDate, r.depreciationYears),
          status: "tracked",
          sourceQbTxnId: r.sourceQbTxnId ?? null,
          sourceQbTxnEntity: r.sourceQbTxnEntity ?? null,
          seeded: true,
        }],
        skipDuplicates: true,
      });
      if (result.count === 1) {
        await writeOrgAudit(tx, orgId, actor, { entityType: "capital_asset", entityId: assetNumber, action: "seeded", after: r });
      }
      return result;
    });
    results.push({ assetNumber, status: created.count === 1 ? "created" : "skipped" });
  }
  return {
    created: results.filter((x) => x.status === "created").length,
    skipped: results.filter((x) => x.status === "skipped").length,
    errors: results.filter((x) => x.status === "error").length,
    results,
  };
}
