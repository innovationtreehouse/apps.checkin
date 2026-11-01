/**
 * OrgMembershipProcess lifecycle — ONE declarative definition.
 *
 * This module instances the
 * dependency-free primitives in `@/lib/lifecycle` for the membership machine:
 * the states, the transition-set predicates (as StateSets that emit BOTH a
 * client-safe `has` and a server Prisma `where` from one source), the
 * transition table, and classify/validate. It is a DEFINITION layer only — it
 * never executes a transition. Postgres stays the runtime authority; every
 * `FOR UPDATE` lock, conditional `updateMany`, and partial-unique-index +
 * P2002 catch stays at its own site and is merely *fed* the status set it names.
 *
 * Client-safe — pages import this file, and a Prisma value here would pull the
 * generated client into a page bundle. `no-restricted-imports` in
 * `eslint.config.mjs` allows `@/generated/prisma` only as `import type`.
 * Predicates therefore take booleans, not `Date | null`; the `where` fragments
 * are plain object literals typed via the generic; enum parity is compile-time
 * here and value-based only in the test.
 */
import type { Prisma, OrgMembershipProcessStatus, OrgMembershipProcessKind } from "@/generated/prisma/client";
import {
    type StateSet,
    defineStateSet,
    fromStatusWhere,
    assertNever,
    defineValidator,
    type Invariant,
    isLegalTransition as baseIsLegalTransition,
    type Transition,
    type Expect,
    type Equal,
} from "@/lib/lifecycle";

// ── Status / kind universe (local literal unions, checked against Prisma) ──────

export type ProcessStatus =
    | "INTAKE"
    | "PENDING_EXTERNAL_ACTION"
    | "PENDING_BG_REVIEW"
    | "PENDING_PAYMENT"
    | "PENDING_BG_CLEARANCE"
    | "ACTIVE"
    | "BLOCKED"
    | "PENDING_RENEWAL"
    | "RENEWAL_PENDING_BG"
    | "ARCHIVED";

export type ProcessKind = "INITIAL" | "RENEWAL" | "PERSON_BG" | "PERSON_AGREEMENT" | "KEY_VOLUNTEER_AGREEMENT";

// Compile-time parity: these fail to compile if the schema enum drifts from the
// local union. `import type` keeps the enum out of the client bundle; the
// TEST does the value-based `assertEnumParity` counterpart.
// Type-only assertions — intentionally unreferenced; their value IS the compile check.
/* eslint-disable @typescript-eslint/no-unused-vars */
type _StatusParity = Expect<Equal<ProcessStatus, OrgMembershipProcessStatus>>;
type _KindParity = Expect<Equal<ProcessKind, OrgMembershipProcessKind>>;
/* eslint-enable @typescript-eslint/no-unused-vars */

/** Presence of the four parallel-track nullable timestamps, as booleans (client-safe). */
export type ProcessFlags = {
    contractSignedAt: boolean;
    bgConsentAt: boolean;
    bgClearedAt: boolean;
    paidAt: boolean;
};

type Where = Prisma.OrgMembershipProcessWhereInput;

// ── Legacy tag ──────────────────────────────────────────────────────────────────────────────────
// RENEWAL_PENDING_BG is dead-but-guarded: nothing writes it, but
// surviving rows are still read/guarded and it stays in the renewal
// in-flight index. Kept explicit here instead of quietly appearing in six lists.
export const LEGACY_STATUSES: readonly ProcessStatus[] = ["RENEWAL_PENDING_BG"];

// ── In-flight sets: ONE source per kind ───────────────────────────────
// Feeds the conditional `updateMany`/`findFirst` guards AND the index-parity test
// (each partial unique index's `WHERE status IN (…)` must equal these). Callers
// spread `[...IN_FLIGHT_*]` where Prisma's `in` wants a mutable array.

/** INITIAL still-open statuses. Matches `membership_one_inflight_initial`. */
export const IN_FLIGHT_INITIAL: readonly ProcessStatus[] = [
    "INTAKE",
    "PENDING_EXTERNAL_ACTION",
    "PENDING_BG_REVIEW",
    "PENDING_PAYMENT",
    "PENDING_BG_CLEARANCE",
];

/**
 * RENEWAL still-open statuses — includes the request-flow states and the legacy
 * RENEWAL_PENDING_BG. Matches `membership_one_inflight_renewal`.
 * BLOCKED is deliberately out (a blocked renewal is the
 * board's to resolve).
 */
export const IN_FLIGHT_RENEWAL: readonly ProcessStatus[] = [
    "PENDING_RENEWAL",
    "PENDING_EXTERNAL_ACTION",
    "PENDING_BG_REVIEW",
    "PENDING_PAYMENT",
    "PENDING_BG_CLEARANCE",
    "RENEWAL_PENDING_BG",
];

/**
 * A PERSON_BG obligation still outstanding for its subject: awaiting review, or
 * BLOCKED (a manual follow-up the board owns, never auto-reopened). NOT a
 * transition from-state — the PERSON_BG entry edge is ∅→PENDING_BG_REVIEW — so it
 * stays an existence set rather than going through `fromWhere`.
 *
 * ONE definition because two sites must agree on it: `openPersonBg`'s
 * create-idempotency guard, and the person merge's duplicate resolution. If they
 * disagreed, a status the merge didn't count as open would let a survivor end up
 * owing two concurrent 2-of-N reviews.
 */
export const personBgOpen = defineStateSet<Where>()({
    statuses: ["PENDING_BG_REVIEW", "BLOCKED"],
});

/**
 * Not yet finished or closed — every status but ACTIVE and ARCHIVED. BLOCKED counts:
 * it waits on the board. Reopen reads it to keep one open application per household
 * (and one open person-scoped item per subject).
 */
export const openProcess = defineStateSet<Where>()({
    statuses: [
        "INTAKE",
        "PENDING_EXTERNAL_ACTION",
        "PENDING_BG_REVIEW",
        "PENDING_PAYMENT",
        "PENDING_BG_CLEARANCE",
        "BLOCKED",
        "PENDING_RENEWAL",
        "RENEWAL_PENDING_BG",
    ],
});

// ── awaiting BG review ────────────────────────────────────────────────
// The review queue's "awaiting a background check" rule, from one source. Not a
// single defineStateSet: it's an OR of two sub-rules, both requiring
// bgClearedAt=null. The two status arrays below are that one source; `has` and
// `where` both derive from them, and lifecycle.test asserts them equal on a
// status × flags matrix.
const BG_REVIEW_STATES = ["PENDING_BG_REVIEW", "RENEWAL_PENDING_BG"] as const;
const PARALLEL_BG_STATES = ["PENDING_PAYMENT", "PENDING_BG_CLEARANCE"] as const;

type AwaitingBgRow = { status: ProcessStatus; bgConsentAt: boolean; bgClearedAt: boolean };

/**
 * A process is awaiting background-check review when it hasn't cleared and is past
 * consent: the (legacy/renewal) review states unconditionally, or the INITIAL
 * parallel states once consent is recorded. `.has` for client + in-tx predicate,
 * `.where` for the reviewer-queue queries.
 *
 * NOTE — the ONE hand-authored StateSet: `has` and `where` are written SEPARATELY
 * here (this is an OR of two sub-rules, so it does NOT go through `defineStateSet`,
 * which mechanically derives one from the other). Their equivalence is therefore
 * NOT structurally guaranteed — it rests ENTIRELY on the parity test in
 * lifecycle.test.ts, which asserts `has` ≡ `where` across the FULL
 * status × {bgConsentAt, bgClearedAt} matrix. That matrix must stay exhaustive; do
 * not re-shape this into `defineStateSet` unless the OR is proven exactly equivalent.
 */
export const awaitingBgReview: StateSet<AwaitingBgRow, Where> = {
    statuses: [...BG_REVIEW_STATES, ...PARALLEL_BG_STATES],
    has: (row) => {
        if (row.bgClearedAt) return false;
        if ((BG_REVIEW_STATES as readonly string[]).includes(row.status)) return true;
        if ((PARALLEL_BG_STATES as readonly string[]).includes(row.status) && row.bgConsentAt) return true;
        return false;
    },
    where: {
        bgClearedAt: null,
        OR: [
            { status: { in: [...BG_REVIEW_STATES] } },
            { status: { in: [...PARALLEL_BG_STATES] }, bgConsentAt: { not: null } },
        ],
    },
};

// ── membership fee settled, background check outstanding ────────────────

/**
 * The membership fee is paid in full, waiting on the board's background-check clearance. PROGRAM
 * ACCESS reads this set: a household here gets the member rate and sees
 * members-only programs even though its membership is not ACTIVE yet —
 * see lib/orgMembership.ts's MEMBERSHIP_FEE_SETTLED_PERSON_WHERE. It is NOT an answer to
 * "is this a member"; ACTIVE stays that answer for every other benefit and every
 * member-only audience.
 *
 * `paidAt` is redundant with the status today (activate() is the only writer and
 * always stamps it) and is asserted anyway — the money question must not rest on
 * a status invariant holding for a row some future path writes differently.
 */
export const membershipFeeSettledAwaitingBg = defineStateSet<Where>()({
    statuses: ["PENDING_BG_CLEARANCE"],
    flags: { paidAt: true },
});

// ── renewal grantability & settled-this-cycle ────────────────

/**
 * The "this renewal is payable now" set the coming-year grant derives from:
 * a RENEWAL at PENDING_PAYMENT — full stop. NOT gated on bgClearedAt: the
 * grant comps PAYMENT ONLY and the background-check gate stays independent, so a
 * parallel-track renewal (paid ahead of BG, bgClearedAt null) is grantable and
 * settles to PENDING_BG_CLEARANCE, while a cleared one settles to ACTIVE — activate()
 * makes that split, BG is never bypassed. Both the list route's `renewalGrantable`
 * probe and `grantRenewalPayment`'s row lookup use this ONE fragment; the COI check
 * inside certifyPaymentPlan stays on top for every actor.
 */
export const grantableRenewalWhere: Where = {
    kind: "RENEWAL",
    status: "PENDING_PAYMENT",
};

/**
 * "Settled for the live membership year" — the MONEY question: a process whose
 * membership fee is paid: terminal ACTIVE, or paid and only waiting on background
 * clearance ({@link membershipFeeSettledAwaitingBg}) — stamped on or after the live
 * cycle's `settledSince` (membershipYearCycle), INITIAL and RENEWAL alike,
 * because a family that joins during the window buys the coming year exactly as
 * a renewer does (docs/rules/membership.md). ARCHIVED (a closed application) is
 * deliberately absent: only unpaid applications can be closed, so it must not
 * extend a horizon. Read by the households valid-until,
 * membershipValidThrough and the outreach audiences.
 * KNOWN LIMIT: settlement time is stageEnteredAt (stage completion), so a
 * pre-window payment whose review clears in-window reads as coming-year.
 */
export const settledThisCycleWhere = (settledSince: Date): Where => ({
    OR: [{ status: "ACTIVE" }, membershipFeeSettledAwaitingBg.where],
    stageEnteredAt: { gte: settledSince },
});

/**
 * "Nothing more to open this cycle" — the SWEEP question: settled as above, OR
 * ARCHIVED in-window — the board already closed this cycle's application, and
 * opening another would pester a family it just closed out. Only
 * runRenewalSweep's skip-test reads this wider set; money horizons never do.
 */
export const handledThisCycleWhere = (windowStart: Date): Where => ({
    status: { in: ["ACTIVE", "ARCHIVED"] },
    stageEnteredAt: { gte: windowStart },
});

// ── fromWhere — the CAS from-state clause ──────────────────────────────────────

/**
 * Emit the `status` clause a CAS transition guard names for its from-state. For this
 * machine the from-state name IS the status, so the emit is direct — the value is what
 * closes the drift gap: a status rename/split changes the enum (compile-caught
 * by the union-parity line) and this one emitter, and every guard that spreads
 * `...fromWhere(<status>)` moves with it, instead of ~6 hand-written `status:` literals
 * desyncing silently from the TRANSITIONS table.
 *
 * Status only: the guard keeps its transition-specific clauses (`contractSignedAt`,
 * the BG-consent `OR`, `isPaymentPlanRequested`) literal — not statuses, don't drift,
 * and several guards check a strict subset of the from-state. The scalar shape matches
 * the guards' hand-written `status: "X"`, so the query is the same either way.
 */
export function fromWhere(from: ProcessStatus): Where {
    return fromStatusWhere<Where>([from]);
}

// ── classify / validate ──────────────────────────────────────────────────────

/**
 * Row shape classify/validate read — all four flags as booleans, no Prisma. `kind`
 * is part of the row because the machine's own edges are kind-specific: a
 * PERSON_AGREEMENT reaches ACTIVE on the signature alone, so "what is legal here"
 * has no kind-free answer.
 */
export type ClassifyRow = { status: ProcessStatus; kind: ProcessKind } & ProcessFlags;

/** The kinds that reach ACTIVE on a signature, owing no clearance stamp. An
 *  exemption list, not an allowlist: a kind added later owes the stamp by default. */
const SETTLES_ON_SIGNATURE: readonly ProcessKind[] = ["PERSON_AGREEMENT", "KEY_VOLUNTEER_AGREEMENT"];

/**
 * Name a row's lifecycle state, or null when it's off-diagram. Total over the
 * status enum (exhaustive switch → assertNever): adding a status fails to compile
 * until it's handled. The named state is the status itself; the off-diagram cases
 * are impossible flag combinations a stranded/legacy row could carry.
 */
export function classify(row: ClassifyRow): ProcessStatus | null {
    switch (row.status) {
        case "INTAKE":
            // Payment cannot precede the external step — a paid INTAKE row is off-diagram.
            return row.paidAt ? null : "INTAKE";
        case "ACTIVE":
            // Convergence stamps bgClearedAt before flipping ACTIVE (payment.ts / review.ts).
            // A per-person agreement has no convergence to stamp — see SETTLES_ON_SIGNATURE.
            return row.bgClearedAt || SETTLES_ON_SIGNATURE.includes(row.kind) ? "ACTIVE" : null;
        case "PENDING_EXTERNAL_ACTION":
            return "PENDING_EXTERNAL_ACTION";
        case "PENDING_BG_REVIEW":
            return "PENDING_BG_REVIEW";
        case "PENDING_PAYMENT":
            return "PENDING_PAYMENT";
        case "PENDING_BG_CLEARANCE":
            return "PENDING_BG_CLEARANCE";
        case "BLOCKED":
            return "BLOCKED";
        case "PENDING_RENEWAL":
            return "PENDING_RENEWAL";
        case "RENEWAL_PENDING_BG":
            return "RENEWAL_PENDING_BG";
        case "ARCHIVED":
            return "ARCHIVED";
        default:
            return assertNever(row.status);
    }
}

/** Named invariants illegal tuples violate — the reconciler's future detection oracle. */
export const INVARIANTS: readonly Invariant<ClassifyRow>[] = [
    // Payment is stamped no earlier than PENDING_PAYMENT; INTAKE is pre-external.
    { name: "intake-is-unpaid", holds: (r) => r.status !== "INTAKE" || !r.paidAt },
    // ACTIVE is only reached through the two-track convergence, which stamps bgClearedAt —
    // for the kinds that HAVE one. markContractSigned settles a per-person agreement outright
    // (the kind-tagged PENDING_EXTERNAL_ACTION→ACTIVE edge below), owing no clearance.
    { name: "active-is-bg-cleared", holds: (r) => r.status !== "ACTIVE" || SETTLES_ON_SIGNATURE.includes(r.kind) || r.bgClearedAt },
];

export const validate = defineValidator(INVARIANTS);

// ── transition table — documentation + test oracle, never executed ────────────────────────────────

/** The origin pseudo-state for entry transitions (∅). */
export type OriginState = "∅";
type TState = ProcessStatus | OriginState;

/**
 * What "Close application" (archiveApplication) accepts: the long-idle, unpaid
 * steps. It also requires `paidAt` null. BLOCKED, PENDING_BG_CLEARANCE and ACTIVE
 * are not closable here — closing would erase a rejection or hide money. Only a
 * board restore closes a BLOCKED one (`RESTORE_CLOSABLE_STATUSES`).
 */
export const ARCHIVABLE_STATUSES = [
    "INTAKE",
    "PENDING_EXTERNAL_ACTION",
    "PENDING_BG_REVIEW",
    "PENDING_PAYMENT",
    "PENDING_RENEWAL",
] as const satisfies readonly ProcessStatus[];

/**
 * What a board restore of a DENIED household closes, unpaid only: the family starts
 * over, so a BLOCKED application closes too (its rejection stays in the audit row).
 */
export const RESTORE_CLOSABLE_STATUSES = [...ARCHIVABLE_STATUSES, "BLOCKED"] as const satisfies readonly ProcessStatus[];

/**
 * Steps a row closed before the unpaid-only rule may still hold in
 * `archivedFromStatus`. Reopening restores them (a BLOCKED row comes back blocked);
 * of these, only a board restore still closes a BLOCKED row.
 */
export const LEGACY_REOPEN_STATUSES = ["PENDING_BG_CLEARANCE", "BLOCKED"] as const satisfies readonly ProcessStatus[];

/**
 * The machine edges, each carrying the enforcement site
 * it feeds. Not a runtime executor — powers isLegalTransition + reachability in
 * tests/doc-artifacts. Flag-only stamps (contractSignedAt/bgConsentAt) are not
 * status edges and are omitted; they gate the advance, not a state change.
 */
export const TRANSITIONS: readonly Transition<TState, string, ProcessKind>[] = [
    // Entry
    { from: "∅", to: "INTAKE", event: "startIntake", actor: "applicant", guardSite: "intake.ts startIntake: OrgMembership FOR UPDATE (refuses DENIED/ACTIVE/BLOCKED/open renewal) + membership_one_inflight_initial + P2002", kind: "INITIAL" },
    { from: "∅", to: "PENDING_RENEWAL", event: "createRenewalProcess", actor: "board", guardSite: "renewal.ts createRenewalProcess: OrgMembership FOR UPDATE + membership_one_inflight_renewal + P2002", kind: "RENEWAL" },
    { from: "∅", to: "PENDING_BG_REVIEW", event: "personBgTriggers", actor: "system", guardSite: "personBgTriggers.ts openPersonBg: Person FOR UPDATE", kind: "PERSON_BG" },
    { from: "∅", to: "PENDING_EXTERNAL_ACTION", event: "personAgreementTriggers", actor: "system/board", guardSite: "personAgreementTriggers.ts openPersonAgreement: Person FOR UPDATE + handled-this-cycle guard", kind: "PERSON_AGREEMENT" },
    { from: "∅", to: "PENDING_EXTERNAL_ACTION", event: "openKvaIfNeeded", actor: "board", guardSite: "keyVolunteerProcess.ts openKvaIfNeeded (in setRoleFlag, under the BOARD role lock) / createKva (version bump)", kind: "KEY_VOLUNTEER_AGREEMENT" },
    // External step
    { from: "INTAKE", to: "PENDING_EXTERNAL_ACTION", event: "submitIntake", actor: "applicant", guardSite: "intake.ts submitIntake: updateMany CAS from INTAKE", kind: "INITIAL" },
    { from: "PENDING_RENEWAL", to: "PENDING_EXTERNAL_ACTION", event: "beginRenewal", actor: "member", guardSite: "renewal.ts beginRenewal: OrgMembership FOR UPDATE (refuses DENIED/BLOCKED) + updateMany CAS from PENDING_RENEWAL", kind: "RENEWAL" },
    // Advance
    { from: "PENDING_EXTERNAL_ACTION", to: "PENDING_PAYMENT", event: "advanceExternalIfComplete", actor: "system", guardSite: "external.ts advanceExternalIfComplete: updateMany CAS (signed + consent or cleared)" },
    // Signature completes a person-scoped agreement outright — no payment, no BG gate
    { from: "PENDING_EXTERNAL_ACTION", to: "ACTIVE", event: "markContractSigned", actor: "subject", guardSite: "external.ts markContractSigned: updateMany where contractSignedAt=null + fromWhere", kind: "PERSON_AGREEMENT" },
    { from: "PENDING_EXTERNAL_ACTION", to: "ACTIVE", event: "markContractSigned", actor: "subject/board", guardSite: "external.ts markContractSigned: updateMany where contractSignedAt=null + fromWhere", kind: "KEY_VOLUNTEER_AGREEMENT" },
    // Payment convergence
    { from: "PENDING_PAYMENT", to: "ACTIVE", event: "activate", actor: "shopify/board", guardSite: "payment.ts settle: process + OrgMembership FOR UPDATE, DENIED changes nothing (bgClearedAt set)" },
    { from: "PENDING_PAYMENT", to: "PENDING_BG_CLEARANCE", event: "activate", actor: "shopify/board", guardSite: "payment.ts settle: process + OrgMembership FOR UPDATE, DENIED changes nothing (not cleared)" },
    { from: "PENDING_PAYMENT", to: "ACTIVE", event: "grantRenewalPayment", actor: "board", guardSite: "renewal.ts grantRenewalPayment → certifyPaymentPlan (COI) → activate", kind: "RENEWAL" },
    // Clearance convergence
    { from: "PENDING_BG_REVIEW", to: "PENDING_PAYMENT", event: "clearBackgroundCheck", actor: "reviewer", guardSite: "review.ts attest → clearBackgroundCheck: OrgMembership FOR UPDATE (2nd APPROVE, unpaid legacy household row)", legacy: true },
    { from: "PENDING_BG_REVIEW", to: "ACTIVE", event: "clearBackgroundCheck", actor: "reviewer", guardSite: "review.ts attest → clearBackgroundCheck: process FOR UPDATE (2nd APPROVE, paid / PERSON_BG subject)" },
    { from: "PENDING_BG_CLEARANCE", to: "ACTIVE", event: "clearBackgroundCheck", actor: "reviewer", guardSite: "review.ts attest → clearBackgroundCheck: process FOR UPDATE (2nd APPROVE)" },
    // A refunded order holds a cleared, paid application for the board instead of activating it.
    { from: "PENDING_BG_REVIEW", to: "PENDING_BG_CLEARANCE", event: "clearBackgroundCheck", actor: "reviewer", guardSite: "review.ts attest → clearBackgroundCheck: process FOR UPDATE (2nd APPROVE, paid on a refunded order)", legacy: true },
    // Reject → BLOCKED
    { from: "PENDING_BG_REVIEW", to: "BLOCKED", event: "attest REJECT", actor: "reviewer", guardSite: "review.ts attest REJECT: process FOR UPDATE" },
    { from: "PENDING_PAYMENT", to: "BLOCKED", event: "attest REJECT", actor: "reviewer", guardSite: "review.ts attest REJECT: process FOR UPDATE (parallel review)" },
    { from: "PENDING_BG_CLEARANCE", to: "BLOCKED", event: "attest REJECT", actor: "reviewer", guardSite: "review.ts attest REJECT: process FOR UPDATE" },
    // Board reset and the rejector changing to approve:
    // both send a blocked review back for two approvals; nothing clears it from BLOCKED.
    { from: "BLOCKED", to: "PENDING_PAYMENT", event: "boardResetReview", actor: "board", guardSite: "review.ts boardResetReview: process FOR UPDATE + COI (unpaid)" },
    { from: "BLOCKED", to: "PENDING_BG_CLEARANCE", event: "boardResetReview", actor: "board", guardSite: "review.ts boardResetReview: process FOR UPDATE + COI (paid)" },
    { from: "BLOCKED", to: "PENDING_BG_REVIEW", event: "boardResetReview", actor: "board", guardSite: "review.ts boardResetReview: process FOR UPDATE + COI (PERSON_BG)", kind: "PERSON_BG" },
    { from: "BLOCKED", to: "PENDING_EXTERNAL_ACTION", event: "boardResetReview", actor: "board", guardSite: "review.ts boardResetReview: process FOR UPDATE + COI (RENEWAL, no consent)", kind: "RENEWAL", legacy: true },
    { from: "BLOCKED", to: "PENDING_PAYMENT", event: "attest change to APPROVE", actor: "reviewer", guardSite: "review.ts attest → switchRejectionToApprove: process FOR UPDATE + COI (unpaid)" },
    { from: "BLOCKED", to: "PENDING_BG_CLEARANCE", event: "attest change to APPROVE", actor: "reviewer", guardSite: "review.ts attest → switchRejectionToApprove: process FOR UPDATE + COI (paid)" },
    { from: "BLOCKED", to: "PENDING_BG_REVIEW", event: "attest change to APPROVE", actor: "reviewer", guardSite: "review.ts attest → switchRejectionToApprove: process FOR UPDATE + COI (PERSON_BG)", kind: "PERSON_BG" },
    { from: "BLOCKED", to: "PENDING_EXTERNAL_ACTION", event: "attest change to APPROVE", actor: "reviewer", guardSite: "review.ts attest → switchRejectionToApprove: process FOR UPDATE + COI (RENEWAL, no consent)", kind: "RENEWAL", legacy: true },
    // Refund recorded by the board: money undone, background check untouched. On a
    // paid BLOCKED row it only clears paidAt (flag-only, no status edge).
    { from: "PENDING_BG_CLEARANCE", to: "PENDING_PAYMENT", event: "recordRefund", actor: "board/sysadmin", guardSite: "refund.ts updateMany CAS (paidAt set) + COI" },
    // Close application — unpaid, long-idle steps only
    ...ARCHIVABLE_STATUSES.map(
        (from): Transition<TState, string, ProcessKind> => ({
            from,
            to: "ARCHIVED",
            event: "archiveApplication",
            actor: "board",
            guardSite: "archive.ts updateMany CAS (status read, paidAt null) + COI",
        }),
    ),
    // A board restore closes the denied household's unpaid applications, BLOCKED included.
    { from: "BLOCKED", to: "ARCHIVED", event: "closeForRestore", actor: "board", guardSite: "archive.ts closeForRestore: updateMany CAS (status read, paidAt null), in the restore transaction" },
    // Reopen — back to the step the close captured. ARCHIVED rests but is not sealed.
    ...ARCHIVABLE_STATUSES.map(
        (to): Transition<TState, string, ProcessKind> => ({
            from: "ARCHIVED",
            to,
            event: "unarchiveApplication",
            actor: "board",
            guardSite: "archive.ts updateMany CAS + OrgMembership FOR UPDATE + COI + P2002",
        }),
    ),
    ...LEGACY_REOPEN_STATUSES.map(
        (to): Transition<TState, string, ProcessKind> => ({
            from: "ARCHIVED",
            to,
            event: "unarchiveApplication",
            actor: "board",
            guardSite: "archive.ts (row closed before the unpaid-only rule)",
            legacy: true,
        }),
    ),
];

/** True if some declared edge matches from→to (optionally within `kind`). */
export function isLegalTransition(from: ProcessStatus, to: ProcessStatus, kind?: ProcessKind): boolean {
    return baseIsLegalTransition(TRANSITIONS, from, to, kind);
}

/** Entry states for reachability analysis (the ∅-edges' targets). */
export const INITIAL_STATES: readonly ProcessStatus[] = ["INTAKE", "PENDING_RENEWAL", "PENDING_BG_REVIEW"];

/** Every declared kind — the second axis of the exhaustive state-space test. */
export const ALL_KINDS: readonly ProcessKind[] = ["INITIAL", "RENEWAL", "PERSON_BG", "PERSON_AGREEMENT", "KEY_VOLUNTEER_AGREEMENT"];

/** Every declared status (for reachability's `unreachable` computation). */
export const ALL_STATUSES: readonly ProcessStatus[] = [
    "INTAKE",
    "PENDING_EXTERNAL_ACTION",
    "PENDING_BG_REVIEW",
    "PENDING_PAYMENT",
    "PENDING_BG_CLEARANCE",
    "ACTIVE",
    "BLOCKED",
    "PENDING_RENEWAL",
    "RENEWAL_PENDING_BG",
    "ARCHIVED",
];

/**
 * Every step `unarchiveApplication` restores to: what close accepts today, plus what
 * rows closed under the older, wider rule may hold — including the legacy
 * RENEWAL_PENDING_BG, which TRANSITIONS omits on purpose (lifecycle.test.ts pins it).
 */
export const RESTORABLE_STATUSES: ReadonlySet<ProcessStatus> = new Set(
    ALL_STATUSES.filter((s) => s !== "ACTIVE" && s !== "ARCHIVED"),
);

/**
 * Processes a Zoho completion webhook may land on: anything but a closed
 * (ARCHIVED) one, so an archived PERSON_AGREEMENT is never revived. BLOCKED is
 * still live — the board may reset it — so a signature arriving then still counts.
 */
export const zohoWebhookMatchable = defineStateSet<Where>()({
    statuses: ALL_STATUSES.filter((s) => s !== "ARCHIVED"),
});
