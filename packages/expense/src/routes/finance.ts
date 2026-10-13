/**
 * FINANCE and Board surfaces: holds, account mapping, QuickBooks accounts, bucket ownership,
 * ledgers, settings, flags, the capital seed and QuickBooks matching. The registry gates each
 * route; every service that changes data checks FINANCE again.
 */
import { z } from "zod";
import { db } from "../db";
import type { ExpenseRouteHandler } from "../contract";
import { getExpenseRuntime, getOrgId, getPrincipal } from "../runtime";
import { createPartOwnerRepository } from "../repositories/partOwner";
import { writeOrgAudit } from "../lib/audit";
import { actorOf } from "../lib/caller";
import { requireFinance } from "../services/approvalService";
import { CapitalSeedSchema, seedCapitalAssets } from "../services/capitalService";
import { checkOffFlag, listOpenFlags } from "../services/flagService";
import { resubmitHeldExpense, setHeldLineAccount } from "../services/holdService";
import { excludeQbTxn, matchLineToQb, qbCandidates } from "../services/qbMatchService";
import { getExpenseSettings, updateExpenseSettings } from "../services/settingsService";
import { httpError, mapServiceErrors, pageArgs, parseBody, parseId, query } from "./_shared";

/** Runs `fn` for a FINANCE principal; the registry gate already admitted only FINANCE. */
async function asFinance() {
  const principal = await getPrincipal();
  await mapServiceErrors(async () => requireFinance(principal));
  return principal;
}

// ── Holds ─────────────────────────────────────────────────────────────────────

export const holds: ExpenseRouteHandler = async ({ req }) => ({
  ExpenseHold: await db.expenseHold.findMany({
    where: { orgId: await getOrgId(), status: "PENDING" },
    orderBy: [{ expenseId: "asc" }, { id: "asc" }],
    ...pageArgs(query(req)),
    include: { lineItem: true, expense: true },
  }),
});

export const holdLineAccount: ExpenseRouteHandler = async ({ req, params }) => {
  const lineItemId = parseId(params.lineItemId, "lineItemId");
  const { qbAccount } = await parseBody(req, z.object({ qbAccount: z.string().trim().min(1, "qbAccount is required") }));
  const principal = await getPrincipal();
  await mapServiceErrors(() => setHeldLineAccount(principal, params.expenseId, lineItemId, qbAccount));
  return { ExpenseLineItem: await db.expenseLineItem.findFirst({ where: { id: lineItemId } }) };
};

export const holdResubmit: ExpenseRouteHandler = async ({ params }) => {
  const principal = await getPrincipal();
  await mapServiceErrors(() => resubmitHeldExpense(principal, params.expenseId));
  return { Expense: await db.expense.findFirst({ where: { id: params.expenseId } }) };
};

// ── Account mapping + QuickBooks accounts ─────────────────────────────────────

const triBool = z.boolean().nullable();
const mappingSchema = z.object({
  category: z.string().min(1),
  subcategory: z.string().min(1),
  partNumber: z.string().min(1),
  isDelayed: triBool,
  isCapital: triBool,
  qbAccount: z.string().min(1),
});
const qbAccountSchema = z.object({ name: z.string().trim().min(1), qbAccount: z.string().trim().min(1) });

export const accountMappings: ExpenseRouteHandler = async ({ req }) => ({
  AccountMapping: await db.accountMapping.findMany({ where: { orgId: await getOrgId() }, orderBy: { id: "asc" }, ...pageArgs(query(req)) }),
});

export const createAccountMapping: ExpenseRouteHandler = async ({ req }) => {
  const data = await parseBody(req, mappingSchema);
  const actor = actorOf(await asFinance());
  const orgId = await getOrgId();
  return {
    AccountMapping: await db.$transaction(async (tx) => {
      const row = await tx.accountMapping.create({ data: { orgId, ...data } });
      await writeOrgAudit(tx, orgId, actor, { entityType: "account_mapping", entityId: row.id, action: "created", after: row });
      return row;
    }),
  };
};

async function ownedRow<T>(find: () => Promise<T | null>): Promise<T> {
  const row = await find();
  if (!row) throw httpError(404, "Not found");
  return row;
}

export const updateAccountMapping: ExpenseRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const data = await parseBody(req, mappingSchema);
  const actor = actorOf(await asFinance());
  const orgId = await getOrgId();
  const before = await ownedRow(() => db.accountMapping.findFirst({ where: { id, orgId } }));
  return {
    AccountMapping: await db.$transaction(async (tx) => {
      const row = await tx.accountMapping.update({ where: { id }, data });
      await writeOrgAudit(tx, orgId, actor, { entityType: "account_mapping", entityId: id, action: "updated", before, after: row });
      return row;
    }),
  };
};

export const deleteAccountMapping: ExpenseRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const actor = actorOf(await asFinance());
  const orgId = await getOrgId();
  const before = await ownedRow(() => db.accountMapping.findFirst({ where: { id, orgId } }));
  await db.$transaction(async (tx) => {
    await tx.accountMapping.delete({ where: { id } });
    await writeOrgAudit(tx, orgId, actor, { entityType: "account_mapping", entityId: id, action: "deleted", before });
  });
  return {};
};

/** Catalog category and subcategory names, through the CatalogReader port (empty until bound). */
export const mappingCatalog: ExpenseRouteHandler = async () => {
  const catalog = getExpenseRuntime().catalog;
  const [categories, subcategories] = await Promise.all([catalog.listCategories(), catalog.listSubcategories()]);
  return { Category: categories, Subcategory: subcategories };
};

export const qbAccounts: ExpenseRouteHandler = async () => ({
  ExpenseQbAccount: await db.expenseQbAccount.findMany({ where: { orgId: await getOrgId() }, orderBy: { name: "asc" } }),
});

export const createQbAccount: ExpenseRouteHandler = async ({ req }) => {
  const data = await parseBody(req, qbAccountSchema);
  const actor = actorOf(await asFinance());
  const orgId = await getOrgId();
  return {
    ExpenseQbAccount: await db.$transaction(async (tx) => {
      const row = await tx.expenseQbAccount.create({ data: { orgId, ...data } });
      await writeOrgAudit(tx, orgId, actor, { entityType: "qb_account", entityId: row.id, action: "created", after: row });
      return row;
    }),
  };
};

export const updateQbAccount: ExpenseRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const data = await parseBody(req, qbAccountSchema);
  const actor = actorOf(await asFinance());
  const orgId = await getOrgId();
  const before = await ownedRow(() => db.expenseQbAccount.findFirst({ where: { id, orgId } }));
  return {
    ExpenseQbAccount: await db.$transaction(async (tx) => {
      const row = await tx.expenseQbAccount.update({ where: { id }, data });
      await writeOrgAudit(tx, orgId, actor, { entityType: "qb_account", entityId: id, action: "updated", before, after: row });
      return row;
    }),
  };
};

export const deleteQbAccount: ExpenseRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const actor = actorOf(await asFinance());
  const orgId = await getOrgId();
  const before = await db.expenseQbAccount.findFirst({ where: { id, orgId } });
  if (before) {
    await db.$transaction(async (tx) => {
      await tx.expenseQbAccount.delete({ where: { id } });
      await writeOrgAudit(tx, orgId, actor, { entityType: "qb_account", entityId: id, action: "deleted", before });
    });
  }
  return {};
};

// ── Buckets and part ownership ────────────────────────────────────────────────

const buckets = () => getExpenseRuntime().budgetOwners.list();

export const localOwners: ExpenseRouteHandler = async () => ({ ExpenseBucketView: await buckets() });

export const ownershipMap: ExpenseRouteHandler = async ({ req }) => ({
  PartOwnerMap: await db.partOwnerMap.findMany({ where: { orgId: await getOrgId() }, orderBy: { gtin13: "asc" }, ...pageArgs(query(req)) }),
  ExpenseBucketView: await buckets(),
});

export const setOwnership: ExpenseRouteHandler = async ({ req }) => {
  const { gtin13, ownerId } = await parseBody(
    req,
    z.object({ gtin13: z.string().regex(/^\d{13}$/, "gtin13 must be 13 digits"), ownerId: z.number().int().positive() }),
  );
  const actor = actorOf(await asFinance());
  if (!(await buckets()).some((b) => b.id === ownerId && !b.archivedAt)) throw httpError(400, "Unknown or archived bucket");
  const orgId = await getOrgId();
  await db.$transaction(async (tx) => {
    const before = await tx.partOwnerMap.findFirst({ where: { orgId, gtin13 }, select: { ownerId: true } });
    await createPartOwnerRepository(tx).updateItemOwner(orgId, gtin13, ownerId);
    await writeOrgAudit(tx, orgId, actor, { entityType: "part_owner", entityId: gtin13, action: "owner_set", before, after: { ownerId } });
  });
  return { PartOwnerMap: await db.partOwnerMap.findFirst({ where: { orgId, gtin13 } }) };
};

export const provisionalItems: ExpenseRouteHandler = async ({ req }) => {
  const orgId = await getOrgId();
  const items = await db.provisionalItemMap.findMany({
    where: { orgId },
    orderBy: [{ proposedAt: "desc" }, { id: "desc" }],
    ...pageArgs(query(req)),
  });
  return {
    ProvisionalItemMap: items,
    PartOwnerMap: await db.partOwnerMap.findMany({ where: { orgId, gtin13: { in: items.map((i) => i.provisionalGtin13) } } }),
    ExpenseBucketView: await buckets(),
  };
};

// ── Ledgers ───────────────────────────────────────────────────────────────────

export const expenseEvents: ExpenseRouteHandler = async ({ req }) => {
  const orgId = await getOrgId();
  const events = await db.expenseEvent.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, ...pageArgs(query(req)) });
  const Expense = await db.expense.findMany({
    where: { orgId, id: { in: [...new Set(events.map((e) => e.expenseId))] } },
    select: { id: true, vendorName: true, receiptDate: true, receiptTotalCents: true, currency: true, state: true },
  });
  return { ExpenseEvent: events, Expense };
};

export const expenseEventsCount: ExpenseRouteHandler = async () => ({
  ExpenseListCount: { total: await db.expenseEvent.count({ where: { orgId: await getOrgId() } }) },
});

export const receivedPayloads: ExpenseRouteHandler = async ({ req }) => ({
  ReceivedExpensePayload: await db.receivedExpensePayload.findMany({
    where: { orgId: await getOrgId() },
    orderBy: { receivedAt: "desc" },
    ...pageArgs(query(req)),
  }),
});

export const qbExclusions: ExpenseRouteHandler = async ({ req }) => ({
  ExpenseQbMatchExclusion: await db.expenseQbMatchExclusion.findMany({
    where: { orgId: await getOrgId() },
    orderBy: [{ excludedAt: "desc" }, { id: "desc" }],
    ...pageArgs(query(req)),
  }),
});

export const createQbExclusion: ExpenseRouteHandler = async ({ req }) => {
  const { qbTxnId, reason } = await parseBody(req, z.object({ qbTxnId: z.string().trim().min(1), reason: z.string() }));
  const principal = await getPrincipal();
  await mapServiceErrors(() => excludeQbTxn(principal, qbTxnId, reason));
  return { ExpenseQbMatchExclusion: await db.expenseQbMatchExclusion.findFirst({ where: { orgId: await getOrgId(), qbTxnId } }) };
};

// ── Settings and flags ────────────────────────────────────────────────────────

export const settings: ExpenseRouteHandler = async () => {
  const orgId = await getOrgId();
  return { ExpenseOrgSettings: { orgId, ...(await getExpenseSettings(orgId)) } };
};

export const updateSettings: ExpenseRouteHandler = async ({ req }) => {
  const patch = await parseBody(req, z.unknown());
  const principal = await getPrincipal();
  const orgId = await getOrgId();
  const next = await mapServiceErrors(() => updateExpenseSettings(orgId, patch, principal));
  return { ExpenseOrgSettings: { orgId, ...next } };
};

export const flags: ExpenseRouteHandler = async () => ({ ExpenseFlag: await listOpenFlags(await getPrincipal()) });

export const checkOff: ExpenseRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { notes } = await parseBody(req, z.object({ notes: z.string().nullish() }));
  const principal = await getPrincipal();
  await mapServiceErrors(() => checkOffFlag(principal, id, notes?.trim() || null));
  return { ExpenseFlag: await db.expenseFlag.findFirst({ where: { id } }) };
};

// ── Capital seed + QuickBooks matching ────────────────────────────────────────

export const capitalSeed: ExpenseRouteHandler = async ({ req }) => {
  const rows = await parseBody(req, CapitalSeedSchema);
  const principal = await getPrincipal();
  return { ExpenseCapitalSeedResult: await mapServiceErrors(() => seedCapitalAssets(principal, rows)) };
};

export const candidates: ExpenseRouteHandler = async ({ params }) => {
  const lineItemId = parseId(params.lineItemId, "lineItemId");
  const principal = await getPrincipal();
  return { ExpenseQbCandidateView: await mapServiceErrors(() => qbCandidates(principal, lineItemId)) };
};

export const match: ExpenseRouteHandler = async ({ req, params }) => {
  const lineItemId = parseId(params.lineItemId, "lineItemId");
  const { qbTxnId } = await parseBody(req, z.object({ qbTxnId: z.string().trim().min(1) }));
  const principal = await getPrincipal();
  await mapServiceErrors(() => matchLineToQb(principal, lineItemId, qbTxnId));
  return { ExpenseLineItem: await db.expenseLineItem.findFirst({ where: { id: lineItemId } }) };
};

/** Creating in QuickBooks is QB-2's writer; until it is bound, the route refuses and writes nothing. */
export const create: ExpenseRouteHandler = async ({ params }) => {
  parseId(params.lineItemId, "lineItemId");
  await asFinance();
  throw httpError(503, "QuickBooks writes are not enabled yet");
};
