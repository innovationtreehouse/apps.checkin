/**
 * Unit tests for the ProgramParticipant enrollment definition (enrollmentState.ts).
 * Pure — no DB. Value-imports the Prisma enum ONLY here (a test, not the client
 * bundle) for the runtime parity check.
 */
import { ProgramParticipantStatus } from '@/generated/prisma/client';
import {
    STATES,
    classify,
    validate,
    toRow,
    TRANSITIONS,
    type EnrollmentRow,
    type LifecycleState,
} from './enrollmentState';
import { assertEnumParity, reachability, type Expect, type Equal } from '@/lib/lifecycle';

const LOCAL_STATUSES = ['PENDING', 'ACTIVE', 'WITHDRAWN'] as const;
type Status = (typeof LOCAL_STATUSES)[number];

// A DB-shaped row: nullable timestamps as Date|null, req as a real boolean.
type DbRow = {
    status: Status;
    inventoryHeldAt: Date | null;
    isPaymentPlanRequested: boolean;
    paymentPlanDeniedAt: boolean; // presence, kept boolean for matrix brevity
};

const D = new Date('2026-01-01T00:00:00Z');

function db(status: Status, held: boolean, req: boolean, den: boolean): DbRow {
    return { status, inventoryHeldAt: held ? D : null, isPaymentPlanRequested: req, paymentPlanDeniedAt: den };
}
function row(status: Status, held: boolean, req: boolean, den: boolean): EnrollmentRow {
    return { status, inventoryHeldAt: held, isPaymentPlanRequested: req, paymentPlanDeniedAt: den };
}

// Interpret the subset of Prisma `where` shapes our StateSets emit, so we can
// assert `where` and `has` agree WITHOUT a DB. Shapes: status:{in}, field:null,
// field:{not:null}, field:<boolean>.
function whereMatches(where: Record<string, unknown>, r: DbRow): boolean {
    for (const [k, v] of Object.entries(where)) {
        const val = (r as unknown as Record<string, unknown>)[k];
        if (k === 'status') {
            if (!(v as { in: string[] }).in.includes(val as string)) return false;
        } else if (v === null) {
            const present = val instanceof Date ? true : val === true;
            if (present) return false;
        } else if (typeof v === 'boolean') {
            if (val !== v) return false;
        } else if (v && typeof v === 'object' && (v as { not?: unknown }).not === null) {
            const present = val instanceof Date ? true : val === true;
            if (!present) return false;
        } else {
            throw new Error(`whereMatches: unhandled shape for ${k}: ${JSON.stringify(v)}`);
        }
    }
    return true;
}

// ---- classify: the six legal tuples --------------------------------------

describe('classify — the legal states (§3 table)', () => {
    test('each legal tuple maps to its named state', () => {
        expect(classify(row('PENDING', false, false, false))).toBe('PENDING_UNPAID');
        expect(classify(row('PENDING', false, true, false))).toBe('PENDING_HOLD_FAILED');
        expect(classify(row('PENDING', true, true, false))).toBe('PENDING_HELD');
        expect(classify(row('PENDING', true, false, true))).toBe('PENDING_HELD_DENIED');
        expect(classify(row('ACTIVE', false, false, false))).toBe('ACTIVE');
        expect(classify(row('WITHDRAWN', false, false, false))).toBe('WITHDRAWN');
    });

    test('the two held=null PENDING states classify APART on req', () => {
        expect(classify(row('PENDING', false, false, false))).toBe('PENDING_UNPAID');
        expect(classify(row('PENDING', false, true, false))).toBe('PENDING_HOLD_FAILED');
    });

    test('ACTIVE with vestigial req/den flags is still ACTIVE (§3 note)', () => {
        // held=null is all that matters at ACTIVE; req/den are inert.
        expect(classify(row('ACTIVE', false, true, false))).toBe('ACTIVE');
        expect(classify(row('ACTIVE', false, false, true))).toBe('ACTIVE');
        expect(classify(row('ACTIVE', false, true, true))).toBe('ACTIVE');
    });

    test('off-diagram tuples classify to null', () => {
        expect(classify(row('ACTIVE', true, false, false))).toBeNull(); // I1: held on ACTIVE
        expect(classify(row('WITHDRAWN', true, false, false))).toBeNull(); // I2: held on WITHDRAWN
        expect(classify(row('PENDING', false, false, true))).toBeNull(); // I4: den on held=null (unpaid)
        expect(classify(row('PENDING', false, true, true))).toBeNull(); // I4: den on held=null (hold-failed)
        expect(classify(row('PENDING', true, false, false))).toBeNull(); // I3: held, neither awaiting nor denied
        expect(classify(row('PENDING', true, true, true))).toBeNull(); // I3: held, req∧den
    });
});

// ---- validate: I1–I4 --------------------------------------------------------

describe('validate — invariants I1–I4', () => {
    test('the legal tuples validate clean', () => {
        for (const r of [
            row('PENDING', false, false, false),
            row('PENDING', false, true, false),
            row('PENDING', true, true, false),
            row('PENDING', true, false, true),
            row('ACTIVE', false, false, false),
            row('ACTIVE', false, true, true), // vestigial flags, still legal
        ]) {
            expect(validate(r)).toBeNull();
        }
    });

    test('I1 — ACTIVE holding a seat', () => {
        expect(validate(row('ACTIVE', true, false, false))).toEqual({ invariant: 'I1' });
    });

    test('I3 — held + neither awaiting nor denied (and held + both)', () => {
        expect(validate(row('PENDING', true, false, false))).toEqual({ invariant: 'I3' });
        expect(validate(row('PENDING', true, true, true))).toEqual({ invariant: 'I3' });
    });

    test('I4 — denial stamped on a held=null row', () => {
        expect(validate(row('PENDING', false, false, true))).toEqual({ invariant: 'I4' });
        expect(validate(row('PENDING', false, true, true))).toEqual({ invariant: 'I4' });
    });

    test('every off-diagram tuple classify=null also fails validate, and vice versa', () => {
        for (const status of LOCAL_STATUSES) {
            for (const held of [true, false]) {
                for (const req of [true, false]) {
                    for (const den of [true, false]) {
                        const r = row(status, held, req, den);
                        const classified = classify(r) !== null;
                        const valid = validate(r) === null;
                        expect(classified).toBe(valid);
                    }
                }
            }
        }
    });
});

// ---- STATES: where agrees with has across the full matrix -------------------

describe('STATES — where and has derive from one spec (no drift)', () => {
    const names = Object.keys(STATES) as (keyof typeof STATES)[];

    test('where agrees with has on every status × held × req × den row', () => {
        for (const name of names) {
            const set = STATES[name];
            for (const status of LOCAL_STATUSES) {
                for (const held of [true, false]) {
                    for (const req of [true, false]) {
                        for (const den of [true, false]) {
                            const predicate = set.has(row(status, held, req, den));
                            const query = whereMatches(set.where as Record<string, unknown>, db(status, held, req, den));
                            expect(query).toBe(predicate);
                        }
                    }
                }
            }
        }
    });

    test("each STATES[x].has matches exactly the rows classify names x", () => {
        for (const name of names) {
            for (const status of LOCAL_STATUSES) {
                for (const held of [true, false]) {
                    for (const req of [true, false]) {
                        for (const den of [true, false]) {
                            const r = row(status, held, req, den);
                            // has ⟹ classify names this state. (classify may name a
                            // state whose set doesn't `has` it only for the ACTIVE
                            // vestigial cases, which the ACTIVE set intentionally
                            // does NOT gate on req/den — so has ⊆ classify=name.)
                            if (STATES[name].has(r)) expect(classify(r)).toBe(name);
                        }
                    }
                }
            }
        }
    });

    test('the refactored query fragments equal the literals they replaced (behavior-preserving)', () => {
        expect(STATES.PENDING_HELD.where).toEqual({
            status: { in: ['PENDING'] }, inventoryHeldAt: { not: null }, paymentPlanDeniedAt: null, isPaymentPlanRequested: true,
        });
        expect(STATES.PENDING_HOLD_FAILED.where).toEqual({
            status: { in: ['PENDING'] }, inventoryHeldAt: null, paymentPlanDeniedAt: null, isPaymentPlanRequested: true,
        });
        expect(STATES.PENDING_HELD_DENIED.where).toEqual({
            status: { in: ['PENDING'] }, inventoryHeldAt: { not: null }, paymentPlanDeniedAt: { not: null }, isPaymentPlanRequested: false,
        });
        expect(STATES.PENDING_UNPAID.where).toEqual({
            status: { in: ['PENDING'] }, inventoryHeldAt: null, paymentPlanDeniedAt: null, isPaymentPlanRequested: false,
        });
    });
});

// ---- toRow ------------------------------------------------------------------

describe('toRow', () => {
    test('collapses nullable timestamps to presence booleans', () => {
        expect(toRow({ status: 'PENDING', inventoryHeldAt: D, isPaymentPlanRequested: true, paymentPlanDeniedAt: null }))
            .toEqual({ status: 'PENDING', inventoryHeldAt: true, isPaymentPlanRequested: true, paymentPlanDeniedAt: false });
    });
});

// ---- enum parity ------------------------------------------------------------

describe('enum parity', () => {
    test('local union matches the Prisma enum keys at runtime', () => {
        expect(() => assertEnumParity([...LOCAL_STATUSES], ProgramParticipantStatus, 'ProgramParticipantStatus')).not.toThrow();
    });

    test('compile-time parity holds', () => {
        type _P = Expect<Equal<Status, ProgramParticipantStatus>>;
        const ok: _P = true;
        expect(ok).toBe(true);
    });
});

// ---- transitions ------------------------------------------------------------

describe('TRANSITIONS (§5 table as data)', () => {
    const ALL: LifecycleState[] = ['UNENROLLED', 'PENDING_UNPAID', 'PENDING_HOLD_FAILED', 'PENDING_HELD', 'PENDING_HELD_DENIED', 'ACTIVE', 'WITHDRAWN'];

    test('every state is reachable from ∅', () => {
        const r = reachability(TRANSITIONS, ALL, ['UNENROLLED'], ['UNENROLLED', 'ACTIVE']);
        expect(r.unreachable).toEqual([]);
    });

    test('every edge references declared states only', () => {
        for (const t of TRANSITIONS) {
            expect(ALL).toContain(t.from);
            expect(ALL).toContain(t.to);
        }
    });
});
