import { DEFAULT_ACK_MEMBERSHIP_BODY, DEFAULT_ACK_PROGRAM_BODY, DEFAULT_ACK_SUBJECT } from "@/lib/scholarshipAckCopy";
import type { TokenSpec, TokenSpecs } from "./tokens";

/**
 * The contract and default copy of every templated email. An `EmailTemplate`
 * row overrides a key's subject/body once the Board saves one; until then the
 * defaults here are what sends. Bodies are plain text: a blank line starts a
 * paragraph, a single newline is a line break. Client-safe (no server imports)
 * so the admin preview can read it.
 */

export interface TemplateSpec {
    allowedTokens: TokenSpecs;
    /** Example values for every allowed token; drives the admin preview. */
    sampleCtx: Record<string, string>;
    defaultSubject: string;
    defaultBody: string;
}

const text: TokenSpec = { kind: "text" };
const link = (label?: string): TokenSpec => (label ? { kind: "link", label } : { kind: "link" });
const SAMPLE_URL = "https://checkin.example.org/";

export const REGISTRY = {
    // ── checkin (attendance) ────────────────────────────────────────────────
    "checkin.receipt": {
        allowedTokens: { name: text, emoji: text, visitWord: text, action: text, date: text, time: text, via: text },
        sampleCtx: { name: "Alex Rivera", emoji: "✅", visitWord: "Started", action: "checked in to", date: "Saturday, March 7", time: "10:05 AM", via: "📍 via badge scan" },
        defaultSubject: "{{emoji}} {{name}} {{action}} Innovation Treehouse",
        defaultBody: "{{emoji}} Visit {{visitWord}}\n\n{{name}} {{action}} Innovation Treehouse.\n\n📅 {{date}}\n🕐 {{time}}\n\n{{via}}",
    },
    "checkin.householdMember": {
        allowedTokens: { leadName: text, memberName: text, emoji: text, arrivalWord: text, action: text, date: text, time: text, via: text },
        sampleCtx: { leadName: "Jordan Rivera", memberName: "Alex Rivera", emoji: "✅", arrivalWord: "Arrival", action: "checked in to", date: "Saturday, March 7", time: "10:05 AM", via: "📍 via badge scan" },
        defaultSubject: "{{emoji}} {{memberName}} {{action}} Innovation Treehouse",
        defaultBody: "{{emoji}} Household Member {{arrivalWord}}\n\nHi {{leadName}},\n\nYour household member {{memberName}} {{action}} Innovation Treehouse.\n\n📅 {{date}}\n🕐 {{time}}\n\n{{via}}",
    },
    "attendance.selfCorrectionFlag": {
        allowedTokens: { scope: text, change: text, visitId: text, actorName: text, verb: text, whose: text, score: text, detail: text },
        sampleCtx: { scope: "self", change: "edit", visitId: "4821", actorName: "Alex Rivera", verb: "changed", whose: "one of their own", score: "7", detail: "Mar 7, 10:05 AM → Mar 7, 8:00 AM" },
        defaultSubject: "Attendance: significant {{scope}}-{{change}} of visit #{{visitId}}",
        defaultBody: "{{actorName}} {{verb}} {{whose}} visit (significance {{score}}).\n\n{{detail}}\n\nFull before/after is in the audit trail (Visit #{{visitId}}).",
    },

    // ── programs ────────────────────────────────────────────────────────────
    "enrollment.confirm": {
        allowedTokens: { name: text, programName: text },
        sampleCtx: { name: "Alex Rivera", programName: "Robotics Club" },
        defaultSubject: "Confirmed: Enrollment in {{programName}}",
        defaultBody: "Hi {{name}}, you have been successfully enrolled in {{programName}}.",
    },
    "program.assignment": {
        allowedTokens: { programName: text, actionLink: link("here") },
        sampleCtx: { programName: "Robotics Club", actionLink: SAMPLE_URL },
        defaultSubject: "Your Innovation Treehouse Program has been Created!",
        defaultBody: "Your Innovation Treehouse Program has been Created!\n\n"
            + "Congrats! Your program {{programName}} has been approved and initialized by Innovation Treehouse.\n\n"
            + "You can manage it {{actionLink}}.\n\n"
            + "We recommend adding the first couple of events to the program, and then marking it open for enrollment as soon as you can so our community can start signing up!\n\n"
            + "Thank you again for your commitment to teaching and fostering community with this upcoming program,\n\n"
            + "Sincerely,\nInnovation Treehouse",
    },
    "program.announced": {
        allowedTokens: { name: text, programName: text },
        sampleCtx: { name: "Alex Rivera", programName: "Robotics Club" },
        defaultSubject: "New program: {{programName}}",
        defaultBody: "Hi {{name}}, a new program \"{{programName}}\" is now open for enrollment.",
    },
    "event.postEvent": {
        allowedTokens: { eventName: text, rsvpCount: text, checkinCount: text, actionLink: link("Review & Confirm Attendance") },
        sampleCtx: { eventName: "Robotics Club — Week 3", rsvpCount: "12", checkinCount: "10", actionLink: SAMPLE_URL },
        defaultSubject: "Action Required: Confirm Attendance for {{eventName}}",
        defaultBody: "Event Completed: {{eventName}}\n\n"
            + "The event {{eventName}} has finished.\n\n"
            + "Attendance Summary\nRSVPs (Attending): {{rsvpCount}}\nLogged Check-ins: {{checkinCount}}\n\n"
            + "Please review the automatically gathered attendance data and officially confirm it for our records. You can make any manual adjustments needed before confirming.\n\n"
            + "{{actionLink}}",
    },
    "participant.pendingWarning.day1": {
        allowedTokens: { programName: text },
        sampleCtx: { programName: "Robotics Club" },
        defaultSubject: "Reminder: Payment required for {{programName}}",
        defaultBody: "If not paid, your spot in {{programName}} may be released by the board. If you need a scholarship or payment plan, request one from the program's page — the Scholarship Review Team will follow up.",
    },
    "participant.pendingWarning.day3": {
        allowedTokens: { programName: text },
        sampleCtx: { programName: "Robotics Club" },
        defaultSubject: "Please pay for {{programName}} within 4 days",
        defaultBody: "If not paid, your spot in {{programName}} may be released by the board. If you need a scholarship or payment plan, request one from the program's page — the Scholarship Review Team will follow up.",
    },
    "participant.pendingWarning.day6": {
        allowedTokens: { programName: text },
        sampleCtx: { programName: "Robotics Club" },
        defaultSubject: "FINAL WARNING: 24 hours left to pay for {{programName}}",
        defaultBody: "If not paid, your spot in {{programName}} may be released by the board. If you need a scholarship or payment plan, request one from the program's page — the Scholarship Review Team will follow up.",
    },

    // ── membership ──────────────────────────────────────────────────────────
    "membership.reviewNeeded": {
        allowedTokens: { actionLink: link() },
        sampleCtx: { actionLink: SAMPLE_URL },
        defaultSubject: "Membership: a background-check review is needed",
        defaultBody: "An application is ready for your background-check review. Please sign in to review it: {{actionLink}}",
    },
    "membership.paymentOpen": {
        allowedTokens: { actionLink: link() },
        sampleCtx: { actionLink: SAMPLE_URL },
        defaultSubject: "Background check complete — you can now pay your membership fee",
        defaultBody: "Good news — your household's background-check review is complete. The last step is paying your membership fee: {{actionLink}}",
    },
    "membership.paymentOpenExistingCheck": {
        allowedTokens: { actionLink: link() },
        sampleCtx: { actionLink: SAMPLE_URL },
        defaultSubject: "Your background check is on file — you can now pay your membership fee",
        defaultBody: "Good news — your household already holds a current background check, so no new one is needed. The last step is paying your membership fee: {{actionLink}}",
    },
    "membership.welcome": {
        allowedTokens: { actionLink: link("Visit your dashboard") },
        sampleCtx: { actionLink: SAMPLE_URL },
        defaultSubject: "Welcome to the Treehouse — your membership is active!",
        defaultBody: "Congratulations! Your household membership is now active. Welcome to the Innovation Treehouse community.\n\n{{actionLink}}",
    },
    "membership.renewed": {
        allowedTokens: { actionLink: link("Visit your dashboard") },
        sampleCtx: { actionLink: SAMPLE_URL },
        defaultSubject: "Thank you for renewing — your Treehouse membership is active!",
        defaultBody: "Thank you for renewing! Your household membership is active again — we're glad to have your family back at the Innovation Treehouse.\n\n{{actionLink}}",
    },

    // ── board ───────────────────────────────────────────────────────────────
    "board.paidReject": {
        allowedTokens: { processId: text, actionLink: link("Open applications") },
        sampleCtx: { processId: "318", actionLink: SAMPLE_URL },
        defaultSubject: "Membership: a paid application was blocked at background check",
        defaultBody: "A household that already paid did not pass background-check review (application #{{processId}}). The membership has not been activated and a refund may be needed — please review and contact the household. {{actionLink}}",
    },
    "board.paymentException": {
        // blurb: the exception kind's fixed description, kept in code (decision B-1).
        allowedTokens: { kind: text, blurb: text, exceptionId: text, actionLink: link("Open payment problems") },
        sampleCtx: { kind: "CHARGEBACK", blurb: "a chargeback/dispute was filed against an active membership/enrollment's payment", exceptionId: "57", actionLink: SAMPLE_URL },
        defaultSubject: "Payment problem ({{kind}}) — board action needed",
        defaultBody: "A payment problem needs the board's attention: {{blurb}} (#{{exceptionId}}). Nothing was changed automatically. {{actionLink}}",
    },
    "board.pendingDigest": {
        allowedTokens: { approachingCount: text, overdueCount: text, approachingList: text, overdueList: text },
        sampleCtx: { approachingCount: "1", overdueCount: "1", approachingList: "Alex Rivera — Robotics Club (day 3)", overdueList: "Sam Lee — Pottery (day 8)" },
        defaultSubject: "Non-payment digest: {{approachingCount}} approaching deadline, {{overdueCount}} overdue",
        defaultBody: "Approaching deadline (3+ days unpaid, final warning at day 6)\n{{approachingList}}\n\n"
            + "Overdue (7+ days) — action needed: remove the enrollment or contact the household\n{{overdueList}}",
    },
    "board.unpaidClaims": {
        allowedTokens: { programName: text, names: text, actionLink: link("Open the program") },
        sampleCtx: { programName: "Robotics Club", names: "Alex Rivera\nSam Lee", actionLink: SAMPLE_URL },
        defaultSubject: "Unpaid program claims: {{programName}}",
        defaultBody: "The sale for {{programName}} ended a week ago. These claims are still unpaid:\n{{names}}\n\n{{actionLink}}",
    },
    "board.programAgeMisfit": {
        allowedTokens: { programName: text, count: text, people: text, actionLink: link("Open the program") },
        sampleCtx: { programName: "Robotics Club", count: "1", people: "Alex Rivera: 13 at the start date (paid)", actionLink: SAMPLE_URL },
        defaultSubject: "Program \"{{programName}}\": {{count}} enrolled no longer fit its ages",
        defaultBody: "An edit to the dates or age limits of {{programName}} leaves these enrolled people outside its ages at the start date. Nothing was changed; please decide with the program leader and the families.\n{{people}}\n\n{{actionLink}}",
    },

    "board.inventoryEventsStuck": {
        // problem: what the catch-up found, in code because it depends on the failure.
        allowedTokens: { problem: text },
        sampleCtx: { problem: "found 2 newly failed and 3 unprocessed catalog event(s)" },
        defaultSubject: "Inventory: catalog events need attention",
        defaultBody: "The inventory catch-up {{problem}}. Until they apply, provisional items the catalog has reviewed can stay pending. The daily run keeps retrying; an engineer should check the reconcile logs. A failed event alerts only once.",
    },

    "board.expenseEventsStuck": {
        // problem: what the catch-up found, in code because it depends on the failure.
        allowedTokens: { problem: text },
        sampleCtx: { problem: "found 2 newly failed and 3 unprocessed catalog event(s)" },
        defaultSubject: "Expense: catalog events need attention",
        defaultBody: "The expense catch-up {{problem}}. Until they apply, provisional items the catalog has reviewed can stay pending, and their budget buckets don't carry over to the real items. The daily run keeps retrying; an engineer should check the reconcile logs. A failed event alerts only once.",
    },

    "board.receiptMappingEventsStuck": {
        // problem: what the catch-up found, in code because it depends on the failure.
        allowedTokens: { problem: text },
        sampleCtx: { problem: "found 2 newly failed and 3 unprocessed catalog event(s)" },
        defaultSubject: "Receipt mapping: catalog events need attention",
        defaultBody: "The receipt mapping catch-up {{problem}}. Until they apply, lines on receipts in review can stay on items the catalog has already reviewed. The daily run keeps retrying; an engineer should check the reconcile logs. A failed event alerts only once.",
    },

    // ── finance ─────────────────────────────────────────────────────────────
    "finance.receiptMailCeiling": {
        allowedTokens: { unresolved: text, refused: text, actionLink: link("Open the incoming receipt queue") },
        sampleCtx: { unresolved: "200", refused: "4", actionLink: SAMPLE_URL },
        defaultSubject: "Receipts: mail intake stopped holding mail",
        defaultBody: "{{unresolved}} mailed item(s) are held or deferred in the incoming receipt queue, the most the receipt mailbox holds. Today's mail run did not store {{refused}} more file(s) from unknown or unverified senders, or from members over their daily upload limit; they stay in the mailbox only. Receipts from members within their limit are still read. Resolve or release queued items to resume holding. {{actionLink}}",
    },
    "finance.incomePostCap": {
        allowedTokens: { created: text, limit: text, remaining: text, actionLink: link("Open income reconciliation") },
        sampleCtx: { created: "25", limit: "number of deposits", remaining: "3", actionLink: SAMPLE_URL },
        defaultSubject: "Income: deposit creation stopped at its per-run cap",
        defaultBody: "Today's income run created {{created}} QuickBooks deposit(s) and stopped at its per-run {{limit}} cap; {{remaining}} payout(s) are still waiting. Nothing else was posted. {{actionLink}}",
    },

    "finance.receiptMailAgeing": {
        // since: ", the oldest received <date>", or empty when the date is unknown.
        allowedTokens: { messages: text, since: text, actionLink: link("Open the incoming receipt queue") },
        sampleCtx: { messages: "6", since: ", the oldest received Sat, 07 Mar 2026 10:05:00 GMT", actionLink: SAMPLE_URL },
        defaultSubject: "Receipts: mailed receipts are about to be missed",
        defaultBody: "Mail runs did not finish reading {{messages}} message(s) in the receipt mailbox{{since}}. They have left the 3-day reading window or will before the next run, so no receipt will be made from them. Open the receipt mailbox in Gmail and upload or forward them again. {{actionLink}}",
    },
    "finance.receiptMailboxUnreadable": {
        allowedTokens: { actionLink: link("Open the incoming receipt queue") },
        sampleCtx: { actionLink: SAMPLE_URL },
        defaultSubject: "Receipts: the receipt mailbox could not be read",
        defaultBody: "Today's mail run could not list the receipt mailbox, so no mailed receipt was read. Mail leaves the 3-day reading window unread while this lasts, and no receipt will be made from it. Have the mailbox's Gmail access checked, then upload or forward anything that was missed. {{actionLink}}",
    },
    "finance.incomeBucketUnusable": {
        allowedTokens: { bucketName: text, issue: text, itemCount: text, actionLink: link("Open income items") },
        sampleCtx: { bucketName: "Robotics", issue: "is archived", itemCount: "4", actionLink: SAMPLE_URL },
        defaultSubject: "Income: a budget-owner bucket can't take sales",
        defaultBody: "The budget-owner bucket {{bucketName}} {{issue}}. {{itemCount}} store item(s) are assigned to it, and payouts with their sales wait until you restore the bucket or its Class, or reassign the items. {{actionLink}}",
    },
    "finance.incomeSweepIncomplete": {
        allowedTokens: { since: text, actionLink: link("Open income reconciliation") },
        sampleCtx: { since: "2026-10-01", actionLink: SAMPLE_URL },
        defaultSubject: "Income: the daily check for stray QuickBooks deposits could not see them all",
        defaultBody: "QuickBooks returned more deposits created since {{since}} than the daily check reads at once, so a deposit the app created may sit in QuickBooks unlinked. Check recent deposits that carry a checkin key in their memo. {{actionLink}}",
    },
    "finance.expensePaymentAccount": {
        // accountKind: "a <type> account", or "not in QuickBooks".
        allowedTokens: { accountId: text, accountKind: text, actionLink: link("Open the books map") },
        sampleCtx: { accountId: "35", accountKind: "a Expense account", actionLink: SAMPLE_URL },
        defaultSubject: "Expenses: QuickBooks posting is off until the payment account is fixed",
        defaultBody: "The books map's \"Organisation card\" account (QuickBooks id {{accountId}}) is {{accountKind}}. Expenses post only from a Bank or Credit Card account, so none are posting. {{actionLink}}",
    },
    "finance.expenseSweepIncomplete": {
        allowedTokens: { since: text, actionLink: link("Open expenses") },
        sampleCtx: { since: "2026-10-01", actionLink: SAMPLE_URL },
        defaultSubject: "Expenses: the daily check for stray QuickBooks entries could not see them all",
        defaultBody: "QuickBooks returned more purchases or bills created since {{since}} than the daily check reads at once, so an entry the app created may sit in QuickBooks unlinked. Check recent purchases and bills that carry a checkin key in their memo. {{actionLink}}",
    },
    "finance.inKindSweepIncomplete": {
        allowedTokens: { since: text, actionLink: link("Open the in-kind queue") },
        sampleCtx: { since: "2026-10-01", actionLink: SAMPLE_URL },
        defaultSubject: "Gifts of goods: the daily check for stray QuickBooks journal entries could not see them all",
        defaultBody: "QuickBooks returned more journal entries created since {{since}} than the daily check reads at once, so a journal entry the app created for a gift of goods may sit in QuickBooks unlinked. Check recent journal entries that carry a checkin key in their memo. {{actionLink}}",
    },

    // ── receipt ─────────────────────────────────────────────────────────────
    "receipt.mailReplyCredited": {
        // from: "you emailed", or "emailed from <address>" when another address sent it.
        allowedTokens: { creditedName: text, from: text, when: text, actionLink: link("Review it in My receipts") },
        sampleCtx: { creditedName: "Alex Rivera", from: "you emailed", when: "March 7, 2026", actionLink: SAMPLE_URL },
        defaultSubject: "Receipt received",
        defaultBody: "Hi {{creditedName}}, a receipt {{from}} on {{when}} is now in your receipts, credited to you. {{actionLink}}.\n\nNot yours? Discard it there, and reply to this message to tell us.",
    },
    "receipt.mailReplySender": {
        allowedTokens: { when: text, creditedName: text },
        sampleCtx: { when: "March 7, 2026", creditedName: "Alex Rivera" },
        defaultSubject: "Receipt received",
        defaultBody: "We received the receipt you emailed on {{when}}. It is credited to {{creditedName}}, who reviews it.\n\nIf you did not send this email, reply to this message and tell us.",
    },

    // The refused files are listed after this text by the sender, whatever the Board saves here.
    "receipt.mailRefused": {
        allowedTokens: { when: text },
        sampleCtx: { when: "March 7, 2026" },
        defaultSubject: "Receipt not accepted",
        defaultBody: "We read the email you sent to the receipt mailbox on {{when}}.",
    },

    // ── shopify ─────────────────────────────────────────────────────────────
    "shopify.error": {
        allowedTokens: { intro: text, errorDetail: text },
        sampleCtx: { intro: "An error occurred in the Shopify integration while creating the variant for program: Robotics Club.", errorDetail: "Shopify API returned 422: Variant price is invalid" },
        defaultSubject: "Shopify Integration Error",
        defaultBody: "{{intro}}\n\nError details:\n\n{{errorDetail}}",
    },

    // ── trustedAdult ────────────────────────────────────────────────────────
    "trustedAdult.boardReview": {
        allowedTokens: { actionLink: link("Review it") },
        sampleCtx: { actionLink: SAMPLE_URL },
        defaultSubject: "Trusted adult: a disclosure needs board review",
        defaultBody: "A trusted-adult disclosure is awaiting board review. {{actionLink}}.",
    },
    "trustedAdult.requestInfo": {
        allowedTokens: { note: text, actionLink: link("View your trusted adults") },
        sampleCtx: { note: "Please add a phone number for this adult.", actionLink: SAMPLE_URL },
        defaultSubject: "The board needs more information about a trusted adult",
        defaultBody: "{{note}}\n\n{{actionLink}}.",
    },
    "trustedAdult.deniedRevoked": {
        allowedTokens: { adultName: text, actionLink: link("View your trusted adults") },
        sampleCtx: { adultName: "Pat Morgan", actionLink: SAMPLE_URL },
        defaultSubject: "Trusted adult no longer authorized: {{adultName}}",
        defaultBody: "The board did not approve {{adultName}}, and any prior approval has been revoked. They are no longer authorized at the front desk. You may submit a new request if things change.\n\n{{actionLink}}.",
    },
    "trustedAdult.changeNotApproved": {
        // until: " (valid until YYYY-MM-DD)", or empty when the approval has no end date.
        allowedTokens: { adultName: text, until: text, actionLink: link("View your trusted adults") },
        sampleCtx: { adultName: "Pat Morgan", until: " (valid until 2027-06-30)", actionLink: SAMPLE_URL },
        defaultSubject: "Trusted adult change not approved: {{adultName}}",
        defaultBody: "The board did not approve your recent change to {{adultName}}. The previously approved arrangement{{until}} remains in effect. You can submit a new change any time.\n\n{{actionLink}}.",
    },
    "trustedAdult.notApproved": {
        allowedTokens: { adultName: text, actionLink: link("View your trusted adults") },
        sampleCtx: { adultName: "Pat Morgan", actionLink: SAMPLE_URL },
        defaultSubject: "Trusted adult not approved: {{adultName}}",
        defaultBody: "The board did not approve {{adultName}}. You may submit a new request if things change.\n\n{{actionLink}}.",
    },
    "trustedAdult.overrideDecided": {
        allowedTokens: { adultName: text, action: text, actionLink: link("View your trusted adults") },
        sampleCtx: { adultName: "Pat Morgan", action: "revoked", actionLink: SAMPLE_URL },
        defaultSubject: "Trusted adult no longer authorized: {{adultName}}",
        defaultBody: "The board has {{action}} {{adultName}}. They are no longer authorized at the front desk. You may submit a new request if things change.\n\n{{actionLink}}.",
    },
    "trustedAdult.expiring": {
        allowedTokens: { deadline: text, actionLink: link("View your trusted adults") },
        sampleCtx: { deadline: "2027-06-30", actionLink: SAMPLE_URL },
        defaultSubject: "A trusted adult approval is expiring soon",
        defaultBody: "This board-approved trusted adult expires on {{deadline}}. You can resubmit it for board review in one click — no need to re-enter anything.\n\n{{actionLink}}.",
    },
    "trustedAdult.expired": {
        allowedTokens: { adultName: text, actionLink: link("View your trusted adults") },
        sampleCtx: { adultName: "Pat Morgan", actionLink: SAMPLE_URL },
        defaultSubject: "Trusted adult approval expired: {{adultName}}",
        defaultBody: "The board's approval of {{adultName}} has expired. They are no longer authorized at the front desk. You can resubmit them for board review in one click — no need to re-enter anything.\n\n{{actionLink}}.",
    },

    // ── scholarship ─────────────────────────────────────────────────────────
    "scholarship.membershipReview": {
        allowedTokens: { householdId: text, requestKind: text, actionLink: link() },
        sampleCtx: { householdId: "42", requestKind: "Payment plan", actionLink: SAMPLE_URL },
        defaultSubject: "New membership scholarship / payment-plan request (household {{householdId}})",
        defaultBody: "The Scholarship Review Team has a new membership scholarship / payment-plan request to review.\n\n"
            + "What they asked for: {{requestKind}}\n\n"
            + "Review it here: {{actionLink}}",
    },
    "scholarship.programReview": {
        allowedTokens: { personName: text, programName: text, requestKind: text, actionLink: link() },
        sampleCtx: { personName: "Alex Rivera", programName: "Robotics Club", requestKind: "Payment plan", actionLink: SAMPLE_URL },
        defaultSubject: "New scholarship / payment-plan request: {{personName}} — {{programName}}",
        defaultBody: "The Scholarship Review Team has a new request to review.\n\n"
            + "{{personName}} requested a scholarship / payment plan for {{programName}}.\n\n"
            + "What they asked for: {{requestKind}}\n\n"
            + "Review it here: {{actionLink}}",
    },
    "scholarship.ackMembership": {
        allowedTokens: {},
        sampleCtx: {},
        defaultSubject: DEFAULT_ACK_SUBJECT,
        defaultBody: DEFAULT_ACK_MEMBERSHIP_BODY,
    },
    "scholarship.ackProgram": {
        allowedTokens: { programName: text },
        sampleCtx: { programName: "Robotics Club" },
        defaultSubject: DEFAULT_ACK_SUBJECT,
        defaultBody: DEFAULT_ACK_PROGRAM_BODY,
    },
    "scholarship.ackProgramHoldFailed": {
        allowedTokens: {},
        sampleCtx: {},
        defaultSubject: DEFAULT_ACK_SUBJECT,
        defaultBody: "Your scholarship / payment-plan request has been recorded and the board notified. A seat-reservation step needs a board member to finish it — nothing more is required from you.",
    },
} satisfies Record<string, TemplateSpec>;

export type TemplateKey = keyof typeof REGISTRY;

/** The values a key's body and subject take: every allowed token, as a string. */
export type TemplateCtx<K extends TemplateKey> = Record<keyof (typeof REGISTRY)[K]["allowedTokens"], string>;
