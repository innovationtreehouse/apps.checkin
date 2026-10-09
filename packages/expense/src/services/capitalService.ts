// Capital review, depreciation cycle and the ITFA capital register (FE4). FINANCE only.
import { z } from "zod";
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrg } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { drainExpense } from "../lib/financial-flow";
import { advanceWorkflowInTx } from "../lib/workflow-engine";
import { formatItfa, fullyDepreciatedDate, nextItfaSeq, parseItfa } from "../lib/capital-register";
import { assertExpectedState, isLegalTransition } from "../workflows/expense.invariants";
import { NEUTRAL_CONTEXT } from "../workflows/expense.guards";
import { createExpenseRepository } from "../repositories/expense";
import { requireFinance } from "./approvalService";
import { ServiceError } from "./serviceError";

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
})).min(1).max(2000);

async function loadExpense(expenseId: string, eventType: string, stateName: string) {
  const expense = await expenseRepo.findExpenseById(expenseId, getOrg().id);
  if (!expense) throw new ServiceError(404, "Expense not found");
  if (!isLegalTransition(expense.state, eventType)) throw new ServiceError(400, `Expense is not in ${stateName} state`);
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

  const hasAnyCapital = lineItems.some((li) => li.isCapital);
  const event = { type: "CAPITAL_REVIEW_SUBMITTED" as const, hasCapitalItems: hasAnyCapital };
  const nextState = hasAnyCapital ? "set_depreciation_cycle" : "qb_pending";
  assertExpectedState("capital_review", event, NEUTRAL_CONTEXT, nextState);

  // Line item writes, audit records, and state transition are a single atomic unit.
  await db.$transaction(async (tx) => {
    for (const li of lineItems) {
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

/** Sets each capital line's cycle and mints one ITFA asset per unit into the register. */
export async function setDepreciationCycle(
  principal: ExpensePrincipal,
  expenseId: string,
  input: z.infer<typeof SetDepreciationCycleSchema>,
): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const expense = await loadExpense(expenseId, "DEPRECIATION_SET", "set_depreciation_cycle");
  const { items } = input;

  const capitalLines = await db.expenseLineItem.findMany({ where: { expenseId, isCapital: true } });
  const capLineById = new Map(capitalLines.map((li) => [li.id, li]));
  const submittedIds = new Set(items.map((i) => i.lineItemId));
  for (const { id } of capitalLines) {
    if (!submittedIds.has(id)) throw new ServiceError(400, `Missing depreciation for capital line item ${id}`);
  }
  for (const item of items) {
    if (!capLineById.has(item.lineItemId)) throw new ServiceError(400, `Line item ${item.lineItemId} is not a capital item`);
  }

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

      // Idempotent: a line that already has assets (a resubmit) mints none.
      const line = capLineById.get(item.lineItemId)!;
      if ((await tx.capitalAsset.count({ where: { sourceLineItemId: line.id } })) === 0) {
        const units = Math.max(1, Math.round(line.quantity));
        const fdd = fullyDepreciatedDate(expense.receiptDate, item.depreciationYears);
        let seq = await nextItfaSeq(tx, expense.orgId);
        for (let u = 0; u < units; u++) {
          await tx.capitalAsset.create({
            data: {
              orgId: expense.orgId,
              assetNumber: formatItfa(seq++),
              description: line.description,
              acquisitionDate: expense.receiptDate,
              costCents: line.unitPriceCents,
              depreciationYears: item.depreciationYears,
              fullyDepreciatedDate: fdd,
              status: "tracked",
              sourceExpenseId: expenseId,
              sourceLineItemId: line.id,
              sourceReceiptId: expenseId,
              seeded: false,
            },
          });
        }
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
  const orgId = getOrg().id;
  const results: CapitalSeedResult["results"] = [];
  for (const r of rows) {
    const seq = parseItfa(r.assetNumber);
    if (seq === null) { results.push({ assetNumber: r.assetNumber, status: "error", error: "not an ITFA number" }); continue; }
    const assetNumber = formatItfa(seq); // canonicalize (no space/dash, zero-padded)
    const parentSeq = r.parentAssetNumber ? parseItfa(r.parentAssetNumber) : null;
    const created = await db.capitalAsset.createMany({
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
        seeded: true,
      }],
      skipDuplicates: true,
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
