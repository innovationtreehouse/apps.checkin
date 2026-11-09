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
export type ProgramParticipantStatus = 'PENDING' | 'ACTIVE' | 'WITHDRAWN';

// Parity: fails to compile if the schema enum and this union diverge.
// The runtime twin (assertEnumParity) lives in the unit test.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _Parity = Expect<Equal<ProgramParticipantStatus, PrismaStatus>>;

type Where = Prisma.ProgramParticipantWhereInput;

/**
 * The row shape the client-safe predicates see: nullable timestamps collapsed to
 * PRESENCE booleans (keep `Date | null` out of the predicate). Map a DB
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

// ---- STATES table ------------------------------------------------------
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
    /** ACTIVE, held=null. req/den are vestigial don't-cares once ACTIVE;
     *  the validator asserts only held=null (I1). */
    ACTIVE: mk({
        statuses: ['ACTIVE'] as const,
        flags: { inventoryHeldAt: false },
    }),
    /** WITHDRAWN, held=null, endedAt set. The row stays as history of a person
     *  who took part and left; re-enrollment reactivates it. */
    WITHDRAWN: mk({
        statuses: ['WITHDRAWN'] as const,
        flags: { inventoryHeldAt: false },
    }),
} as const;

// ---- fromWhere (CAS from-state) -----------------------------------

/** The named present-row states — the keys of STATES, i.e. every state a CAS
 *  guard can transition FROM. */
export type FromStateName = keyof typeof STATES;

/**
 * Emit the `status` clause a CAS transition guard names for its from-state, sourced
 * from STATES so a status rename/split flows into every guard that spreads it.
 * All enrollment PENDING_* states share `status:'PENDING'`; ACTIVE is its
 * own status — the scalar shape matches what the guards hand-write, so the
 * query is the same either way.
 *
 * It emits ONLY the status, so every PENDING_* name emits the same filter. Reads use it;
 * a write takes its whole filter from ENROLLMENT_WRITES.
 */
export function fromWhere(from: FromStateName): Where {
    return fromStatusWhere<Where>(STATES[from].statuses);
}

// ---- classify (total switch) --------------------------------------

/** The named present-row states (UNENROLLED is the no-row state, so `classify`
 *  never returns it — it only sees existing rows). */
export type EnrollmentStateName =
    | 'PENDING_UNPAID'
    | 'PENDING_HOLD_FAILED'
    | 'PENDING_HELD'
    | 'PENDING_HELD_DENIED'
    | 'ACTIVE'
    | 'WITHDRAWN';

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
        case 'WITHDRAWN':
            // I2: a held seat is only ever on a PENDING row.
            return row.inventoryHeldAt ? null : 'WITHDRAWN';
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

// ---- validate (invariants I1–I4) -----------------------------------------

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

// ---- ENROLLMENT_WRITES / ENROLLMENT_GUARDS (every guarded write, as data) --

export type EnrollmentWrite = {
    readonly where: Where;
    /** The machine columns the write sets. A site adds its other columns beside them. */
    readonly data: (now: Date) => Prisma.ProgramParticipantUpdateManyMutationInput;
};

/**
 * Each compare-and-set on ProgramParticipant: the filter and the machine columns it
 * writes. Sites spread these and add only the row's identity and non-machine columns;
 * enrollmentGuards.integration.test.ts runs them on Postgres over every row shape.
 */
export const ENROLLMENT_WRITES = {
    requestFlag: { where: { status: 'PENDING', isPaymentPlanRequested: false }, data: () => ({ isPaymentPlanRequested: true }) },
    takeHold: {
        where: { status: 'PENDING', inventoryHeldAt: null },
        data: (now: Date) => ({ isPaymentPlanRequested: true, inventoryHeldAt: now, paymentPlanDeniedAt: null }),
    },
    reapply: {
        where: { status: 'PENDING', inventoryHeldAt: { not: null } },
        data: () => ({ isPaymentPlanRequested: true, paymentPlanDeniedAt: null }),
    },
    requestWithoutHold: {
        where: { status: 'PENDING', inventoryHeldAt: null, isPaymentPlanRequested: false },
        data: () => ({ isPaymentPlanRequested: true }),
    },
    retryWithoutHold: {
        where: { status: 'PENDING', inventoryHeldAt: null, isPaymentPlanRequested: true },
        data: () => ({ isPaymentPlanRequested: true }),
    },
    manualHold: {
        where: { status: 'PENDING', inventoryHeldAt: null, isPaymentPlanRequested: true },
        data: (now: Date) => ({ inventoryHeldAt: now }),
    },
    activateHeld: {
        where: { status: 'PENDING', inventoryHeldAt: { not: null } },
        data: () => ({ status: 'ACTIVE', inventoryHeldAt: null }),
    },
    activateUnheld: {
        where: { status: 'PENDING', inventoryHeldAt: null },
        data: () => ({ status: 'ACTIVE', inventoryHeldAt: null }),
    },
    approveHeld: {
        where: { status: 'PENDING', isPaymentPlanRequested: true, inventoryHeldAt: { not: null } },
        data: () => ({ status: 'ACTIVE', isPaymentPlanRequested: false, inventoryHeldAt: null }),
    },
    approveUnheld: {
        where: { status: 'PENDING', isPaymentPlanRequested: true, inventoryHeldAt: null },
        data: () => ({ status: 'ACTIVE', isPaymentPlanRequested: false, inventoryHeldAt: null }),
    },
    denyHeld: {
        where: { status: 'PENDING', isPaymentPlanRequested: true, inventoryHeldAt: { not: null } },
        data: (now: Date) => ({ isPaymentPlanRequested: false, paymentPlanDeniedAt: now }),
    },
    denyUnheld: {
        where: { status: 'PENDING', isPaymentPlanRequested: true, inventoryHeldAt: null },
        data: () => ({ isPaymentPlanRequested: false }),
    },
    withdraw: { where: { status: { not: 'WITHDRAWN' } }, data: () => ({ status: 'WITHDRAWN' }) },
    releaseWithdrawnHold: { where: { status: 'WITHDRAWN', inventoryHeldAt: { not: null } }, data: () => ({ inventoryHeldAt: null }) },
    reenrollPaid: {
        where: { status: 'WITHDRAWN' },
        data: () => ({ status: 'PENDING', isPaymentPlanRequested: false, paymentPlanDeniedAt: null, inventoryHeldAt: null }),
    },
    reenrollComp: {
        where: { status: 'WITHDRAWN' },
        data: () => ({ status: 'ACTIVE', isPaymentPlanRequested: false, paymentPlanDeniedAt: null, inventoryHeldAt: null }),
    },
} satisfies Record<string, EnrollmentWrite>;

export type EnrollmentWriteName = keyof typeof ENROLLMENT_WRITES;

export type EnrollmentGuard = {
    /** Writes run in order, in the site's transaction or fallback path. */
    readonly steps: readonly EnrollmentWriteName[];
    /** The step whose match means the guard took the row. The last step unless named. */
    readonly admittedBy?: EnrollmentWriteName;
    /** Exactly the on-diagram states the guard admits; a state may rest on itself. */
    readonly from: readonly EnrollmentStateName[];
    readonly to: EnrollmentStateName;
};

export const ENROLLMENT_GUARDS = {
    apply: { steps: ['requestFlag', 'takeHold'], from: ['PENDING_UNPAID', 'PENDING_HOLD_FAILED'], to: 'PENDING_HELD' },
    reapply: { steps: ['requestFlag', 'reapply'], from: ['PENDING_HELD_DENIED', 'PENDING_HELD'], to: 'PENDING_HELD' },
    holdFailed: { steps: ['requestWithoutHold'], from: ['PENDING_UNPAID'], to: 'PENDING_HOLD_FAILED' },
    holdFailedRetry: { steps: ['retryWithoutHold'], from: ['PENDING_HOLD_FAILED'], to: 'PENDING_HOLD_FAILED' },
    manualHold: { steps: ['manualHold'], from: ['PENDING_HOLD_FAILED'], to: 'PENDING_HELD' },
    activateHeld: { steps: ['activateHeld'], from: ['PENDING_HELD', 'PENDING_HELD_DENIED'], to: 'ACTIVE' },
    activateUnheld: { steps: ['activateUnheld'], from: ['PENDING_UNPAID', 'PENDING_HOLD_FAILED'], to: 'ACTIVE' },
    approveHeld: { steps: ['approveHeld'], from: ['PENDING_HELD'], to: 'ACTIVE' },
    approveUnheld: { steps: ['approveUnheld'], from: ['PENDING_HOLD_FAILED'], to: 'ACTIVE' },
    denyHeld: { steps: ['denyHeld'], from: ['PENDING_HELD'], to: 'PENDING_HELD_DENIED' },
    denyUnheld: { steps: ['denyUnheld'], from: ['PENDING_HOLD_FAILED'], to: 'PENDING_UNPAID' },
    withdraw: {
        steps: ['withdraw', 'releaseWithdrawnHold'],
        admittedBy: 'withdraw',
        from: ['PENDING_UNPAID', 'PENDING_HOLD_FAILED', 'PENDING_HELD', 'PENDING_HELD_DENIED', 'ACTIVE'],
        to: 'WITHDRAWN',
    },
    reenrollPaid: { steps: ['reenrollPaid'], from: ['WITHDRAWN'], to: 'PENDING_UNPAID' },
    reenrollComp: { steps: ['reenrollComp'], from: ['WITHDRAWN'], to: 'ACTIVE' },
} as const satisfies Record<string, EnrollmentGuard>;

export type EnrollmentGuardName = keyof typeof ENROLLMENT_GUARDS;

/** Every row shape the predicates can see: status × held × req × den. */
export function enumerateEnrollmentRows(): EnrollmentRow[] {
    const bools = [false, true];
    return (['PENDING', 'ACTIVE', 'WITHDRAWN'] as const).flatMap((status) =>
        bools.flatMap((inventoryHeldAt) =>
            bools.flatMap((isPaymentPlanRequested) =>
                bools.map((paymentPlanDeniedAt) => ({ status, inventoryHeldAt, isPaymentPlanRequested, paymentPlanDeniedAt })),
            ),
        ),
    );
}

// ---- TRANSITIONS (as data — documentation + test oracle) ----------

/** Every declared state, including the no-row `UNENROLLED` (∅). */
export type LifecycleState = EnrollmentStateName | 'UNENROLLED';

/**
 * The transition table as data. Drives the coverage matrix / reachability /
 * BFS checks. NEVER executed: the guard `where`/`delete()`/`FOR UPDATE` at each
 * `guardSite` is the enforcement. `event` carries the transition's T-id. A row between
 * two present states names its guard; a create or delete has no ENROLLMENT_WRITES entry.
 */
export const TRANSITIONS: readonly (Transition<LifecycleState> & { readonly guard?: EnrollmentGuardName })[] = [
    { event: 'T1 enroll(paid)', from: 'UNENROLLED', to: 'PENDING_UNPAID', actor: 'user/admin', guardSite: 'participants/route.ts POST — FOR UPDATE capacity lock' },
    { event: 'T2 enroll(comp)', from: 'UNENROLLED', to: 'ACTIVE', actor: 'user/admin', guardSite: 'participants/route.ts POST — initialStatus in same tx' },
    { event: 'T3 apply(−1 ok)', from: 'PENDING_UNPAID', to: 'PENDING_HELD', actor: 'user', guardSite: 'request-payment-plan/route.ts — CAS status:PENDING, held:null', guard: 'apply' },
    { event: 'T3 re-apply', from: 'PENDING_HELD_DENIED', to: 'PENDING_HELD', actor: 'user', guardSite: 'request-payment-plan/route.ts — CAS held:{not:null} (clears denial, no 2nd −1)', guard: 'reapply' },
    { event: 'T3f apply(−1 FAILS)', from: 'PENDING_UNPAID', to: 'PENDING_HOLD_FAILED', actor: 'user', guardSite: 'request-payment-plan/route.ts — hold and −1 roll back together; the request flag is written alone', guard: 'holdFailed' },
    { event: 'T3 apply(retry)', from: 'PENDING_HOLD_FAILED', to: 'PENDING_HELD', actor: 'user', guardSite: 'request-payment-plan/route.ts — same CAS as apply: held:null takes the hold on a retry', guard: 'apply' },
    { event: 'T3m manual-hold', from: 'PENDING_HOLD_FAILED', to: 'PENDING_HELD', actor: 'admin', guardSite: 'finance-ops/payment-plans/manual-hold/route.ts — CAS held:null, req:true → stamp held', guard: 'manualHold' },
    { event: 'T4 activate(payment)', from: 'PENDING_UNPAID', to: 'ACTIVE', actor: 'shopify-webhook', guardSite: 'activateEnrollment.ts — CAS status:PENDING, held:null; nothing held, no +1', guard: 'activateUnheld' },
    { event: 'T4 activate(held)', from: 'PENDING_HELD', to: 'ACTIVE', actor: 'shopify-webhook', guardSite: 'activateEnrollment.ts — CAS status:PENDING, held:{not:null}; +1 compensates the sale', guard: 'activateHeld' },
    { event: 'T4 activate(denied)', from: 'PENDING_HELD_DENIED', to: 'ACTIVE', actor: 'shopify-webhook', guardSite: 'activateEnrollment.ts — CAS status:PENDING, held:{not:null}; +1 compensates the sale', guard: 'activateHeld' },
    { event: 'T4 activate(hold failed)', from: 'PENDING_HOLD_FAILED', to: 'ACTIVE', actor: 'shopify-webhook', guardSite: 'activateEnrollment.ts — CAS status:PENDING, held:null; nothing held, no +1', guard: 'activateUnheld' },
    { event: 'T5 approve', from: 'PENDING_HELD', to: 'ACTIVE', actor: 'admin', guardSite: 'finance-ops/payment-plans/route.ts — CAS req:true,status:PENDING; held→null WITHOUT +1, stamping seatTakenWithoutSaleAt only when a hold was held (T11); COI guard', guard: 'approveHeld' },
    { event: 'T5 approve(no hold)', from: 'PENDING_HOLD_FAILED', to: 'ACTIVE', actor: 'admin', guardSite: 'finance-ops/payment-plans/route.ts — CAS req:true,held:null,status:PENDING; records no seatTakenWithoutSaleAt; COI guard', guard: 'approveUnheld' },
    { event: 'T6 deny', from: 'PENDING_HELD', to: 'PENDING_HELD_DENIED', actor: 'admin', guardSite: 'finance-ops/payment-plans/refuse/route.ts — CAS req:true,status:PENDING; stamp den; COI guard', guard: 'denyHeld' },
    { event: 'T6f deny(no hold)', from: 'PENDING_HOLD_FAILED', to: 'PENDING_UNPAID', actor: 'admin', guardSite: 'finance-ops/payment-plans/refuse/route.ts — CAS req:true,held:null,status:PENDING; clears req, stamps nothing, denial kept in the audit row; COI guard', guard: 'denyUnheld' },
    { event: 'T7 remove(unpaid)', from: 'PENDING_UNPAID', to: 'UNENROLLED', actor: 'user/admin', guardSite: 'participants/route.ts DELETE → capacity.ts deleteAndReleaseHold — delete(); cron/pending-participants only reports overdue rows' },
    { event: 'T8 grace expiry', from: 'PENDING_HELD_DENIED', to: 'UNENROLLED', actor: 'cron', guardSite: 'cron/scholarship-grace-expiry/route.ts — delete(); NULL graceDays = off' },
    { event: 'T9 remove', from: 'PENDING_HELD', to: 'UNENROLLED', actor: 'user/admin', guardSite: 'capacity.ts deleteAndReleaseHold — delete() = atomicity boundary; +1 iff held' },
    { event: 'T9 remove(hold failed)', from: 'PENDING_HOLD_FAILED', to: 'UNENROLLED', actor: 'user/admin', guardSite: 'participants/route.ts DELETE → capacity.ts deleteAndReleaseHold — delete(); nothing held, no +1' },
    { event: 'T9 remove(denied)', from: 'PENDING_HELD_DENIED', to: 'UNENROLLED', actor: 'user/admin', guardSite: 'participants/route.ts DELETE → capacity.ts deleteAndReleaseHold — delete(); +1 iff held' },
    { event: 'T10 refund restocked', from: 'ACTIVE', to: 'UNENROLLED', actor: 'shopify-webhook', guardSite: 'reconcile.ts settleRestockedSeats → removeRefundedEnrollment — only children the order identifies, deleteMany status:ACTIVE scoped to the refunded order (a WITHDRAWN row stays and the refund is recorded on it) + audit row in one tx; no +1 (Shopify restocked); unidentified public seats taken back with -k' },
    { event: 'T11 remove(comp/approved)', from: 'ACTIVE', to: 'UNENROLLED', actor: 'admin', guardSite: 'capacity.ts deleteAndReleaseHold — delete(); +1 iff seatTakenWithoutSaleAt is set (a paid place returns nothing)' },
    { event: 'T12 withdraw', from: 'ACTIVE', to: 'WITHDRAWN', actor: 'admin', guardSite: 'capacity.ts withdrawParticipant — CAS status:{not:WITHDRAWN} → WITHDRAWN, endedAt = atomicity boundary; +1 iff seatTakenWithoutSaleAt is set', guard: 'withdraw' },
    { event: 'T13 withdraw(held)', from: 'PENDING_HELD', to: 'WITHDRAWN', actor: 'user/admin', guardSite: 'capacity.ts withdrawParticipant — same status CAS, then CAS held:{not:null}→null; +1 iff that clears a hold', guard: 'withdraw' },
    { event: 'T13 withdraw(unpaid)', from: 'PENDING_UNPAID', to: 'WITHDRAWN', actor: 'user/admin', guardSite: 'capacity.ts withdrawParticipant — same status CAS; nothing held, no +1', guard: 'withdraw' },
    { event: 'T13 withdraw(hold failed)', from: 'PENDING_HOLD_FAILED', to: 'WITHDRAWN', actor: 'user/admin', guardSite: 'capacity.ts withdrawParticipant — same status CAS; nothing held, no +1', guard: 'withdraw' },
    { event: 'T13 withdraw(denied)', from: 'PENDING_HELD_DENIED', to: 'WITHDRAWN', actor: 'user/admin', guardSite: 'capacity.ts withdrawParticipant — same status CAS, then CAS held:{not:null}→null; +1 iff that clears a hold', guard: 'withdraw' },
    { event: 'T14 re-enroll(paid)', from: 'WITHDRAWN', to: 'PENDING_UNPAID', actor: 'user/admin', guardSite: 'participants/route.ts POST — FOR UPDATE capacity lock; CAS status:WITHDRAWN, resets the last stint\'s fields', guard: 'reenrollPaid' },
    { event: 'T15 re-enroll(comp)', from: 'WITHDRAWN', to: 'ACTIVE', actor: 'user/admin', guardSite: 'participants/route.ts POST — CAS status:WITHDRAWN, resets the last stint\'s fields', guard: 'reenrollComp' },
] as const;
