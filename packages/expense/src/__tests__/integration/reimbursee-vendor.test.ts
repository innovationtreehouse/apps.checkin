/** FINANCE's reimbursee → QuickBooks Vendor link against the real database. */
import { it, expect, vi } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedExpense, ORG } from "../helpers/seed";
import { linkReimburseeVendor, reimburseeVendorFor, reimburseeVendorId, QB_OFF } from "../../services/reimburseeVendorService";

// finance 3 · finance 4 shares a household with reimbursee 7 · 9 is another reimbursee
const FINANCE = principal(3, { isFinance: true });
const KIN = principal(4, { isFinance: true });

describeDb("reimbursee QuickBooks Vendor", () => {
  function bind(findOrCreate: (name: string, key: string) => Promise<{ id: string; displayName: string } | null> = async () => null) {
    const vendors = { findOrCreate: vi.fn(findOrCreate) };
    bindPorts({ signoff: directory({ finance: [3, 4], households: [[4, 7]] }), quickbooks: { vendors } });
    return vendors;
  }
  const reimbursement = (personId: number | undefined, extra: { qbMatchState?: string } = {}) =>
    seedExpense({ needsReimbursement: true, reimburseePersonId: personId }).then(async (id) => {
      if (extra.qbMatchState) await db.expense.update({ where: { id }, data: { qbMatchState: extra.qbMatchState } });
      return id;
    });
  const refusals = (id: string) => db.expenseAuditLog.findMany({ where: { expenseId: id, action: "reimbursee_vendor_refused" } });

  it("links a typed Vendor id, audits it, and re-arms the reimbursee's parked reimbursements", async () => {
    bind();
    const id = await reimbursement(9);
    const parked = await reimbursement(9, { qbMatchState: "AMBIGUOUS" });
    const other = await reimbursement(7, { qbMatchState: "AMBIGUOUS" });

    await expect(linkReimburseeVendor(ORG, id, { qbVendorId: "55" }, FINANCE)).resolves.toMatchObject({ reimburseePersonId: 9, qbVendorId: "55" });

    expect(await reimburseeVendorId(9)).toBe("55");
    expect(await reimburseeVendorFor(ORG, id)).toMatchObject({ qbVendorId: "55" });
    expect(await db.expenseAuditLog.findFirst({ where: { expenseId: id, action: "reimbursee_vendor_set" } })).toMatchObject({ userId: 3, valueAfter: "55" });
    expect((await db.expense.findUnique({ where: { id: parked } }))!.qbMatchState).toBe("UNMATCHED");
    expect((await db.expense.findUnique({ where: { id: other } }))!.qbMatchState).toBe("AMBIGUOUS");
  });

  it("finds or creates the Vendor by name through the QuickBooks port", async () => {
    const vendors = bind(async (name) => ({ id: "61", displayName: `${name} (Vendor)` }));
    const id = await reimbursement(9);
    await linkReimburseeVendor(ORG, id, { createName: "Pat Lee" }, FINANCE);
    expect(vendors.findOrCreate).toHaveBeenCalledWith("Pat Lee", `reimbursee-vendor-${ORG}-9`);
    expect(await reimburseeVendorId(9)).toBe("61");
  });

  it("with QuickBooks off, create is unavailable but a typed id still links", async () => {
    bind();
    const id = await reimbursement(9);
    await expect(linkReimburseeVendor(ORG, id, { createName: "Pat Lee" }, FINANCE)).rejects.toMatchObject({ statusCode: 503, message: QB_OFF });
    await linkReimburseeVendor(ORG, id, { qbVendorId: "55" }, FINANCE);
    expect(await reimburseeVendorId(9)).toBe("55");
  });

  it("refuses the setter's own household, with an audit row and no link", async () => {
    bind();
    const id = await reimbursement(7);
    await expect(linkReimburseeVendor(ORG, id, { qbVendorId: "55" }, KIN)).rejects.toMatchObject({ statusCode: 403 });
    expect(await refusals(id)).toHaveLength(1);
    expect(await db.expenseReimburseeVendor.count()).toBe(0);
  });

  it("refuses a name lookup that lands on a Vendor already linked to the setter's household", async () => {
    bind(async () => ({ id: "70", displayName: "Kin" }));
    await linkReimburseeVendor(ORG, await reimbursement(7), { qbVendorId: "70" }, FINANCE);
    const id = await reimbursement(9);

    await expect(linkReimburseeVendor(ORG, id, { createName: "Kin" }, KIN)).rejects.toMatchObject({ statusCode: 403 });
    expect(await refusals(id)).toHaveLength(1);
    expect(await reimburseeVendorId(9)).toBeNull();
  });

  it("one Vendor maps to one person, and a link is set once", async () => {
    bind();
    const first = await reimbursement(7);
    await linkReimburseeVendor(ORG, first, { qbVendorId: "55" }, FINANCE);
    await expect(linkReimburseeVendor(ORG, await reimbursement(9), { qbVendorId: "55" }, FINANCE)).rejects.toMatchObject({ statusCode: 409 });
    await expect(linkReimburseeVendor(ORG, first, { qbVendorId: "56" }, FINANCE)).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      db.expenseReimburseeVendor.create({ data: { orgId: ORG, reimburseePersonId: 9, qbVendorId: "55" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("only FINANCE links, only once the reimbursee is known", async () => {
    bind();
    await expect(linkReimburseeVendor(ORG, await reimbursement(9), { qbVendorId: "55" }, principal(5, { isBoard: true }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(linkReimburseeVendor(ORG, await reimbursement(undefined), { qbVendorId: "55" }, FINANCE)).rejects.toMatchObject({ statusCode: 409 });
    await expect(linkReimburseeVendor(ORG, await seedExpense(), { qbVendorId: "55" }, FINANCE)).rejects.toMatchObject({ statusCode: 400 });
    expect(await db.expenseReimburseeVendor.count()).toBe(0);
  });
});
