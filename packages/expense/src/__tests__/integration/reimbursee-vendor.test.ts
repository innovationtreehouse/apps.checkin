/** FINANCE's reimbursee → QuickBooks Vendor link against the real database. */
import { it, expect, vi } from "vitest";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, directory, principal, seedExpense, ORG } from "../helpers/seed";
import { linkReimburseeVendor, reimburseeVendorFor, reimburseeVendorId, vendorOptions } from "../../services/reimburseeVendorService";
import { QB_OFF } from "../../lib/expense-constants";
import type { QbVendorClient } from "../../contract";

// finance 3 · finance 4 shares a household with reimbursee 7 · 9 is another reimbursee
// · every expense is submitted by 1, who shares a household with 6 · person 10 is named "Kin", 11 has no name, 12 is named "Pat Lee"
const FINANCE = principal(3, { isFinance: true });
const KIN = principal(4, { isFinance: true });

describeDb("reimbursee QuickBooks Vendor", () => {
  /** A QuickBooks with Vendors 55 "Pat Lee", 56 "Pat Lane" and 70 "Kin"; a create gets id 61. Off when `off`. */
  function bind(opts: { off?: boolean } = {}) {
    const vendors = new Map([["55", "Pat Lee"], ["56", "Pat Lane"], ["70", "Kin"]]);
    const option = (id: string) => ({ id, displayName: vendors.get(id)! });
    const qb: QbVendorClient = {
      search: async (text) => [...vendors.keys()].filter((id) => vendors.get(id)!.includes(text)).map(option),
      byId: async (id) => (vendors.has(id) ? option(id) : null),
      findOrCreate: vi.fn(async (name: string) => {
        const found = [...vendors.keys()].find((id) => vendors.get(id) === name);
        if (found) return { ...option(found), created: false };
        vendors.set("61", name);
        return { ...option("61"), created: true };
      }),
    };
    bindPorts({
      signoff: directory({ finance: [3, 4], households: [[4, 7], [1, 6]] }),
      people: { nameOf: async (id) => ({ 9: "Ann Ray", 10: "Kin", 12: "Pat Lee" } as Record<number, string>)[id] ?? null },
      quickbooks: { vendors: { open: async () => (opts.off ? null : qb) } },
    });
    return qb;
  }
  const reimbursement = (personId: number | undefined, extra: { qbMatchState?: string } = {}) =>
    seedExpense({ needsReimbursement: true, reimburseePersonId: personId }).then(async (id) => {
      if (extra.qbMatchState) await db.expense.update({ where: { id }, data: { qbMatchState: extra.qbMatchState } });
      return id;
    });
  const refusals = (id: string) => db.expenseAuditLog.findMany({ where: { expenseId: id, action: "reimbursee_vendor_refused" } });

  it("links a Vendor QuickBooks knows, audits it, and re-arms the reimbursee's parked reimbursements", async () => {
    bind();
    const id = await reimbursement(9);
    const parked = await reimbursement(9, { qbMatchState: "AMBIGUOUS" });
    const other = await reimbursement(7, { qbMatchState: "AMBIGUOUS" });
    expect(await reimburseeVendorFor(ORG, id)).toEqual({ link: null, reimbursee: { personId: 9, name: "Ann Ray" } });

    await expect(linkReimburseeVendor(ORG, id, { qbVendorId: "55" }, FINANCE)).resolves.toMatchObject({ reimburseePersonId: 9, qbVendorId: "55" });

    expect(await reimburseeVendorId(9)).toBe("55");
    expect((await reimburseeVendorFor(ORG, id)).link).toMatchObject({ qbVendorId: "55" });
    expect(await db.expenseAuditLog.findFirst({ where: { expenseId: id, action: "reimbursee_vendor_set" } })).toMatchObject({
      userId: 3,
      valueAfter: "55",
      notes: 'QuickBooks Vendor "Pat Lee"',
    });
    expect((await db.expense.findUnique({ where: { id: parked } }))!.qbMatchState).toBe("UNMATCHED");
    expect((await db.expense.findUnique({ where: { id: other } }))!.qbMatchState).toBe("AMBIGUOUS");
  });

  it("refuses an id QuickBooks does not know", async () => {
    bind();
    await expect(linkReimburseeVendor(ORG, await reimbursement(9), { qbVendorId: "99" }, FINANCE)).rejects.toMatchObject({ statusCode: 404 });
    expect(await db.expenseReimburseeVendor.count()).toBe(0);
  });

  it("searches Vendors by name, leaving out any already linked", async () => {
    bind();
    const id = await reimbursement(9);
    expect((await vendorOptions(ORG, id, "Pat", FINANCE)).map((v) => v.id)).toEqual(["55", "56"]);
    await linkReimburseeVendor(ORG, await reimbursement(7), { qbVendorId: "56" }, FINANCE);
    expect(await vendorOptions(ORG, id, "Pat", FINANCE)).toEqual([{ id: "55", displayName: "Pat Lee" }]);
    await expect(vendorOptions(ORG, id, "Pat", principal(5, { isBoard: true }))).rejects.toMatchObject({ statusCode: 403 });
  });

  it("creates the Vendor under the name on the reimbursee's Person record", async () => {
    const qb = bind();
    const id = await reimbursement(9);
    await linkReimburseeVendor(ORG, id, { createForReimbursee: true }, FINANCE);
    expect(qb.findOrCreate).toHaveBeenCalledWith("Ann Ray", `reimbursee-vendor-${ORG}-9`);
    expect(await reimburseeVendorId(9)).toBe("61");
    expect((await db.expenseAuditLog.findFirst({ where: { expenseId: id, action: "reimbursee_vendor_set" } }))!.notes).toBe('QuickBooks Vendor "Ann Ray"');
  });

  it("links nothing when a create finds an unlinked Vendor already holding the reimbursee's name", async () => {
    bind();
    const id = await reimbursement(12);
    await expect(linkReimburseeVendor(ORG, id, { createForReimbursee: true }, FINANCE)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("#55"),
    });
    expect(await reimburseeVendorId(12)).toBeNull();
    await linkReimburseeVendor(ORG, id, { qbVendorId: "55" }, FINANCE);
    expect(await reimburseeVendorId(12)).toBe("55");
  });

  it("creates nothing for a reimbursee with no recorded name", async () => {
    const qb = bind();
    await expect(linkReimburseeVendor(ORG, await reimbursement(11), { createForReimbursee: true }, FINANCE)).rejects.toMatchObject({ statusCode: 409 });
    expect(qb.findOrCreate).not.toHaveBeenCalled();
  });

  it("with QuickBooks off, nothing can be searched or linked", async () => {
    bind({ off: true });
    const id = await reimbursement(9);
    await expect(vendorOptions(ORG, id, "Pat", FINANCE)).rejects.toMatchObject({ statusCode: 503, message: QB_OFF });
    await expect(linkReimburseeVendor(ORG, id, { createForReimbursee: true }, FINANCE)).rejects.toMatchObject({ statusCode: 503, message: QB_OFF });
    await expect(linkReimburseeVendor(ORG, id, { qbVendorId: "55" }, FINANCE)).rejects.toMatchObject({ statusCode: 503, message: QB_OFF });
    expect(await db.expenseReimburseeVendor.count()).toBe(0);
  });

  it("refuses a finance member linking a reimbursee in their own household, with an audit row and no link", async () => {
    bind();
    const id = await reimbursement(7);
    await expect(linkReimburseeVendor(ORG, id, { qbVendorId: "55" }, KIN)).rejects.toMatchObject({ statusCode: 403 });
    expect(await refusals(id)).toHaveLength(1);
    expect(await db.expenseReimburseeVendor.count()).toBe(0);
  });

  it("refuses the submitter and the submitter's household, with an audit row each", async () => {
    bind();
    const id = await reimbursement(9);
    for (const p of [principal(1, { isFinance: true }), principal(6, { isFinance: true })]) {
      await expect(linkReimburseeVendor(ORG, id, { qbVendorId: "55" }, p)).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(await refusals(id)).toHaveLength(2);
    expect(await db.expenseReimburseeVendor.count()).toBe(0);
  });

  it("refuses a name lookup that lands on a Vendor already linked to the setter's household", async () => {
    bind();
    await linkReimburseeVendor(ORG, await reimbursement(7), { qbVendorId: "70" }, FINANCE);
    const id = await reimbursement(10);

    await expect(linkReimburseeVendor(ORG, id, { createForReimbursee: true }, KIN)).rejects.toMatchObject({ statusCode: 403 });
    expect(await refusals(id)).toHaveLength(1);
    expect(await reimburseeVendorId(10)).toBeNull();
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
