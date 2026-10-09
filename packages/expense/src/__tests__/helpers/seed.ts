import { randomUUID } from "node:crypto";
import { db } from "../../db";
import { configureExpense } from "../../runtime";
import type { ExpensePrincipal, SignoffDirectory } from "../../contract";

export const ORG = "org-1";

export async function seedOrgSettings(opts?: {
  orgId?: string;
  capitalTotalThresholdCents?: number;
  capitalLineItemThresholdCents?: number;
}): Promise<void> {
  await db.expenseOrgSettings.create({
    data: {
      orgId: opts?.orgId ?? ORG,
      capitalTotalThresholdCents: opts?.capitalTotalThresholdCents ?? 5000,
      capitalLineItemThresholdCents: opts?.capitalLineItemThresholdCents ?? 2500,
    },
  });
}

export async function seedExpense(opts?: {
  id?: string;
  orgId?: string;
  state?: string;
  taxCents?: number;
  shippingCents?: number;
  discountCents?: number;
  receiptTotalCents?: number;
  vendorName?: string;
  submitterId?: number;
  needsReimbursement?: boolean;
  backfill?: boolean;
  noteInLieuOfReceipt?: boolean;
  reimburseePersonId?: number;
}): Promise<string> {
  const id = opts?.id ?? randomUUID();
  await db.expense.create({
    data: {
      id,
      orgId: opts?.orgId ?? ORG,
      submitterId: opts?.submitterId ?? 1,
      needsReimbursement: opts?.needsReimbursement ?? false,
      backfill: opts?.backfill ?? false,
      noteInLieuOfReceipt: opts?.noteInLieuOfReceipt ?? false,
      reimburseePersonId: opts?.reimburseePersonId ?? null,
      vendorName: opts?.vendorName ?? "Acme",
      currency: "USD",
      taxCents: opts?.taxCents ?? 0,
      shippingCents: opts?.shippingCents ?? 0,
      discountCents: opts?.discountCents ?? 0,
      receiptTotalCents: opts?.receiptTotalCents ?? 100,
      submittedAt: new Date(),
      state: opts?.state ?? "pending",
    },
  });
  return id;
}

export async function seedLineItem(
  expenseId: string,
  opts?: {
    description?: string;
    partNumber?: string | null;
    gtin13?: string | null;
    quantity?: number;
    unitPriceCents?: number;
    totalPriceCents?: number;
    isCapital?: boolean;
    isDelayed?: boolean;
    manualQbAccount?: string | null;
  },
): Promise<number> {
  const row = await db.expenseLineItem.create({
    data: {
      expenseId,
      receiptLineItemId: 1,
      lineNumber: 1,
      description: opts?.description ?? "Widget",
      partNumber: opts?.partNumber ?? null,
      gtin13: opts?.gtin13 ?? null,
      quantity: opts?.quantity ?? 1,
      unitPriceCents: opts?.unitPriceCents ?? 100,
      totalPriceCents: opts?.totalPriceCents ?? 100,
      isCapital: opts?.isCapital ?? false,
      isDelayed: opts?.isDelayed ?? false,
      manualQbAccount: opts?.manualQbAccount ?? null,
    },
  });
  return row.id;
}

export async function seedApproval(
  expenseId: string,
  lineItemId: number,
  opts?: { ownerId?: number | null; status?: string },
): Promise<number> {
  const row = await db.lineItemOwnerApproval.create({
    data: {
      expenseId,
      lineItemId,
      ownerId: opts?.ownerId ?? null,
      status: opts?.status ?? "pending",
    },
  });
  return row.id;
}

export async function seedAccountMapping(opts: {
  orgId?: string;
  category?: string;
  subcategory?: string;
  partNumber?: string;
  isDelayed?: boolean | null;
  isCapital?: boolean | null;
  qbAccount: string;
}): Promise<void> {
  await db.accountMapping.create({
    data: {
      orgId: opts.orgId ?? ORG,
      category: opts.category ?? "*",
      subcategory: opts.subcategory ?? "*",
      partNumber: opts.partNumber ?? "*",
      isDelayed: opts.isDelayed ?? null,
      isCapital: opts.isCapital ?? null,
      qbAccount: opts.qbAccount,
    },
  });
}

export async function seedPartOwner(opts: {
  orgId?: string;
  gtin13: string;
  ownerId: number;
}): Promise<void> {
  await db.partOwnerMap.create({
    data: {
      orgId: opts.orgId ?? ORG,
      gtin13: opts.gtin13,
      ownerId: opts.ownerId,
    },
  });
}

/** Fills the three base sign-off seats on every line of an expense with distinct people. */
export async function signAllLines(expenseId: string): Promise<void> {
  const lines = await db.expenseLineItem.findMany({ where: { expenseId }, select: { id: true } });
  for (const { id } of lines) {
    await db.expenseLineSignoff.createMany({
      data: (["SUBMITTER", "PROGRAM_APPROVER", "TREASURER"] as const).map((seat, i) => ({
        expenseId, lineItemId: id, seat, signerUserId: 9000 + i,
      })),
    });
  }
}

export function principal(id: number, roles: { isFinance?: boolean; isBoard?: boolean } = {}): ExpensePrincipal {
  return { id, name: `person-${id}`, isFinance: roles.isFinance ?? false, isBoard: roles.isBoard ?? false };
}

/** Rebinds the runtime with test ports (org stays ORG). */
export function bindPorts(ports: Omit<Parameters<typeof configureExpense>[0], "org">): void {
  configureExpense({ org: () => ({ id: ORG, name: "Org One" }), ...ports });
}

/** A directory from plain lists; bucket 100+ is program-level with the given approvers; each `households` entry is one household. */
export function directory(d: {
  approvers?: Record<number, number[]>;
  orgLevel?: number[];
  finance?: number[];
  board?: number[];
  households?: number[][];
  nonMembers?: number[];
  unknownPeople?: number[];
}): SignoffDirectory {
  return {
    bucketApprovers: async (b) => ({ orgLevel: (d.orgLevel ?? []).includes(b), approvers: d.approvers?.[b] ?? [] }),
    financeHolders: async () => d.finance ?? [],
    boardMembers: async () => d.board ?? [],
    householdOf: async (ids) => (d.households ?? []).filter((h) => h.some((id) => ids.includes(id))).flat(),
    personExists: async (id) => !(d.unknownPeople ?? []).includes(id),
    isOrgMember: async (id) => !(d.nonMembers ?? []).includes(id),
  };
}

/** A catalog where every listed line resolves to Hardware/Cables. */
export function catalogResolving(gtinByItemId: Record<number, string>) {
  return {
    listCategories: async () => [{ id: 1, name: "Hardware", letter: "H" }],
    listSubcategories: async () => [{ id: 10, name: "Cables", number: 1, categoryId: 1 }],
    lookupItems: async () => Object.entries(gtinByItemId).map(([id, gtin13]) => ({ index: Number(id), gtin13, conversionVersion: 1 })),
    getItem: async (gtin13: string) =>
      Object.values(gtinByItemId).includes(gtin13) ? { gtin13, categoryId: 1, subcategoryId: 10 } : null,
  };
}
