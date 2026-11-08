/**
 * Wire the receipt library into checkin, called once at server boot from
 * instrumentation.ts. Binding touches no database and no network: the principal and the org
 * are read lazily, inside a request, and so are households. Bound crossings: the receipt sink
 * (workflow-mapping's intake, which dedupes on `receiptId`), reimbursement status (read
 * by expense from QuickBooks; QuickBooks off or any failure reads "status unavailable"),
 * the donor sink (bound to donations in-process) and the purchase outcome (receiving, expense
 * and donations, joined here). Mail intake is bound only on a deployed
 * instance with both the token refresher and the mailbox configured; each mailed receipt is
 * acknowledged by email (mailReply.ts). A receipt finance rejects is emailed to its uploader and
 * the person reimbursed (purchaseOutcomeMail.ts).
 */
import type { JWT } from "next-auth/jwt";
import type { FailureKind } from "@checkin/component-kit";
import { expenseOutcomes, reimbursementStatus, submitterConfirmations } from "@checkin/expense";
import {
  configureReceipt,
  createAnthropicOcr,
  createGmailReader,
  fixtureOcr,
  type MailboxReader,
  type OutcomeMail,
  type PurchaseOutcome,
  type ReceiptAlerts,
  type ReceiptReplies,
  type ReceiptPrincipal,
  type ReimburseeOption,
} from "@checkin/receipt";
import { ingestReceipt, receivingOutcomes } from "@checkin/workflow-mapping";
import { giftOutcomes, recordInKindDonor, withdrawInKind } from "@checkin/bulk-donation";
import { getOrg, sessionUser } from "@/lib/components/host";
import { householdOf } from "@/lib/components/ports";
import { householdWithMembership, IN_LIVE_HOUSEHOLD } from "@/lib/household/archived";
import { parsePersonName } from "@/lib/person/name";
import { config } from "@/lib/config";
import { receiptFileStore } from "@/lib/receipt/fileStore";
import { gmailAccessToken } from "@/lib/receipt/gmailToken";
import { receiptMailboxConfig } from "@/lib/receipt/mailboxConfig";

/** Each finalized receipt's downstream outcome, joined from receiving, expense and donations. */
async function purchaseOutcomes(receiptIds: string[]): Promise<Map<string, PurchaseOutcome>> {
  const [receiving, money, gift] = await Promise.all([
    receivingOutcomes(receiptIds),
    expenseOutcomes.forReceipts(receiptIds),
    giftOutcomes(receiptIds),
  ]);
  return new Map(
    receiptIds.map((id) => {
      const r = receiving.get(id);
      return [id, { receiving: r?.receiving ?? null, openBackorders: r?.openBackorders ?? 0, money: money.get(id) ?? null, gift: gift.get(id) ?? null }];
    }),
  );
}

/**
 * The signed-in person as a receipt principal; null for any session checkin refuses or one
 * that names no Person. Names and adulthood come from the Person row: the uploader's
 * names fill "I am the donor", and only an adult may ask to be reimbursed.
 */
async function getPrincipal(): Promise<ReceiptPrincipal | null> {
  const user = await sessionUser();
  if (!user) return null;
  const [{ default: prisma }, { isKnownAdult }] = await Promise.all([import("@/lib/prisma"), import("@/lib/programAge")]);
  const person = await prisma.person.findFirst({
    where: { id: user.id },
    select: { name: true, dateOfBirth: true, isDeclaredAdult: true },
  });
  if (!person) return null;
  return {
    ...toPrincipal(user.id, person.name, isKnownAdult(person)),
    isBoardMember: user.isBoardMember === true,
    addsPeople: user.isFinance === true || user.isOperations === true || user.isBoardMember === true,
  };
}

function toPrincipal(id: number, name: string, isAdult: boolean): ReceiptPrincipal {
  const { given, surname } = parsePersonName(name);
  const lastName = surname ? surname.particles + surname.core : "";
  return { id, name, firstName: given, lastName, isAdult };
}

/** Each person's name; the library passes ids already resolved through merges. */
async function personNames(personIds: number[]): Promise<Map<number, string>> {
  const { default: prisma } = await import("@/lib/prisma");
  const people = await prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true } });
  return new Map(people.flatMap((p) => (p.name ? [[p.id, p.name] as const] : [])));
}

/**
 * The one live, sign-in-verified person whose email or approved mail alias is exactly this
 * address and who would pass the `receipt-submitter` gate if signed in, else null. Claims come
 * from the same derivation the session uses, and from the person, never the incoming address,
 * which only finds them. The caller vouches for the address in place of the provider's
 * verified-email claim: mail intake by DMARC alignment, the finance mail queue by the finance
 * holder who typed it.
 */
async function submitterByEmail(address: string): Promise<ReceiptPrincipal | null> {
  const [{ default: prisma }, { SIGN_IN_VERIFIED_PERSON }, { assignParticipantClaims }, { canSubmitReceipts }, { isKnownAdult }] =
    await Promise.all([
      import("@/lib/prisma"),
      import("@/lib/person/filters"),
      import("@/lib/authClaims"),
      import("@/lib/volunteer"),
      import("@/lib/programAge"),
    ]);
  const matches = await prisma.person.findMany({
    where: {
      ...SIGN_IN_VERIFIED_PERSON,
      OR: [{ email: { equals: address, mode: "insensitive" } }, { mailAliases: { some: { address, approvedAt: { not: null } } } }],
    },
    include: {
      mailAliases: { where: { address, approvedAt: { not: null } }, select: { id: true } },
      toolStatuses: { select: { toolId: true, level: true } },
      programsLed: { select: { id: true, phase: true } },
      programVolunteers: { where: { program: { phase: { not: "FINISHED" } } }, select: { programId: true }, take: 1 },
      household: { include: { orgMembership: true } },
      roles: { select: { role: true } },
    },
    take: 2,
  });
  // Only the person's own sign-in email or an approved alias vouches for them.
  const exact = matches.filter((p) => p.email?.toLowerCase() === address || p.mailAliases.length > 0);
  if (matches.length !== 1 || exact.length !== 1) return null;
  const [person] = exact;
  // Row security returns an archived household as null; its DENIED status still applies.
  person.household ??= await householdWithMembership(person.householdId);
  // The org-account claim follows the sign-in email, including for mail from an alias.
  const claims: JWT = { id: person.id, email: person.email, hd: person.email?.toLowerCase().split("@")[1], emailVerified: true };
  assignParticipantClaims(claims, person);
  if (claims.denied || !canSubmitReceipts(claims)) return null;
  const leadsActiveProgram = person.programsLed.some((p) => p.phase !== "FINISHED");
  return { ...toPrincipal(person.id, person.name, isKnownAdult(person)), raisedMailLimit: claims.isBoardMember === true || leadsActiveProgram };
}

/** Live people whose name contains the query, by name. */
const AGE_FIELDS = { id: true, name: true, dateOfBirth: true, isDeclaredAdult: true } as const;

/** Live known adults whose name contains the query, by name. Adulthood is isKnownAdult, applied after the name match. */
async function searchReimbursees(query: string, limit: number): Promise<ReimburseeOption[]> {
  const [{ default: prisma }, { isKnownAdult }] = await Promise.all([
    import("@/lib/prisma"),
    import("@/lib/programAge"),
  ]);
  const matches = await prisma.person.findMany({
    where: { name: { contains: query, mode: "insensitive" }, ...IN_LIVE_HOUSEHOLD },
    select: AGE_FIELDS,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return matches.filter(isKnownAdult).slice(0, limit).map(({ id, name }) => ({ id, name }));
}

async function reimburseeById(personId: number): Promise<(ReimburseeOption & { isAdult: boolean }) | null> {
  const [{ default: prisma }, { isKnownAdult }] = await Promise.all([
    import("@/lib/prisma"),
    import("@/lib/programAge"),
  ]);
  const person = await prisma.person.findFirst({ where: { id: personId }, select: AGE_FIELDS });
  return person && { id: person.id, name: person.name, isAdult: isKnownAdult(person) };
}

/** Whether a live person has an account to sign in with. */
async function reimburseeHasAccount(personId: number): Promise<boolean> {
  const [{ default: prisma }, { SIGN_IN_VERIFIED_PERSON }] = await Promise.all([import("@/lib/prisma"), import("@/lib/person/filters")]);
  return (await prisma.person.count({ where: { id: personId, ...SIGN_IN_VERIFIED_PERSON } })) > 0;
}

async function addNonMemberReimbursee(name: string): Promise<ReimburseeOption> {
  const [{ default: prisma }, { addNonMemberAdult }] = await Promise.all([import("@/lib/prisma"), import("@/lib/person/ownHousehold")]);
  return addNonMemberAdult(prisma, name);
}

/** The Gmail reader when mail intake binds (mailboxConfig.ts); otherwise intake reports "unbound". */
function receiptMailbox(): MailboxReader | undefined {
  const mailbox = receiptMailboxConfig();
  if (!mailbox.bound) {
    if (mailbox.refused) console.error(`[receipt] mail intake unbound: ${mailbox.refused}`);
    return undefined;
  }
  return createGmailReader(mailbox.mailboxAddress, gmailAccessToken(mailbox));
}

/** The mail-run alert that names the cause of a failed mailbox listing. */
const MAILBOX_LISTING_ALERT = {
  connection: "finance.receiptMailboxUnreadable",
  system: "finance.receiptMailboxUnanswered",
  settings: "finance.receiptMailboxNotFound",
  data: "finance.receiptMailboxFailed",
  bug: "finance.receiptMailboxFailed",
} as const satisfies Record<FailureKind, string>;

const alerts: ReceiptAlerts = {
  async mailHoldCeilingReached({ unresolved, refused }) {
    const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
    await notifyFinanceAlert("finance.receiptMailCeiling", {
      unresolved: String(unresolved),
      refused: String(refused),
      actionLink: `${config.baseUrl()}/receipts/mail`,
    }, "Receipt mail ceiling alert failed:");
  },
  async mailAgingOut({ messages, oldestReceivedAt }) {
    const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
    await notifyFinanceAlert("finance.receiptMailAgeing", {
      messages: String(messages),
      since: oldestReceivedAt ? `, the oldest received ${oldestReceivedAt.toUTCString()}` : "",
      actionLink: `${config.baseUrl()}/receipts/mail`,
    }, "Receipt mail ageing alert failed:");
  },
  async mailListingFailed({ kind }) {
    const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
    await notifyFinanceAlert(MAILBOX_LISTING_ALERT[kind], {
      actionLink: `${config.baseUrl()}/receipts/mail`,
    }, "Receipt mailbox listing alert failed:");
  },
};

/** A live, sign-in-verified person's email and name, for a mailed receipt's acknowledgement. */
async function contactOf(personId: number): Promise<{ email: string; name: string } | null> {
  const [{ default: prisma }, { SIGN_IN_VERIFIED_PERSON }] = await Promise.all([import("@/lib/prisma"), import("@/lib/person/filters")]);
  const person = await prisma.person.findFirst({ where: { id: personId, ...SIGN_IN_VERIFIED_PERSON }, select: { email: true, name: true } });
  return person?.email ? { email: person.email, name: person.name } : null;
}

const replies: ReceiptReplies = {
  contactOf,
  async send(ack) {
    const { sendMailReply } = await import("@/lib/receipt/mailReply");
    return sendMailReply(ack, process.env.RECEIPT_MAILBOX_ADDRESS);
  },
};

async function liveIds(personIds: number[]): Promise<Map<number, number | null>> {
  return (await import("@/lib/person/mergeChain")).liveIdsOf(personIds);
}

async function storedIdsOf(personId: number): Promise<number[]> {
  return (await import("@/lib/person/mergeChain")).storedIdsOf(personId);
}

const outcomeMail: OutcomeMail = {
  async send(notice, to) {
    const { sendPurchaseOutcome } = await import("@/lib/purchaseOutcomeMail");
    return sendPurchaseOutcome(notice, to);
  },
};

export function configureRuntime(): void {
  configureReceipt({
    auth: { getPrincipal },
    org: getOrg,
    households: { householdOf },
    personIds: { liveIds, storedIdsOf },
    people: { submitterByEmail },
    personNames: { namesOf: personNames },
    reimbursees: { search: searchReimbursees, byId: reimburseeById, hasAccount: reimburseeHasAccount, addNonMemberAdult: addNonMemberReimbursee },
    alerts,
    mailbox: receiptMailbox(),
    replies,
    outcomeMail,
    reimbursementStatus,
    submitterConfirmations,
    purchaseOutcomes: { forReceipts: purchaseOutcomes },
    receiptSink: { ingestReceipt },
    donorSink: { recordInKindDonor, withdrawInKind },
    // Chosen by CHECKIN_ENV, never by whether a key is set (fail closed): a deployed instance
    // without the key reads nothing and lands auto uploads in ocr_failed.
    ocr: config.isLocal() ? fixtureOcr : createAnthropicOcr(config.anthropicApiKey() ?? undefined),
    fileStore: receiptFileStore(),
    storeNewFilesInBucket: config.receiptFilesS3(),
  });
}
