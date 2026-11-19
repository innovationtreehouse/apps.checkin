// Capital review, depreciation cycle and the ITFA capital register (FE4). FINANCE only.
import { z } from "zod";
import type { ExpenseLineItem, Prisma } from "../generated/prisma/client";
import { db } from "../db";
import type { ExpensePrincipal } from "../contract";
import { getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit, writeOrgAudit } from "../lib/audit";
import { dropHandSetAccount } from "../lib/account-types";
import { drainExpense } from "../lib/financial-flow";
import { advanceWorkflowInTx, type Actor } from "../lib/workflow-engine";
import { formatItfa, fullyDepreciatedDate, linkAssets, parseItfa, raiseHighestIssued, registerAssets, seedCollision, unitCosts, unitsOf, type SeedColumns } from "../lib/capital-register";
import { bookedLineCents } from "../qb-write";
import { reimburseeUnknown } from "../lib/signoff";
import { assertExpectedState, isLegalTransition } from "../workflows/expense.invariants";
import { NEUTRAL_CONTEXT } from "../workflows/expense.guards";
import { createExpenseRepository } from "../repositories/expense";
import { requireFinance } from "./approvalService";
import { capitalWaitsOn, designate, setPeriod, type CapitalLineStore, type CapitalReviewInput, type SetDepreciationCycleInput } from "./capitalReview";
import { ServiceError } from "@checkin/component-kit";

const expenseRepo = createExpenseRepository(db);

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

/** Binds the capital review to an expense's lines, its audit log and its state, inside its transaction. */
function expenseLineStore(tx: Prisma.TransactionClient, actor: Actor, expenseId: string) {
  let rows = new Map<number, ExpenseLineItem>();
  const store: CapitalLineStore = {
    async lines() {
      const found = await tx.expenseLineItem.findMany({ where: { expenseId } });
      rows = new Map(found.map((r) => [r.id, r]));
      return found.map((r) => ({ id: r.id, isCapital: r.isCapital, ownerId: r.capitalOwnerId, depreciationYears: r.depreciationYears }));
    },
    async save(step, line, before) {
      if (step === "designated" && before.isCapital !== line.isCapital) await dropHandSetAccount(tx, actor, expenseId, rows.get(line.id)!);
      await tx.expenseLineItem.update({
        where: { id: line.id, expenseId },
        data: { isCapital: line.isCapital, capitalOwnerId: line.ownerId, depreciationYears: line.depreciationYears },
      });
      await writeAudit(tx, actor, step === "designated"
        ? { expenseId, action: "capital_designation_set", lineItemId: line.id, valueAfter: line.isCapital ? "capital" : "non_capital" }
        : { expenseId, action: "depreciation_cycle_set", lineItemId: line.id, valueAfter: `${line.depreciationYears}y/owner:${line.ownerId}` });
    },
    // The only move out of capital_review and set_depreciation_cycle; it lands where the lines say.
    async afterStep(step) {
      const lines = await store.lines();
      const waitsOn = capitalWaitsOn(lines);
      const landsIn = waitsOn === "designation" ? "capital_review" : waitsOn === "period" ? "set_depreciation_cycle" : "qb_pending";
      const currentState = step === "designated" ? "capital_review" : "set_depreciation_cycle";
      const event = step === "designated"
        ? { type: "CAPITAL_REVIEW_SUBMITTED" as const, hasCapitalItems: lines.some((l) => l.isCapital) }
        : { type: "DEPRECIATION_SET" as const };
      assertExpectedState(currentState, event, NEUTRAL_CONTEXT, landsIn);
      await advanceWorkflowInTx(tx, {
        expenseId,
        currentState,
        event,
        actor,
        action: step === "designated" ? "capital_review_submitted" : "depreciation_cycle_set",
      });
    },
  };
  return { store, rows: () => [...rows.values()] };
}

export async function submitCapitalReview(
  principal: ExpensePrincipal,
  expenseId: string,
  input: CapitalReviewInput,
): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const expense = await loadExpense(expenseId, "CAPITAL_REVIEW_SUBMITTED", "capital_review");

  await db.$transaction((tx) => designate(expenseLineStore(tx, actor, expenseId).store, input));

  if (!input.lineItems.some((li) => li.isCapital)) await drainExpense(expense.orgId, expenseId);
}

/** Sets each capital line's cycle and registers one ITFA asset per unit; a backfilled line links its seeded assets instead. */
export async function setDepreciationCycle(
  principal: ExpensePrincipal,
  expenseId: string,
  input: SetDepreciationCycleInput,
): Promise<void> {
  requireFinance(principal);
  const actor = actorOf(principal);
  const expense = await loadExpense(expenseId, "DEPRECIATION_SET", "set_depreciation_cycle");

  await db.$transaction((tx) => {
    const { store, rows } = expenseLineStore(tx, actor, expenseId);
    return setPeriod(store, input, async (line, item) => {
      const row = rows().find((r) => r.id === line.id)!;
      const units = unitsOf(row.quantity);
      if (!expense.backfill && item.seededAssetNumbers) throw new ServiceError(400, "Only a backfilled expense links seeded asset numbers");
      if (expense.backfill && item.seededAssetNumbers?.length !== units) {
        throw new ServiceError(400, `Line item ${line.id} needs a seeded asset number for each of its ${units} units`);
      }
      const source = { kind: "expense_line" as const, expenseId, lineItemId: line.id };
      if (item.seededAssetNumbers) {
        await linkAssets(tx, actor, expense.orgId, source, item.seededAssetNumbers);
      } else {
        const booked = bookedLineCents(expense, rows()).get(line.id)!;
        const assets = unitCosts(booked, units).map((costCents) => ({
          costCents, acquisitionDate: expense.receiptDate, depreciationYears: item.depreciationYears, description: row.description,
        }));
        await registerAssets(tx, actor, expense.orgId, source, assets);
      }
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

/**
 * Seeds the register from historical QuickBooks asset numbers. An exact repeat of a seeded row is
 * skipped; a number already held by any other asset is refused for that row.
 */
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
    const columns: SeedColumns = {
      parentAssetNumber: parentSeq === null ? null : formatItfa(parentSeq),
      description: r.description,
      acquisitionDate: r.acquisitionDate ?? null,
      costCents: r.costCents ?? null,
      depreciationYears: r.depreciationYears ?? null,
      sourceQbTxnId: r.sourceQbTxnId ?? null,
      sourceQbTxnEntity: r.sourceQbTxnEntity ?? null,
    };
    const result = await db.$transaction(async (tx): Promise<CapitalSeedResult["results"][number]> => {
      // Raising the mark first takes its lock, so no mint or other seed takes this number meanwhile.
      await raiseHighestIssued(tx, orgId, seq);
      const existing = await tx.capitalAsset.findUnique({ where: { capital_assets_org_number_unique: { orgId, assetNumber } } });
      if (existing) {
        const error = seedCollision(assetNumber, existing, columns);
        return error ? { assetNumber, status: "error", error } : { assetNumber, status: "skipped" };
      }
      await tx.capitalAsset.create({
        data: {
          orgId,
          assetNumber,
          ...columns,
          fullyDepreciatedDate: fullyDepreciatedDate(r.acquisitionDate, r.depreciationYears),
          status: "tracked",
          seeded: true,
        },
      });
      await writeOrgAudit(tx, orgId, actor, { entityType: "capital_asset", entityId: assetNumber, action: "seeded", after: r });
      return { assetNumber, status: "created" };
    });
    results.push(result);
  }
  return {
    created: results.filter((x) => x.status === "created").length,
    skipped: results.filter((x) => x.status === "skipped").length,
    errors: results.filter((x) => x.status === "error").length,
    results,
  };
}
