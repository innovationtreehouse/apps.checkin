/**
 * Wire the expense library into checkin (#1272 §3/§6), called once at server boot from
 * instrumentation.ts. Binding touches no database: every port below reads lazily, inside a
 * request. Bound crossings: X3 (catalog reads), the S5 replay read (X2) and X12's QuickBooks
 * reads (bound on the receipt side). The QuickBooks reader and finance's reimbursee Vendor
 * search and create go through checkin's one guarded client (off = no rows, no Vendors).
 * The posting writer stays unbound (inert); it is a later crossing. Whatever the library sends
 * out goes through checkin's outbound gateway, which strips it to the surface's declared tiers.
 */
import { configureExpense, reimburseeVendorId } from "@checkin/expense";
import type { ExpensePrincipal, OwnerDirectory, PeopleDirectory, QbReader, QbTxn, QbVendors, SignoffDirectory } from "@checkin/expense";
import { dollarsToCents } from "@checkin/money";
import { createVendor, type QboBill, type QboPurchase, type QboVendor } from "@checkin/quickbooks";
import type { PersonRoleKind, Prisma } from "@/generated/prisma/client";
import { catalogEventsSince, getOrg, sessionUser } from "@/lib/catalog/configure";
import { catalogReader } from "@/lib/catalog/reader";
import { outboundCall } from "@/security/outbound";

async function db() {
  return (await import("@/lib/prisma")).default;
}

/** The signed-in person with their finance roles; null for any session checkin refuses. */
async function getPrincipal(): Promise<ExpensePrincipal | null> {
  const user = await sessionUser();
  if (!user) return null;
  return { id: user.id, name: user.name ?? null, isFinance: user.isFinance === true, isBoard: user.isBoardMember === true };
}

const budgetOwners: OwnerDirectory = {
  async list() {
    return (await db()).budgetOwner.findMany({ select: { id: true, name: true, archivedAt: true, quickBooksClassId: true }, orderBy: { name: "asc" } });
  },
};

async function eligibleSigner(): Promise<Prisma.PersonWhereInput> {
  return (await import("@/lib/finance/bucketApprovers")).eligibleSigner();
}

async function roleHolders(role: PersonRoleKind): Promise<number[]> {
  const rows = await (await db()).personRole.findMany({ where: { role, person: await eligibleSigner() }, select: { personId: true } });
  return rows.map((r) => r.personId);
}

/** A bucket's approvers are its owner and treasurers, set by the Board; an org-level bucket has none. */
export const signoff: SignoffDirectory = {
  async bucketApprovers(bucketId) {
    const { orgMembershipStatusBlocksLogin } = await import("@/lib/orgMembership");
    const bucket = await (await db()).budgetOwner.findUnique({
      where: { id: bucketId },
      select: {
        isOrgLevel: true,
        owner: { select: { id: true, mergedIntoId: true, household: { select: { orgMembership: { select: { status: true } } } } } },
        treasurers: { where: { person: await eligibleSigner() }, select: { personId: true } },
      },
    });
    if (!bucket) return { orgLevel: false, approvers: [], owner: null };
    if (bucket.isOrgLevel) return { orgLevel: true, approvers: [], owner: null };
    const owner = bucket.owner;
    const ownerEligible = owner && owner.mergedIntoId === null && !orgMembershipStatusBlocksLogin(owner.household?.orgMembership?.status);
    const approvers = [...(ownerEligible ? [owner.id] : []), ...bucket.treasurers.map((t) => t.personId)];
    return { orgLevel: false, approvers: [...new Set(approvers)], owner: owner ? (owner.mergedIntoId ?? owner.id) : null };
  },

  async bucketsApprovedBy(personId) {
    return (await import("@/lib/finance/bucketApprovers")).bucketsApprovedBy(personId);
  },

  financeHolders: () => roleHolders("FINANCE"),
  boardMembers: () => roleHolders("BOARD"),

  async householdOf(personIds) {
    if (personIds.length === 0) return [];
    const { LIVE_PERSON } = await import("@/lib/person/filters");
    // Live members of every household holding one of these people (a merged-away person's
    // household still counts, so a tombstone id never narrows the conflict set).
    const members = await (await db()).person.findMany({
      where: { household: { householdMembers: { some: { id: { in: personIds } } } }, ...LIVE_PERSON },
      select: { id: true },
    });
    return members.map((m) => m.id);
  },

  async personExists(personId) {
    const { LIVE_PERSON } = await import("@/lib/person/filters");
    return (await (await db()).person.count({ where: { id: personId, ...LIVE_PERSON } })) > 0;
  },

  async livePersonFor(personId) {
    const { resolveMergedPerson } = await import("@/lib/person/mergeChain");
    const resolved = await resolveMergedPerson(personId);
    return resolved.kind === "live" ? resolved.person.id : null;
  },

  async isOrgMember(personId) {
    const { isActiveOrgMember } = await import("@/lib/orgMembership");
    return isActiveOrgMember(personId);
  },

  async isAdult(personId) {
    const [{ isKnownAdult }, { LIVE_PERSON }] = await Promise.all([import("@/lib/programAge"), import("@/lib/person/filters")]);
    const person = await (await db()).person.findFirst({ where: { id: personId, ...LIVE_PERSON }, select: { dateOfBirth: true, isDeclaredAdult: true } });
    return person !== null && isKnownAdult(person);
  },
};

function qbTxn(t: QboPurchase | QboBill): QbTxn {
  return {
    id: t.Id,
    txnDate: t.TxnDate,
    totalCents: dollarsToCents(t.TotalAmt),
    accountRef: t.AccountRef?.value ?? null,
    vendorRef: (t.EntityRef ?? t.VendorRef)?.value ?? null,
  };
}

/** Loaded on first use, so binding at boot pulls in no AWS SDK. */
async function quickBooks() {
  return (await import("@/lib/quickbooks/client")).getQuickBooks();
}

const qbReader: QbReader = {
  async purchasesBetween(from, to) {
    const qb = await quickBooks();
    return qb ? (await qb.purchasesBetween(from, to)).map(qbTxn) : [];
  },
  async billsBetween(from, to) {
    const qb = await quickBooks();
    return qb ? (await qb.billsBetween(from, to)).map(qbTxn) : [];
  },
  async billPaymentsBetween(from, to) {
    const qb = await quickBooks();
    if (!qb) return [];
    return (await qb.billPaymentsBetween(from, to)).map((p) => ({
      id: p.Id,
      txnDate: p.TxnDate,
      billIds: [...new Set((p.Line ?? []).flatMap((l) => l.LinkedTxn ?? []).filter((t) => t.TxnType === "Bill").map((t) => t.TxnId))],
    }));
  },
  async purchasesByIds(ids) {
    const qb = await quickBooks();
    return qb ? (await qb.purchasesByIds(ids)).map(qbTxn) : [];
  },
  async billsByIds(ids) {
    const qb = await quickBooks();
    if (!qb) return [];
    return (await qb.billsByIds(ids)).map((b) => ({
      id: b.Id,
      txnDate: b.TxnDate,
      balance: b.Balance ?? null,
      paymentIds: [...new Set((b.LinkedTxn ?? []).filter((t) => t.TxnType === "BillPayment").map((t) => t.TxnId))],
    }));
  },
  async billPaymentsByIds(ids) {
    const qb = await quickBooks();
    return qb ? (await qb.billPaymentsByIds(ids)).map((p) => ({ id: p.Id, txnDate: p.TxnDate })) : [];
  },
};

/** Finance's Vendor search, verify and create, through the guarded client (off = null). */
const qbVendors: QbVendors = {
  async open() {
    const qb = await quickBooks();
    if (!qb) return null;
    const option = (v: QboVendor) => ({ id: v.Id, displayName: v.DisplayName });
    return {
      search: async (text) => (await qb.vendorsMatching(text)).map(option),
      byId: async (id) => {
        const v = await qb.vendorById(id);
        return v ? option(v) : null;
      },
      findOrCreate: async (name, key) => {
        const v = await createVendor(qb, name, key);
        return { id: v.id, displayName: v.displayName, created: v.kind === "created" };
      },
    };
  },
};

const people: PeopleDirectory = {
  async nameOf(personId) {
    const { LIVE_PERSON } = await import("@/lib/person/filters");
    const person = await (await db()).person.findFirst({ where: { id: personId, ...LIVE_PERSON }, select: { name: true } });
    return person?.name ?? null;
  },
};

/** What expense posting lacks, in plain words; the posting port is not bound here yet. */
export function expensePostingMissing(): string[] {
  return ["the posting writer, which this app does not bind yet"];
}

export function configureRuntime(): void {
  configureExpense({
    org: getOrg,
    auth: { getPrincipal },
    budgetOwners,
    signoff,
    catalog: catalogReader,
    catalogEvents: { eventsAfter: async (afterId) => catalogEventsSince((await getOrg()).id, afterId) },
    people,
    quickbooks: { reader: qbReader, refs: { paymentAccountId: async () => null, vendorIdFor: reimburseeVendorId }, vendors: qbVendors },
    outbound: outboundCall,
  });
}
