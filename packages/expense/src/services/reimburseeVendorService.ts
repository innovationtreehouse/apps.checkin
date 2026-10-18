// FINANCE links a reimbursee to the QuickBooks Vendor their Bills post to. One Vendor per
// person and one person per Vendor (both unique in reimbursee_vendor); a link is never changed.
import { db, isUniqueConstraintError } from "../db";
import type { ExpenseReimburseeVendor } from "../generated/prisma/client";
import type { ExpensePrincipal, QbVendorClient, QbVendorOption } from "../contract";
import { assertOrg, getExpenseRuntime, getOrgId } from "../runtime";
import { actorOf } from "../lib/caller";
import { writeAudit } from "../lib/audit";
import { conflictedParties } from "../lib/signoff-facts";
import { QB_OFF } from "../lib/expense-constants";
import { ServiceError } from "@checkin/component-kit";

/** A Vendor QuickBooks already has, by id, or one found or created under the reimbursee's own name. */
export type VendorChoice = { qbVendorId: string } | { createForReimbursee: true };

/** The reimbursee shown on an expense: their person id and name. */
export interface ReimburseeView {
  personId: number;
  name: string | null;
}

/** On a FINANCE-visible expense: the reimbursee, when known, and their linked Vendor, when any. */
export async function reimburseeVendorFor(
  orgId: string,
  expenseId: string,
): Promise<{ link: ExpenseReimburseeVendor | null; reimbursee: ReimburseeView | null }> {
  const expense = await db.expense.findFirst({ where: { id: expenseId, orgId }, select: { reimburseePersonId: true } });
  if (!expense) throw new ServiceError(404, "Expense not found");
  const personId = expense.reimburseePersonId;
  if (personId === null) return { link: null, reimbursee: null };
  const [link, name] = await Promise.all([
    db.expenseReimburseeVendor.findFirst({ where: { orgId, reimburseePersonId: personId } }),
    getExpenseRuntime().people.nameOf(personId),
  ]);
  return { link, reimbursee: { personId, name } };
}

async function openQuickBooks(): Promise<QbVendorClient> {
  const qb = await getExpenseRuntime().quickbooks.vendors.open();
  if (!qb) throw new ServiceError(503, QB_OFF);
  return qb;
}

/** QuickBooks Vendors matching the text, minus any already linked to someone. */
export async function vendorOptions(orgId: string, expenseId: string, text: string, principal: ExpensePrincipal): Promise<QbVendorOption[]> {
  await assertOrg(orgId);
  if (!principal.isFinance) throw new ServiceError(403, "Only FINANCE searches QuickBooks Vendors");
  if (!(await db.expense.findFirst({ where: { id: expenseId, orgId }, select: { id: true } }))) throw new ServiceError(404, "Expense not found");
  const found = await (await openQuickBooks()).search(text);
  const taken = await db.expenseReimburseeVendor.findMany({ where: { orgId, qbVendorId: { in: found.map((v) => v.id) } }, select: { qbVendorId: true } });
  const takenIds = new Set(taken.map((t) => t.qbVendorId));
  return found.filter((v) => !takenIds.has(v.id));
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
 * Links the expense's reimbursee to a QuickBooks Vendor: one picked by id, which QuickBooks must
 * know, or one created under the name on the reimbursee's Person record, never free text. A create
 * that finds an unlinked Vendor already holding that name links nothing: finance picks it instead. The setter may not be the submitter, the reimbursee, or in either one's
 * household, nor land on a Vendor already linked to their own household; each such refusal is
 * audited on the expense. Expenses of the reimbursee parked for want of a Vendor go back to the
 * outbox.
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
  if ((await conflictedParties(expense)).includes(actor.userId)) {
    await refuse("You cannot link a Vendor on an expense that you or your household submitted or would be reimbursed for");
  }

  const qb = await openQuickBooks();
  let vendor: QbVendorOption | null;
  let foundByName = false;
  if ("createForReimbursee" in choice) {
    const name = await getExpenseRuntime().people.nameOf(personId);
    if (!name?.trim()) throw new ServiceError(409, "The reimbursee has no name to give a new Vendor");
    const result = await qb.findOrCreate(name, `reimbursee-vendor-${orgId}-${personId}`);
    vendor = result;
    foundByName = !result.created;
  } else {
    vendor = await qb.byId(choice.qbVendorId);
    if (!vendor) throw new ServiceError(404, "QuickBooks has no Vendor with that id");
  }
  const { id: qbVendorId, displayName } = vendor;

  const holder = await db.expenseReimburseeVendor.findFirst({ where: { orgId, qbVendorId } });
  if (holder) {
    if (await sameHousehold(holder.reimburseePersonId, actor.userId)) await refuse("That QuickBooks Vendor is linked to you or your household");
    throw new ServiceError(409, "That QuickBooks Vendor is already linked to another person");
  }
  // A same-name Vendor may be someone else; finance confirms it through a pick instead.
  if (foundByName) {
    throw new ServiceError(409, `QuickBooks already has a Vendor named "${displayName}" (#${qbVendorId}); pick it from the search to confirm it is this person`);
  }

  return db
    .$transaction(async (tx) => {
      const row = await tx.expenseReimburseeVendor.create({ data: { orgId, reimburseePersonId: personId, qbVendorId } });
      await writeAudit(tx, actor, {
        expenseId,
        action: "reimbursee_vendor_set",
        fieldChanged: "qbVendorId",
        valueAfter: qbVendorId,
        notes: `QuickBooks Vendor "${displayName}"`,
      });
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
