/**
 * ProgramParticipant enrollment lifecycle — ONE declarative definition.
 *
 * Instances the `@/lib/lifecycle` primitives. This is the
 * DEFINITION/VALIDATION layer only — it emits the
 * `where`/predicate the existing compare-and-set guards already hand-write; it
 * never executes a transition. Postgres stays the runtime authority.
 *
 * Client-safe — a Prisma value here would pull the generated client into a page
 * bundle. `no-restricted-imports` in `eslint.config.mjs` allows
 * `@/generated/prisma` only as `import type`, so the status union is a local
 * string-literal type checked against the Prisma enum by a TYPE-ONLY parity line.
 */
import {
    defineStateSet,
    fromStatusWhere,
    assertNever,
    defineValidator,
    type Invariant,
    type Transition,
    type Expect,
    type Equal,
} from '@/lib/lifecycle';
import type { Prisma, ProgramParticipantStatus as PrismaStatus } from '@/generated/prisma/client';

/** Local status union — the trunk `status` column. `UNENROLLED` (∅/no row) is
 *  not a status value; it appears only in the transition table. */
export type ProgramParticipantStatus = 'PENDING' | 'ACTIVE';

// Parity: fails to compile if the schema enum and this union diverge (§3.4).
// The runtime twin (assertEnumParity) lives in the unit test.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _Parity = Expect<Equal<ProgramParticipantStatus, PrismaStatus>>;

type Where = Prisma.ProgramParticipantWhereInput;

/**
 * The row shape the client-safe predicates see: nullable timestamps collapsed to
 * PRESENCE booleans (§3.4 — keep `Date | null` out of the predicate). Map a DB
 * row with `toRow` below.
 */
export type EnrollmentRow = {
    status: ProgramParticipantStatus;
    inventoryHeldAt: boolean;
    isPaymentPlanRequested: boolean;
    paymentPlanDeniedAt: boolean;
};

/** Collapse a persisted row's nullable columns to the presence booleans the
 *  definition consumes. Client-safe (takes already-derived booleans is fine too). */
export function toRow(db: {
    status: ProgramParticipantStatus;
    inventoryHeldAt: Date | null;
    isPaymentPlanRequested: boolean;
    paymentPlanDeniedAt: Date | null;
}): EnrollmentRow {
    return {
        status: db.status,
        inventoryHeldAt: db.inventoryHeldAt !== null,
        isPaymentPlanRequested: db.isPaymentPlanRequested,
        paymentPlanDeniedAt: db.paymentPlanDeniedAt !== null,
    };
}

// ---- STATES (§3 table) ------------------------------------------------------
// held = inventoryHeldAt (nullable TIMESTAMP → `flags`/presence);
// req  = isPaymentPlanRequested (genuine BOOLEAN column → `equals`/value);
// den  = paymentPlanDeniedAt (nullable TIMESTAMP → `flags`/presence).

const mk = defineStateSet<Where>();

export const STATES = {
    /** PENDING, held=null, req=FALSE, den=null. Plain checkout, 7-day non-payment
     *  clock. `req=false` is what makes the sweep SKIP PENDING_HOLD_FAILED. */
    PENDING_UNPAID: mk({
        statuses: ['PENDING'] as const,
        flags: { inventoryHeldAt: false, paymentPlanDeniedAt: false },
        equals: { isPaymentPlanRequested: false },
    }),
    /** PENDING, held=null, req=TRUE, den=null. Apply-time −1 failed → no seat held;
     *  the board finishes it (reconciliation queue). NEVER auto-swept (req=true). */
    PENDING_HOLD_FAILED: mk({
        statuses: ['PENDING'] as const,
        flags: { inventoryHeldAt: false, paymentPlanDeniedAt: false },
        equals: { isPaymentPlanRequested: true },
    }),
    /** PENDING, held=set, req=TRUE, den=null. Applied, seat held, awaiting board. */
    PENDING_HELD: mk({
        statuses: ['PENDING'] as const,
        flags: { inventoryHeldAt: true, paymentPlanDeniedAt: false },
        equals: { isPaymentPlanRequested: true },
    }),
    /** PENDING, held=set, req=FALSE, den=set. Denied, seat still held, grace clock. */
    PENDING_HELD_DENIED: mk({
        statuses: ['PENDING'] as const,
        flags: { inventoryHeldAt: true, paymentPlanDeniedAt: true },
        equals: { isPaymentPlanRequested: false },
    }),
    /** ACTIVE, held=null. req/den are vestigial don't-cares once ACTIVE (§3 note);
     *  the validator asserts only held=null (I1). */
    ACTIVE: mk({
        statuses: ['ACTIVE'] as const,
        flags: { inventoryHeldAt: false },
    }),
} as const;

// ---- fromWhere (§5 CAS from-state, #1080) -----------------------------------

/** The named present-row states — the keys of STATES, i.e. every state a CAS
 *  guard can transition FROM. */
export type FromStateName = keyof typeof STATES;

/**
 * Emit the `status` clause a CAS transition guard names for its from-state, sourced
 * from STATES so a status rename/split flows into every guard that spreads it
 * (#1080). All enrollment PENDING_* states share `status:'PENDING'`; ACTIVE is its
 * own status — the scalar shape matches what the guards hand-write, so the migrated
 * query is byte-for-byte identical.
 *
 * It emits ONLY the status: the guard keeps its transition-specific flag narrowing
 * (`inventoryHeldAt`, `isPaymentPlanRequested`, `paymentPlanDeniedAt`) literal — those
 * are not statuses and don't drift on a status rename, and several guards check a
 * strict SUBSET of the from-state's defining flags (e.g. T4 activate checks only
 * `status`; T5 approve keeps `isPaymentPlanRequested`), so over-emitting them would
 * over-constrain the CAS. Never includes the transition's mutation (that lives in `data`).
 */
export function fromWhere(from: FromStateName): Where {
    return fromStatusWhere<Where>(STATES[from].statuses);
}

// ---- classify (§3 table, total switch) --------------------------------------

/** The named present-row states (UNENROLLED is the no-row state, so `classify`
 *  never returns it — it only sees existing rows). */
export type EnrollmentStateName =
    | 'PENDING_UNPAID'
    | 'PENDING_HOLD_FAILED'
    | 'PENDING_HELD'
    | 'PENDING_HELD_DENIED'
    | 'ACTIVE';

/**
 * Name the row's legal state, or `null` if it is off-diagram (an I1–I4 violation,
 * i.e. crash-window corruption or a future bug). Total over the status union:
 * adding a status value fails to compile until handled (assertNever default).
 */
export function classify(row: EnrollmentRow): EnrollmentStateName | null {
    switch (row.status) {
        case 'ACTIVE':
            // I1: ACTIVE ⟹ held null. A held seat on an ACTIVE row is off-diagram.
            return row.inventoryHeldAt ? null : 'ACTIVE';
        case 'PENDING':
            if (!row.inventoryHeldAt) {
                // held=null: I4 — a denial is only ever stamped on a held seat.
                if (row.paymentPlanDeniedAt) return null;
                // `req` is the discriminator between the two held=null states.
                return row.isPaymentPlanRequested ? 'PENDING_HOLD_FAILED' : 'PENDING_UNPAID';
            }
            // held=set: I3 — exactly one of {req∧¬den} (awaiting) or {¬req∧den} (denied).
            if (row.isPaymentPlanRequested && !row.paymentPlanDeniedAt) return 'PENDING_HELD';
            if (!row.isPaymentPlanRequested && row.paymentPlanDeniedAt) return 'PENDING_HELD_DENIED';
            return null; // both or neither → off-diagram
        default:
            return assertNever(row.status);
    }
}

// ---- validate (§4 invariants I1–I4) -----------------------------------------

const INVARIANTS: readonly Invariant<EnrollmentRow>[] = [
    // I1 — ACTIVE ⟹ held = null. The money invariant (a −1 that never comes back).
    { name: 'I1', holds: (r) => r.status !== 'ACTIVE' || !r.inventoryHeldAt },
    // I2 — held ≠ null ⟹ status = PENDING. Corollary of I1.
    { name: 'I2', holds: (r) => !r.inventoryHeldAt || r.status === 'PENDING' },
    // I3 — PENDING ∧ held ⟹ exactly one of {req∧¬den} or {¬req∧den} (never both/neither).
    {
        name: 'I3',
        holds: (r) => {
            if (r.status !== 'PENDING' || !r.inventoryHeldAt) return true;
            const awaiting = r.isPaymentPlanRequested && !r.paymentPlanDeniedAt;
            const denied = !r.isPaymentPlanRequested && r.paymentPlanDeniedAt;
            return awaiting !== denied; // exactly one (they can't both be true)
        },
    },
    // I4 — PENDING ∧ held = null ⟹ den = null. UNPAID and HOLD_FAILED both satisfy
    // this; they differ only by `req`, a discriminator not an invariant.
    {
        name: 'I4',
        holds: (r) => !(r.status === 'PENDING' && !r.inventoryHeldAt && r.paymentPlanDeniedAt),
    },
];

/** Return `{ invariant }` for the first violated invariant, or null when clean. */
export const validate = defineValidator(INVARIANTS);

// ---- TRANSITIONS (§5 table, as data — documentation + test oracle) ----------

/** Every declared state, including the no-row `UNENROLLED` (∅). */
export type LifecycleState = EnrollmentStateName | 'UNENROLLED';

/**
 * The §5 transition table as data. Drives the coverage matrix / reachability /
 * BFS checks. NEVER executed: the guard `where`/`delete()`/`FOR UPDATE` at each
 * `guardSite` stays byte-for-byte. `event` carries the T-id from the doc.
 */
export const TRANSITIONS: readonly Transition<LifecycleState>[] = [
    { event: 'T1 enroll(paid)', from: 'UNENROLLED', to: 'PENDING_UNPAID', actor: 'user/admin', guardSite: 'participants/route.ts POST — FOR UPDATE capacity lock' },
    { event: 'T2 enroll(comp)', from: 'UNENROLLED', to: 'ACTIVE', actor: 'user/admin', guardSite: 'participants/route.ts POST — initialStatus in same tx' },
    { event: 'T3 apply(−1 ok)', from: 'PENDING_UNPAID', to: 'PENDING_HELD', actor: 'user', guardSite: 'request-payment-plan/route.ts — CAS status:PENDING, held:null' },
    { event: 'T3 re-apply', from: 'PENDING_HELD_DENIED', to: 'PENDING_HELD', actor: 'user', guardSite: 'request-payment-plan/route.ts — CAS held:{not:null} (clears denial, no 2nd −1)' },
    { event: 'T3f apply(−1 FAILS)', from: 'PENDING_UNPAID', to: 'PENDING_HOLD_FAILED', actor: 'user', guardSite: 'request-payment-plan/route.ts — roll held back to null; req stays true' },
    { event: 'T3m manual-hold', from: 'PENDING_HOLD_FAILED', to: 'PENDING_HELD', actor: 'admin', guardSite: 'finance-ops/payment-plans/manual-hold/route.ts — CAS held:null, req:true → stamp held' },
    { event: 'T4 activate(payment)', from: 'PENDING_UNPAID', to: 'ACTIVE', actor: 'shopify-webhook', guardSite: 'activateEnrollment.ts — CAS status:PENDING; release CAS held:{not:null}→null (fires on any PENDING)' },
    { event: 'T5 approve', from: 'PENDING_HELD', to: 'ACTIVE', actor: 'admin', guardSite: 'finance-ops/payment-plans/route.ts — CAS req:true,status:PENDING; held→null WITHOUT +1; COI guard' },
    { event: 'T6 deny', from: 'PENDING_HELD', to: 'PENDING_HELD_DENIED', actor: 'admin', guardSite: 'finance-ops/payment-plans/refuse/route.ts — CAS req:true,status:PENDING; stamp den; COI guard' },
    { event: 'T7 non-payment kick', from: 'PENDING_UNPAID', to: 'UNENROLLED', actor: 'cron', guardSite: 'cron/pending-participants/route.ts — delete(); query filters req:false,den:null' },
    { event: 'T8 grace expiry', from: 'PENDING_HELD_DENIED', to: 'UNENROLLED', actor: 'cron', guardSite: 'cron/scholarship-grace-expiry/route.ts — delete(); NULL graceDays = off' },
    { event: 'T9 withdraw', from: 'PENDING_HELD', to: 'UNENROLLED', actor: 'user/admin', guardSite: 'capacity.ts withdrawAndReleaseHold — delete() = atomicity boundary; +1 iff held' },
    { event: 'T10 refund restocked', from: 'ACTIVE', to: 'UNENROLLED', actor: 'shopify-webhook', guardSite: 'reconcile.ts removeRefundedEnrollment — deleteMany scoped to the refunded order + audit row in one tx; no +1 (Shopify restocked)' },
] as const;
