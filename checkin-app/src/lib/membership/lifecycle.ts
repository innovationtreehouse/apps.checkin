/**
 * OrgMembershipProcess lifecycle — ONE declarative definition (Phase 2b).
 *
 * This module instances the
 * dependency-free primitives in `@/lib/lifecycle` for the membership machine:
 * the states, the transition-set predicates (as StateSets that emit BOTH a
 * client-safe `has` and a server Prisma `where` from one source), the
 * transition table, and classify/validate. It is a DEFINITION layer only — it
 * never executes a transition. Postgres stays the runtime authority; every
 * `FOR UPDATE` lock, conditional `updateMany`, and partial-unique-index +
 * P2002 catch is unchanged and merely *fed* the status set it names.
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

export type ProcessKind = "INITIAL" | "RENEWAL" | "PERSON_BG" | "PERSON_AGREEMENT";

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
// RENEWAL_PENDING_BG is dead-but-guarded: nothing writes it since the 20260715
// migration, but surviving rows are still read/guarded and it stays in the renewal
// in-flight index. Kept explicit here instead of quietly appearing in six lists.
export const LEGACY_STATUSES: readonly ProcessStatus[] = ["RENEWAL_PENDING_BG"];

// ── In-flight sets (fix #2): ONE source per kind ───────────────────────────────
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
 * RENEWAL_PENDING_BG. Matches `membership_one_inflight_renewal` (widened by the
 * 20260715 migration). BLOCKED is deliberately out (a blocked renewal is the
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

// ── awaiting BG review (fix #1) ────────────────────────────────────────────────
// Encodes review.ts:75 / AWAITING_BG_WHERE:97 EXACTLY, from one source. Not a
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

// ── dues settled, background check outstanding ────────────────────────────────

/**
 * Dues paid in full, waiting on the board's background-check clearance. PROGRAM
 * ACCESS reads this set: a household here gets the member rate and sees
 * members-only programs even though its membership is not ACTIVE yet (#1397) —
 * see lib/orgMembership.ts's DUES_SETTLED_PERSON_WHERE. It is NOT an answer to
 * "is this a member"; ACTIVE stays that answer for every other benefit and every
 * member-only audience.
 *
 * `paidAt` is redundant with the status today (activate() is the only writer and
 * always stamps it) and is asserted anyway — the money question must not rest on
 * a status invariant holding for a row some future path writes differently.
 */
export const duesSettledAwaitingBg = defineStateSet<Where>()({
    statuses: ["PENDING_BG_CLEARANCE"],
    flags: { paidAt: true },
});

// ── renewal grantability (fix #3) & settled-this-cycle (fix #4) ────────────────

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
 * dues are paid — terminal ACTIVE, or paid and only waiting on background
 * clearance ({@link duesSettledAwaitingBg}) — stamped on or after the live
 * cycle's `settledSince` (membershipYearCycle), INITIAL and RENEWAL alike,
 * because a family that joins during the window buys the coming year exactly as
 * a renewer does (docs/rules/membership.md). ARCHIVED is deliberately absent:
 * archive refuses ACTIVE processes, so every ARCHIVED row never completed
 * payment and must not extend a horizon. Read by the households valid-until,
 * membershipValidThrough and the outreach audiences.
 * KNOWN LIMIT: settlement time is stageEnteredAt (stage completion), so a
 * pre-window payment whose review clears in-window reads as coming-year.
 */
export const settledThisCycleWhere = (settledSince: Date): Where => ({
    OR: [{ status: "ACTIVE" }, duesSettledAwaitingBg.where],
    stageEnteredAt: { gte: settledSince },
});

/**
 * "Nothing more to open this cycle" — the SWEEP question: settled as above, OR
 * ARCHIVED in-window — the board already closed this cycle's process, and
 * reopening would pester a family it just declined or archived. Only
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
 * closes the drift gap (#1080): a status rename/split changes the enum (compile-caught
 * by the union-parity line) and this one emitter, and every guard that spreads
 * `...fromWhere(<status>)` moves with it, instead of ~6 hand-written `status:` literals
 * desyncing silently from the TRANSITIONS table.
 *
 * Status only: the guard keeps its transition-specific clauses (`contractSignedAt`,
 * the BG-consent `OR`, `isPaymentPlanRequested`) literal — not statuses, don't drift,
 * and several guards check a strict subset of the from-state. The scalar shape matches
 * the guards' hand-written `status: "X"`, so the migrated query is byte-for-byte identical.
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

/** The one kind that reaches ACTIVE on a signature, owing no clearance stamp. An
 *  exemption list, not an allowlist: a kind added later owes the stamp by default. */
const SETTLES_ON_SIGNATURE: readonly ProcessKind[] = ["PERSON_AGREEMENT"];

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
            // A PERSON_AGREEMENT has no convergence to stamp — see SETTLES_ON_SIGNATURE.
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
    // for the kinds that HAVE one. markContractSigned settles a PERSON_AGREEMENT outright
    // (the kind-tagged PENDING_EXTERNAL_ACTION→ACTIVE edge below), owing no clearance.
    { name: "active-is-bg-cleared", holds: (r) => r.status !== "ACTIVE" || SETTLES_ON_SIGNATURE.includes(r.kind) || r.bgClearedAt },
];

export const validate = defineValidator(INVARIANTS);

// ── transition table — documentation + test oracle, never executed ────────────────────────────────

/** The origin pseudo-state for entry transitions (∅). */
export type OriginState = "∅";
type TState = ProcessStatus | OriginState;

/**
 * The archive edges this machine DECLARES (§5 #13). ACTIVE is never archivable.
 * RENEWAL_PENDING_BG is out because it is unreachable, so the diagram would gain a
 * dead pair of arrows and lose the unreachable report that surfaces it — but it is
 * NOT the archive gate: `archiveApplication` refuses ACTIVE and nothing else, so a
 * surviving legacy row IS archivable — that gate's set is RESTORABLE_STATUSES below,
 * and the test pins the one status by which the two differ.
 */
export const ARCHIVABLE_STATUSES = [
    "INTAKE",
    "PENDING_EXTERNAL_ACTION",
    "PENDING_BG_REVIEW",
    "PENDING_PAYMENT",
    "PENDING_BG_CLEARANCE",
    "PENDING_RENEWAL",
    "BLOCKED",
] as const satisfies readonly ProcessStatus[];

/**
 * The machine edges, each carrying the (unchanged) enforcement site
 * it feeds. Not a runtime executor — powers isLegalTransition + reachability in
 * tests/doc-artifacts. Flag-only stamps (contractSignedAt/bgConsentAt) are not
 * status edges and are omitted; they gate the advance, not a state change.
 */
export const TRANSITIONS: readonly Transition<TState, string, ProcessKind>[] = [
    // Entry (§5 #1,#2 + §4.4 PERSON_BG)
    { from: "∅", to: "INTAKE", event: "startIntake", actor: "applicant", guardSite: "intake.ts:154 FOR UPDATE + membership_one_inflight_initial + P2002", kind: "INITIAL" },
    { from: "∅", to: "PENDING_RENEWAL", event: "createRenewalProcess", actor: "cron/board", guardSite: "renewal.ts:243 FOR UPDATE + membership_one_inflight_renewal + P2002", kind: "RENEWAL" },
    { from: "∅", to: "PENDING_BG_REVIEW", event: "personBgTriggers", actor: "system", guardSite: "personBgTriggers", kind: "PERSON_BG" },
    { from: "∅", to: "PENDING_EXTERNAL_ACTION", event: "personAgreementTriggers", actor: "system/board", guardSite: "personAgreementTriggers FOR UPDATE + handled-this-cycle guard", kind: "PERSON_AGREEMENT" },
    // External step (§5 #3,#4)
    { from: "INTAKE", to: "PENDING_EXTERNAL_ACTION", event: "submitIntake", actor: "applicant", guardSite: "intake.ts:392", kind: "INITIAL" },
    { from: "PENDING_RENEWAL", to: "PENDING_EXTERNAL_ACTION", event: "beginRenewal", actor: "member", guardSite: "renewal.ts:219 updateMany where status=PENDING_RENEWAL", kind: "RENEWAL" },
    // Advance (§5 #7)
    { from: "PENDING_EXTERNAL_ACTION", to: "PENDING_PAYMENT", event: "advanceExternalIfComplete", actor: "system", guardSite: "external.ts:113 updateMany" },
    // Signature completes a person-scoped agreement outright — no payment, no BG gate
    { from: "PENDING_EXTERNAL_ACTION", to: "ACTIVE", event: "markContractSigned", actor: "subject", guardSite: "external.ts updateMany where contractSignedAt=null", kind: "PERSON_AGREEMENT" },
    // Payment convergence (§5 #8, #12)
    { from: "PENDING_PAYMENT", to: "ACTIVE", event: "activate", actor: "shopify/board", guardSite: "payment.ts:204 FOR UPDATE (bgClearedAt set)" },
    { from: "PENDING_PAYMENT", to: "PENDING_BG_CLEARANCE", event: "activate", actor: "shopify/board", guardSite: "payment.ts:204 FOR UPDATE (not cleared)" },
    { from: "PENDING_PAYMENT", to: "ACTIVE", event: "grantRenewalPayment", actor: "board/sysadmin", guardSite: "renewal.ts:339 → certifyPaymentPlan (COI) → activate", kind: "RENEWAL" },
    // Clearance convergence (§5 #10, #14)
    { from: "PENDING_BG_REVIEW", to: "PENDING_PAYMENT", event: "clearBackgroundCheck", actor: "reviewer", guardSite: "review.ts:256 FOR UPDATE (2nd APPROVE, unpaid legacy household row)", legacy: true },
    { from: "PENDING_BG_REVIEW", to: "ACTIVE", event: "clearBackgroundCheck", actor: "reviewer", guardSite: "review.ts:256/304 FOR UPDATE (2nd APPROVE, paid / PERSON_BG subject)" },
    { from: "PENDING_BG_CLEARANCE", to: "ACTIVE", event: "clearBackgroundCheck", actor: "reviewer", guardSite: "review.ts:326 FOR UPDATE (2nd APPROVE)" },
    // Reject → BLOCKED (§5 #9)
    { from: "PENDING_BG_REVIEW", to: "BLOCKED", event: "attest REJECT", actor: "reviewer", guardSite: "review.ts:247 FOR UPDATE" },
    { from: "PENDING_PAYMENT", to: "BLOCKED", event: "attest REJECT", actor: "reviewer", guardSite: "review.ts:247 FOR UPDATE (parallel review)" },
    { from: "PENDING_BG_CLEARANCE", to: "BLOCKED", event: "attest REJECT", actor: "reviewer", guardSite: "review.ts:247 FOR UPDATE" },
    // overrideBlocked reset/approve (§5 #11)
    { from: "BLOCKED", to: "PENDING_PAYMENT", event: "overrideBlocked reset", actor: "board/sysadmin", guardSite: "review.ts:368 (unpaid)" },
    { from: "BLOCKED", to: "PENDING_BG_CLEARANCE", event: "overrideBlocked reset", actor: "board/sysadmin", guardSite: "review.ts:368 (paid)" },
    { from: "BLOCKED", to: "PENDING_BG_REVIEW", event: "overrideBlocked reset", actor: "board/sysadmin", guardSite: "review.ts:368 (PERSON_BG)", kind: "PERSON_BG" },
    { from: "BLOCKED", to: "PENDING_EXTERNAL_ACTION", event: "overrideBlocked reset", actor: "board/sysadmin", guardSite: "review.ts:368 (RENEWAL, no consent)", kind: "RENEWAL", legacy: true },
    { from: "BLOCKED", to: "ACTIVE", event: "overrideBlocked approve", actor: "board/sysadmin", guardSite: "review.ts:411 FOR UPDATE (paid)" },
    // Archive (§5 #13) — every pre-terminal status
    ...ARCHIVABLE_STATUSES.map(
        (from): Transition<TState, string, ProcessKind> => ({
            from,
            to: "ARCHIVED",
            event: "archiveApplication",
            actor: "board",
            guardSite: "archive.ts:13 (status≠ACTIVE, idempotent)",
        }),
    ),
    // Unarchive (§5 #13 reversed) — back to the status the archive write captured.
    // ARCHIVED is where processes come to rest, but it is not sealed.
    ...ARCHIVABLE_STATUSES.map(
        (to): Transition<TState, string, ProcessKind> => ({
            from: "ARCHIVED",
            to,
            event: "unarchiveApplication",
            actor: "board",
            guardSite: "archive.ts:88 updateMany CAS + P2002",
        }),
    ),
];

/** True if some declared §5 edge matches from→to (optionally within `kind`). */
export function isLegalTransition(from: ProcessStatus, to: ProcessStatus, kind?: ProcessKind): boolean {
    return baseIsLegalTransition(TRANSITIONS, from, to, kind);
}

/** Entry states for reachability analysis (the ∅-edges' targets). */
export const INITIAL_STATES: readonly ProcessStatus[] = ["INTAKE", "PENDING_RENEWAL", "PENDING_BG_REVIEW"];

/** Every declared kind — the second axis of the exhaustive state-space test. */
export const ALL_KINDS: readonly ProcessKind[] = ["INITIAL", "RENEWAL", "PERSON_BG", "PERSON_AGREEMENT"];

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
 * What `archiveApplication` can actually capture — its gate is `status !== ACTIVE`
 * (ARCHIVED returns early) — and so the only targets `unarchiveApplication` restores
 * to. Wider than ARCHIVABLE_STATUSES by the legacy RENEWAL_PENDING_BG, which
 * TRANSITIONS omits on purpose; lifecycle.test.ts pins that gap so neither list moves
 * unnoticed and the restore set is no longer a second, unlinked list.
 */
export const RESTORABLE_STATUSES: ReadonlySet<ProcessStatus> = new Set(
    ALL_STATUSES.filter((s) => s !== "ACTIVE" && s !== "ARCHIVED"),
);
