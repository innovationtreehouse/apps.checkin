/**
 * Wire the expense library into checkin, called once at server boot from
 * instrumentation.ts. Binding touches no database: every port below reads lazily, inside a
 * request. Bound crossings: catalog reads, the org-event replay read and the reimbursement
 * status QuickBooks reads (bound on the receipt side). The QuickBooks reader and finance's reimbursee Vendor
 * search and create go through checkin's one guarded client (off = the reader throws, no Vendors).
 * The posting writer resolves per run: the guarded client and the books map's EXPENSE_PAYMENT
 * account, which finance also reads matches against. With either missing, or an account that is
 * neither a bank nor a credit card (finance is emailed), a drain answers "unbound". A daily sweep that
 * could not read every entry emails finance. Whatever the library sends out goes through checkin's outbound gateway, which
 * strips it to the surface's declared tiers. An expense closed with a rejected line, or a reimbursement sent to
 * the books, is emailed to the receipt's uploader and the person reimbursed (purchaseOutcomeMail.ts).
 */
import { configureExpense, QuickBooksNotConnectedError, reimburseeVendorId } from "@checkin/expense";
import type { ExpensePosting, OutcomeMail, PeopleDirectory, QbReader, QbTxn, QbVendors, SignoffDirectory } from "@checkin/expense";
import { dollarsToCents } from "@checkin/money";
import { createVendor, type QboBill, type QboPurchase, type QboVendor } from "@checkin/quickbooks";
import type { PersonRoleKind, Prisma } from "@/generated/prisma/client";
import { catalogEventsSince, getOrg } from "@/lib/components/host";
import { orgEventAlerts } from "@/lib/components/orgEventAlerts";
import { budgetOwners, householdIds, householdOf, householdsOf } from "@/lib/components/ports";
import { catalogReader } from "@/lib/catalog/reader";
import { BOOKS_MAP_ROLE_LABELS } from "@/lib/finance/booksMapLabels";
import { getQuickBooks } from "@/lib/quickbooks/client";
import { outboundCall } from "@/security/outbound";

async function db() {
  return (await import("@/lib/prisma")).default;
}

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

  householdOf,
  householdsOf,
  householdIds,

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

  async searchAdults(query, limit) {
    const [{ isKnownAdult }, { LIVE_PERSON }] = await Promise.all([import("@/lib/programAge"), import("@/lib/person/filters")]);
    const matches = await (await db()).person.findMany({
      where: { ...LIVE_PERSON, name: { contains: query, mode: "insensitive" } },
      select: { id: true, name: true, dateOfBirth: true, isDeclaredAdult: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return matches.filter(isKnownAdult).slice(0, limit).map(({ id, name }) => ({ personId: id, name }));
  },

  async addNonMemberAdult(name) {
    const { addNonMemberAdult } = await import("@/lib/person/ownHousehold");
    return (await addNonMemberAdult(await db(), name)).id;
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

async function connectedQb() {
  const qb = await getQuickBooks();
  if (!qb) throw new QuickBooksNotConnectedError();
  return qb;
}

const qbReader: QbReader = {
  async purchasesBetween(from, to) {
    return (await (await connectedQb()).purchasesBetween(from, to)).map(qbTxn);
  },
  async billsBetween(from, to) {
    return (await (await connectedQb()).billsBetween(from, to)).map(qbTxn);
  },
  async billPaymentsBetween(from, to) {
    return (await (await connectedQb()).billPaymentsBetween(from, to)).map((p) => ({
      id: p.Id,
      txnDate: p.TxnDate,
      billIds: [...new Set((p.Line ?? []).flatMap((l) => l.LinkedTxn ?? []).filter((t) => t.TxnType === "Bill").map((t) => t.TxnId))],
    }));
  },
  async purchasesByIds(ids) {
    return (await (await connectedQb()).purchasesByIds(ids)).map(qbTxn);
  },
  async billsByIds(ids) {
    return (await (await connectedQb()).billsByIds(ids)).map((b) => ({
      id: b.Id,
      txnDate: b.TxnDate,
      balance: b.Balance ?? null,
      paymentIds: [...new Set((b.LinkedTxn ?? []).filter((t) => t.TxnType === "BillPayment").map((t) => t.TxnId))],
    }));
  },
  async billPaymentsByIds(ids) {
    return (await (await connectedQb()).billPaymentsByIds(ids)).map((p) => ({ id: p.Id, txnDate: p.TxnDate }));
  },
};

/** Finance's Vendor search, verify and create, through the guarded client (off = null). */
const qbVendors: QbVendors = {
  async open() {
    const qb = await getQuickBooks();
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

/** The card or bank account a non-reimbursement expense is paid from, as finance set it on the books map. */
async function paymentAccountId(): Promise<string | null> {
  return (await (await import("@/lib/finance/booksMap")).booksMap.accounts()).EXPENSE_PAYMENT ?? null;
}

function paymentTypeOf(accountType: string | undefined): ExpensePosting["paymentType"] | null {
  if (accountType === "Credit Card") return "CreditCard";
  if (accountType === "Bank") return "Cash";
  return null;
}

// ponytail: one email per refused account per process; a restart emails again.
let refusedAlerted: string | null = null;

async function alertRefusedAccount(accountId: string, accountType: string | undefined): Promise<void> {
  if (refusedAlerted === accountId) return;
  refusedAlerted = accountId;
  const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
  const { config } = await import("@/lib/config");
  await notifyFinanceAlert("finance.expensePaymentAccount", {
    accountId,
    accountKind: accountType ? `a ${accountType} account` : "not in QuickBooks",
    actionLink: `${config.baseUrl()}/books-map`,
  }, "Expense payment-account alert failed:");
}

/** The daily orphan sweep read a full page, so an entry the app created may sit in QuickBooks unchecked. */
async function alertSweepIncomplete({ since }: { since: Date }): Promise<void> {
  const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
  const { config } = await import("@/lib/config");
  await notifyFinanceAlert("finance.expenseSweepIncomplete", {
    since: since.toISOString().slice(0, 10),
    actionLink: `${config.baseUrl()}/expense/expenses`,
  }, "Expense sweep alert failed:");
}

type PostingResolution = { posting: ExpensePosting } | { missing: string; refused?: { accountId: string; accountType: string | undefined } };

/** Production is the client's own API environment, which the guard admits only on CHECKIN_ENV=prod. */
async function resolvePosting(): Promise<PostingResolution> {
  const accountId = await paymentAccountId();
  if (!accountId) return { missing: `no account picked for: ${BOOKS_MAP_ROLE_LABELS.EXPENSE_PAYMENT}` };
  const client = await getQuickBooks();
  if (!client) return { missing: "a QuickBooks connection" };
  const accountType = (await client.accounts()).find((a) => a.Id === accountId)?.AccountType;
  const paymentType = paymentTypeOf(accountType);
  if (!paymentType) {
    const is = accountType ? `a ${accountType} account` : "not in QuickBooks";
    return { missing: `a Bank or Credit Card account for ${BOOKS_MAP_ROLE_LABELS.EXPENSE_PAYMENT} (the one picked is ${is})`, refused: { accountId, accountType } };
  }
  return { posting: { client, paymentAccountId: accountId, paymentType, prod: client.env === "production", sweepIncomplete: alertSweepIncomplete } };
}

async function posting(): Promise<ExpensePosting | null> {
  const resolved = await resolvePosting();
  if ("posting" in resolved) return resolved.posting;
  if (resolved.refused) await alertRefusedAccount(resolved.refused.accountId, resolved.refused.accountType);
  return null;
}

/** What expense posting lacks, in plain words; empty when it binds. Reads QuickBooks live. */
export async function expensePostingMissing(): Promise<string[]> {
  const resolved = await resolvePosting();
  return "posting" in resolved ? [] : [resolved.missing];
}

const outcomeMail: OutcomeMail = {
  async send(notice, to) {
    const { sendPurchaseOutcome } = await import("@/lib/purchaseOutcomeMail");
    return sendPurchaseOutcome(notice, to);
  },
};

export function configureRuntime(): void {
  configureExpense({
    org: getOrg,
    budgetOwners,
    signoff,
    catalog: catalogReader,
    catalogEvents: { eventsSince: catalogEventsSince },
    alerts: orgEventAlerts("board.expenseEventsStuck", "Expense catalog event alert failed:"),
    people,
    quickbooks: { reader: qbReader, refs: { paymentAccountId, vendorIdFor: reimburseeVendorId }, vendors: qbVendors, posting },
    outbound: outboundCall,
    outcomeMail,
  });
}
