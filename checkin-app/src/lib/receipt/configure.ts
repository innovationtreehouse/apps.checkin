/**
 * Wire the receipt library into checkin (#1265 §3/§6), called once at server boot from
 * instrumentation.ts. Binding touches no database and no network: the principal and the org
 * are read lazily, inside a request, and so are households. Bound crossings: X6 (the S1 sink,
 * workflow-mapping's intake, which dedupes on `receiptId`), X12 (reimbursement status, read
 * by expense from QuickBooks; QuickBooks off or any failure answers "not yet paid") and X13
 * (the donor sink, bound to donations in-process). Mail intake (§2a) is bound only on a deployed
 * instance with both the token refresher and the mailbox configured.
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { JWT } from "next-auth/jwt";
import { z } from "zod";
import { reimbursementStatus } from "@inventory/expense";
import {
  configureReceipt,
  createAnthropicOcr,
  createGmailReader,
  fixtureOcr,
  type MailboxReader,
  type ReceiptAlerts,
  type ReceiptPrincipal,
} from "@inventory/receipt";
import { ingestReceipt } from "@inventory/workflow-mapping";
import { recordInKindDonor, withdrawInKind } from "@inventory/bulk-donation";
import { getOrg } from "@/lib/catalog/configure";
import { config } from "@/lib/config";

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
  return toPrincipal(user.id, person.name, isKnownAdult(person));
}

function toPrincipal(id: number, name: string, isAdult: boolean): ReceiptPrincipal {
  const [firstName = "", ...rest] = name.trim().split(/\s+/);
  return { id, name, firstName, lastName: rest.join(" "), isAdult };
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
      programsLed: { select: { id: true } },
      programVolunteers: { where: { program: { phase: { not: "FINISHED" } } }, select: { programId: true }, take: 1 },
      household: { include: { orgMembership: true } },
      roles: { select: { role: true } },
    },
    take: 2,
  });
  if (matches.length !== 1) return null;
  const [person] = matches;
  const claims: JWT = { id: person.id, email: person.email, hd: address.split("@")[1], emailVerified: true };
  assignParticipantClaims(claims, person);
  if (claims.denied || !canSubmitReceipts(claims)) return null;
  return toPrincipal(person.id, person.name, isKnownAdult(person));
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

/** Bound only off-local with both values set; otherwise mail intake reports "unbound". */
function receiptMailbox(): MailboxReader | undefined {
  const functionName = process.env.GMAIL_REFRESHER_FN;
  const mailboxAddress = process.env.RECEIPT_MAILBOX_ADDRESS;
  if (config.checkinEnv() === "local" || !functionName || !mailboxAddress) return undefined;
  return createGmailReader(mailboxAddress, refresherAccessToken(functionName, mailboxAddress));
}

const alerts: ReceiptAlerts = {
  async mailHoldCeilingReached({ unresolved, refused }) {
    const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
    await notifyFinanceAlert(
      "Receipts: mail intake stopped holding mail",
      `<p>${unresolved} mailed item(s) are held for finance, the most the receipt mailbox holds. Today's mail run did not hold ${refused} more file(s) from unknown or unverified senders; they stay in the mailbox only. Receipts from known members are still read. Resolve held items to resume holding. <a href="${config.baseUrl()}/receipts/mail">Open the mail queue</a></p>`,
      "Receipt mail ceiling alert failed:",
    );
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
    alerts,
    mailbox: receiptMailbox(),
    reimbursementStatus,
    receiptSink: { ingestReceipt },
    donorSink: { recordInKindDonor, withdrawInKind },
    // Chosen by CHECKIN_ENV, never by whether a key is set (fail closed): a deployed instance
    // without the key reads nothing and lands auto uploads in ocr_failed.
    ocr: config.checkinEnv() === "local" ? fixtureOcr : createAnthropicOcr(process.env.ANTHROPIC_API_KEY),
  });
}
