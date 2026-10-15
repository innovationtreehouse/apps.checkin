// FINANCE links a reimbursee to the QuickBooks Vendor their Bills post to. One Vendor per
// person and one person per Vendor (both unique in reimbursee_vendor); a link is never changed.
import { db, isUniqueConstraintError } from "../db";
import type { ExpenseReimburseeVendor } from "../generated/prisma/client";
import type { ExpensePrincipal } from "../contract";
import { assertOrg, getExpenseRuntime, getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { ServiceError } from "./serviceError";

export type VendorChoice = { qbVendorId: string } | { createName: string };

export const QB_OFF = "QuickBooks is off here, so a Vendor cannot be created; link an existing Vendor id instead";

/** The reimbursee's linked Vendor on a FINANCE-visible expense; null when none is linked. */
export async function reimburseeVendorFor(orgId: string, expenseId: string): Promise<ExpenseReimburseeVendor | null> {
  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId }, select: { reimburseePersonId: true } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  if (expense.reimburseePersonId === null) return null;
  return db.expenseReimburseeVendor.findFirst({ where: { orgId, reimburseePersonId: expense.reimburseePersonId } });
}

/** The QuickBooks Vendor id linked to a reimbursee; null when none is linked. Bound by the host as QbRefs.vendorIdFor. */
export async function reimburseeVendorId(personId: number): Promise<string | null> {
  const row = await db.expenseReimburseeVendor.findFirst({ where: { orgId: await getOrgId(), reimburseePersonId: personId }, select: { qbVendorId: true } });
  return row?.qbVendorId ?? null;
}

/** Whether the actor is this person or shares a household with them. */
async function sameHousehold(personId: number, actorId: number): Promise<boolean> {
  return [personId, ...(await getExpenseRuntime().signoff.householdOf([personId]))].includes(actorId);
}

/**
 * Links the expense's reimbursee to a Vendor: a typed existing id, or one found or created in
 * QuickBooks by name. The setter may not link themself or their household, either directly or
 * through a Vendor already linked to them; each such refusal is audited on the expense. Expenses
 * of the reimbursee parked for want of a Vendor go back to the outbox.
 */
export async function linkReimburseeVendor(
  orgId: string,
  expenseId: string,
  choice: VendorChoice,
  principal: ExpensePrincipal,
): Promise<ExpenseReimburseeVendor> {
  await assertOrg(orgId);
  const actor = actorOf(principal);
  if (!principal.isFinance) throw new ServiceError(403, "Only FINANCE links a reimbursee's QuickBooks Vendor");

  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  if (!expense.needsReimbursement) throw new ServiceError(400, "Expense is not a reimbursement");
  const personId = expense.reimburseePersonId;
  if (personId === null) throw new ServiceError(409, "Set the reimbursee before linking a Vendor");
  if (await db.expenseReimburseeVendor.findFirst({ where: { orgId, reimburseePersonId: personId } })) {
    throw new ServiceError(409, "The reimbursee already has a QuickBooks Vendor");
  }

  const refuse = async (reason: string): Promise<never> => {
    await writeAudit(db, actor, { expenseId, action: "reimbursee_vendor_refused", notes: reason });
    throw new ServiceError(403, reason);
  };
  if (await sameHousehold(personId, actor.userId)) await refuse("You cannot link yourself or your household to a QuickBooks Vendor");

  let qbVendorId: string;
  if ("createName" in choice) {
    const vendor = await getExpenseRuntime().quickbooks.vendors.findOrCreate(choice.createName, `reimbursee-vendor-${orgId}-${personId}`);
    if (!vendor) throw new ServiceError(503, QB_OFF);
    qbVendorId = vendor.id;
  } else {
    qbVendorId = choice.qbVendorId;
  }

  const holder = await db.expenseReimburseeVendor.findFirst({ where: { orgId, qbVendorId } });
  if (holder) {
    if (await sameHousehold(holder.reimburseePersonId, actor.userId)) await refuse("That QuickBooks Vendor is linked to you or your household");
    throw new ServiceError(409, "That QuickBooks Vendor is already linked to another person");
  }

  return db
    .$transaction(async (tx) => {
      const row = await tx.expenseReimburseeVendor.create({ data: { orgId, reimburseePersonId: personId, qbVendorId } });
      await writeAudit(tx, actor, { expenseId, action: "reimbursee_vendor_set", fieldChanged: "qbVendorId", valueAfter: qbVendorId });
      // ponytail: re-arms every AMBIGUOUS reimbursement of this person; one ambiguous on QuickBooks candidates just parks again.
      const parked = await tx.expense.findMany({
        where: { orgId, reimburseePersonId: personId, needsReimbursement: true, backfill: false, qbTxnId: null, qbMatchState: "AMBIGUOUS" },
        select: { id: true },
      });
      for (const { id } of parked) {
        await tx.expense.update({ where: { id }, data: { qbMatchState: "UNMATCHED" } });
        await writeAudit(tx, actor, {
          expenseId: id,
          action: "qb_unmatched",
          fieldChanged: "qbMatchState",
          valueBefore: "AMBIGUOUS",
          valueAfter: "UNMATCHED",
          notes: "the reimbursee's QuickBooks Vendor was linked",
        });
      }
      return row;
    })
    .catch((err: unknown) => {
      if (isUniqueConstraintError(err)) throw new ServiceError(409, "The reimbursee or the Vendor was linked concurrently");
      throw err;
    });
}
