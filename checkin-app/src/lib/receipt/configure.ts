/**
 * Wire the receipt library into checkin (#1265 §3/§6), called once at server boot from
 * instrumentation.ts. Binding touches no database and no network: the principal and the org
 * are read lazily, inside a request, and so are households. Bound crossings: X6 (the S1 sink,
 * workflow-mapping's intake, which dedupes on `receiptId`), X12 (reimbursement status, read
 * by expense from QuickBooks; QuickBooks off or any failure reads "status unavailable"), X13
 * (the donor sink, bound to donations in-process) and the purchase outcome (receiving, expense
 * and donations, joined here). Mail intake (§2a) is bound only on a deployed
 * instance with both the token refresher and the mailbox configured; each mailed receipt is
 * acknowledged by email (mailReply.ts).
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { JWT } from "next-auth/jwt";
import { z } from "zod";
import { expenseOutcomes, reimbursementStatus, submitterConfirmations } from "@checkin/expense";
import {
  configureReceipt,
  createAnthropicOcr,
  createGmailReader,
  fixtureOcr,
  type MailboxReader,
  type PurchaseOutcome,
  type ReceiptAlerts,
  type ReceiptReplies,
  type ReceiptPrincipal,
  type ReimburseeOption,
} from "@checkin/receipt";
import { ingestReceipt, receivingOutcomes } from "@checkin/workflow-mapping";
import { giftOutcomes, recordInKindDonor, withdrawInKind } from "@checkin/bulk-donation";
import { getOrg } from "@/lib/catalog/configure";
import { parsePersonName } from "@/lib/person/name";
import { config } from "@/lib/config";

/** Each finalized receipt's downstream outcome, joined from receiving, expense and donations. */
async function purchaseOutcomes(receiptIds: string[]): Promise<Map<string, PurchaseOutcome>> {
  const [receiving, money, gift] = await Promise.all([
    receivingOutcomes(receiptIds),
    expenseOutcomes.forReceipts(receiptIds),
    giftOutcomes(receiptIds),
  ]);
  return new Map(
    receiptIds.map((id) => [id, { receiving: receiving.get(id) ?? null, money: money.get(id) ?? null, gift: gift.get(id) ?? null }]),
  );
}

/**
 * The signed-in person as a receipt principal; null unless the session carries an integer id
 * that names a live Person. Names and adulthood come from the Person row: the uploader's
 * names fill "I am the donor", and only an adult may ask to be reimbursed.
 */
async function getPrincipal(): Promise<ReceiptPrincipal | null> {
  // Lazy: importing auth-options at boot would crash a Google-credless boot.
  const [{ getServerSession }, { authOptions }, { default: prisma }, { isKnownAdult }] = await Promise.all([
    import("next-auth"),
    import("@/lib/auth-options"),
    import("@/lib/prisma"),
    import("@/lib/programAge"),
  ]);
  const user = (await getServerSession(authOptions))?.user;
  if (!user || typeof user.id !== "number") return null;
  const person = await prisma.person.findFirst({
    where: { id: user.id, mergedIntoId: null },
    select: { name: true, dateOfBirth: true, isDeclaredAdult: true },
  });
  if (!person) return null;
  return { ...toPrincipal(user.id, person.name, isKnownAdult(person)), isBoardMember: user.isBoardMember === true };
}

function toPrincipal(id: number, name: string, isAdult: boolean): ReceiptPrincipal {
  const { given, surname } = parsePersonName(name);
  const lastName = surname ? surname.particles + surname.core : "";
  return { id, name, firstName: given, lastName, isAdult };
}

/**
 * The one live, sign-in-verified person with this email who would pass the `receipt-submitter`
 * gate if signed in, else null. Claims come from the same derivation the session uses. The
 * caller vouches for the address in place of the provider's verified-email claim: mail intake
 * by DMARC alignment, the finance mail queue by the finance holder who typed it.
 */
async function submitterByEmail(address: string): Promise<ReceiptPrincipal | null> {
  const [{ default: prisma }, { LIVE_PERSON, SIGN_IN_VERIFIED_PERSON }, { assignParticipantClaims }, { canSubmitReceipts }, { isKnownAdult }] =
    await Promise.all([
      import("@/lib/prisma"),
      import("@/lib/person/filters"),
      import("@/lib/authClaims"),
      import("@/lib/volunteer"),
      import("@/lib/programAge"),
    ]);
  const matches = await prisma.person.findMany({
    where: { ...LIVE_PERSON, ...SIGN_IN_VERIFIED_PERSON, email: { equals: address, mode: "insensitive" } },
    include: {
      toolStatuses: { select: { toolId: true, level: true } },
      programsLed: { select: { id: true, phase: true } },
      programVolunteers: { where: { program: { phase: { not: "FINISHED" } } }, select: { programId: true }, take: 1 },
      household: { include: { orgMembership: true } },
      roles: { select: { role: true } },
    },
    take: 2,
  });
  // Only the person's own sign-in email vouches for them, and only it carries the org-account claim.
  const exact = matches.filter((p) => p.email?.toLowerCase() === address);
  if (matches.length !== 1 || exact.length !== 1) return null;
  const [person] = exact;
  const claims: JWT = { id: person.id, email: person.email, hd: address.split("@")[1], emailVerified: true };
  assignParticipantClaims(claims, person);
  if (claims.denied || !canSubmitReceipts(claims)) return null;
  const leadsActiveProgram = person.programsLed.some((p) => p.phase !== "FINISHED");
  return { ...toPrincipal(person.id, person.name, isKnownAdult(person)), raisedMailLimit: claims.isBoardMember === true || leadsActiveProgram };
}

/** Live people whose name contains the query, by name. */
const AGE_FIELDS = { id: true, name: true, dateOfBirth: true, isDeclaredAdult: true } as const;

/** Live known adults whose name contains the query, by name. Adulthood is isKnownAdult, applied after the name match. */
async function searchReimbursees(query: string, limit: number): Promise<ReimburseeOption[]> {
  const [{ default: prisma }, { LIVE_PERSON }, { isKnownAdult }] = await Promise.all([
    import("@/lib/prisma"),
    import("@/lib/person/filters"),
    import("@/lib/programAge"),
  ]);
  const matches = await prisma.person.findMany({
    where: { ...LIVE_PERSON, name: { contains: query, mode: "insensitive" } },
    select: AGE_FIELDS,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return matches.filter(isKnownAdult).slice(0, limit).map(({ id, name }) => ({ id, name }));
}

async function reimburseeById(personId: number): Promise<(ReimburseeOption & { isAdult: boolean }) | null> {
  const [{ default: prisma }, { LIVE_PERSON }, { isKnownAdult }] = await Promise.all([
    import("@/lib/prisma"),
    import("@/lib/person/filters"),
    import("@/lib/programAge"),
  ]);
  const person = await prisma.person.findFirst({ where: { id: personId, ...LIVE_PERSON }, select: AGE_FIELDS });
  return person && { id: person.id, name: person.name, isAdult: isKnownAdult(person) };
}

/** Whether a live person has an account to sign in with. */
async function reimburseeHasAccount(personId: number): Promise<boolean> {
  const [{ default: prisma }, { LIVE_PERSON, SIGN_IN_VERIFIED_PERSON }] = await Promise.all([import("@/lib/prisma"), import("@/lib/person/filters")]);
  return (await prisma.person.count({ where: { id: personId, ...LIVE_PERSON, ...SIGN_IN_VERIFIED_PERSON } })) > 0;
}

/** Re-ask the refresher this long before the token it handed out expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;

const RefresherAnswer = z.object({ accessToken: z.string().min(1), expiresAt: z.number(), mailbox: z.string() });

/**
 * The access token the Infra refresher Lambda publishes, kept until near expiry. The refresher
 * alone holds the refresh token; its answer must name our mailbox, or no token is handed out.
 */
function refresherAccessToken(functionName: string, mailboxAddress: string): () => Promise<string> {
  let cached: z.infer<typeof RefresherAnswer> | null = null;
  return async () => {
    if (cached && Date.now() < cached.expiresAt - TOKEN_MARGIN_MS) return cached.accessToken;
    const lambda = new LambdaClient({ region: config.awsRegion() });
    const res = await lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: JSON.stringify({ action: "current" }) }));
    // The error payload can echo token-endpoint detail; name only the function.
    if (res.FunctionError) throw new Error(`Gmail token refresher ${functionName} failed`);
    const answer = RefresherAnswer.parse(JSON.parse(new TextDecoder().decode(res.Payload)));
    if (answer.mailbox.toLowerCase() !== mailboxAddress.toLowerCase()) throw new Error("Gmail token refresher holds a different mailbox");
    cached = answer;
    return answer.accessToken;
  };
}

/**
 * Bound only on CHECKIN_ENV prod, dev or stg (exactly), with both values set; otherwise mail
 * intake reports "unbound". An unset or unknown CHECKIN_ENV binds nothing, though checkinEnv()
 * reads it as prod. Off prod (dev, and ops-stg, which reads as prod) it also needs
 * RECEIPT_PROD_MAILBOX_ADDRESS, naming the real mailbox, and refuses that mailbox: a non-prod
 * instance reads only its own test mailbox.
 */
function receiptMailbox(): MailboxReader | undefined {
  const functionName = process.env.GMAIL_REFRESHER_FN;
  const mailboxAddress = process.env.RECEIPT_MAILBOX_ADDRESS;
  const env = process.env.CHECKIN_ENV;
  if (env === "local" || !functionName || !mailboxAddress) return undefined;
  if (env !== "prod" && env !== "dev" && env !== "stg") {
    console.error(`[receipt] mail intake unbound: CHECKIN_ENV must be prod, dev or stg, not ${JSON.stringify(env ?? "")}`);
    return undefined;
  }
  if (env !== "prod" || config.isStaging()) {
    const prodMailbox = process.env.RECEIPT_PROD_MAILBOX_ADDRESS?.trim().toLowerCase();
    if (!prodMailbox || prodMailbox === mailboxAddress.trim().toLowerCase()) {
      console.error("[receipt] mail intake unbound: off prod, RECEIPT_PROD_MAILBOX_ADDRESS must be set and name a different mailbox");
      return undefined;
    }
  }
  return createGmailReader(mailboxAddress, refresherAccessToken(functionName, mailboxAddress));
}

const alerts: ReceiptAlerts = {
  async mailHoldCeilingReached({ unresolved, refused }) {
    const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
    await notifyFinanceAlert(
      "Receipts: mail intake stopped holding mail",
      `<p>${unresolved} mailed item(s) are held or deferred in the incoming receipt queue, the most the receipt mailbox holds. Today's mail run did not store ${refused} more file(s) from unknown or unverified senders, or from members over their daily upload limit; they stay in the mailbox only. Receipts from members within their limit are still read. Resolve or release queued items to resume holding. <a href="${config.baseUrl()}/receipts/mail">Open the incoming receipt queue</a></p>`,
      "Receipt mail ceiling alert failed:",
    );
  },
  async mailAgingOut({ messages, oldestReceivedAt }) {
    const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
    const since = oldestReceivedAt ? `, the oldest received ${oldestReceivedAt.toUTCString()}` : "";
    await notifyFinanceAlert(
      "Receipts: mailed receipts are about to be missed",
      `<p>Today's mail run did not finish reading ${messages} message(s) in the receipt mailbox${since}. They leave the 3-day reading window before the next run, so no receipt will be made from them. Open the receipt mailbox in Gmail and upload or forward them again. <a href="${config.baseUrl()}/receipts/mail">Open the incoming receipt queue</a></p>`,
      "Receipt mail ageing alert failed:",
    );
  },
};

/** A live, sign-in-verified person's email and name, for a mailed receipt's acknowledgement. */
async function contactOf(personId: number): Promise<{ email: string; name: string } | null> {
  const [{ default: prisma }, { LIVE_PERSON, SIGN_IN_VERIFIED_PERSON }] = await Promise.all([import("@/lib/prisma"), import("@/lib/person/filters")]);
  const person = await prisma.person.findFirst({ where: { id: personId, ...LIVE_PERSON, ...SIGN_IN_VERIFIED_PERSON }, select: { email: true, name: true } });
  return person?.email ? { email: person.email, name: person.name } : null;
}

const replies: ReceiptReplies = {
  contactOf,
  async send(ack) {
    const { sendMailReply } = await import("@/lib/receipt/mailReply");
    return sendMailReply(ack, process.env.RECEIPT_MAILBOX_ADDRESS);
  },
};

/** Live members of every household holding one of these people; a merged-away person's household still counts. */
async function householdOf(personIds: number[]): Promise<number[]> {
  if (personIds.length === 0) return [];
  const [{ default: prisma }, { LIVE_PERSON }] = await Promise.all([import("@/lib/prisma"), import("@/lib/person/filters")]);
  const members = await prisma.person.findMany({
    where: { household: { householdMembers: { some: { id: { in: personIds } } } }, ...LIVE_PERSON },
    select: { id: true },
  });
  return members.map((m) => m.id);
}

export function configureRuntime(): void {
  configureReceipt({
    auth: { getPrincipal },
    org: getOrg,
    households: { householdOf },
    people: { submitterByEmail },
    reimbursees: { search: searchReimbursees, byId: reimburseeById, hasAccount: reimburseeHasAccount },
    alerts,
    mailbox: receiptMailbox(),
    replies,
    reimbursementStatus,
    submitterConfirmations,
    purchaseOutcomes: { forReceipts: purchaseOutcomes },
    receiptSink: { ingestReceipt },
    donorSink: { recordInKindDonor, withdrawInKind },
    // Chosen by CHECKIN_ENV, never by whether a key is set (fail closed): a deployed instance
    // without the key reads nothing and lands auto uploads in ocr_failed.
    ocr: config.checkinEnv() === "local" ? fixtureOcr : createAnthropicOcr(process.env.ANTHROPIC_API_KEY),
  });
}
