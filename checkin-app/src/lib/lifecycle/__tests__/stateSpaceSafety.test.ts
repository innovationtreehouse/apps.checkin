/**
 * Exhaustive state-space safety proof.
 *
 * For each machine, enumerate the ENTIRE bounded state space — every
 * (status × flag-combination) tuple — and assert:
 *   1. on-diagram ⟹ clean:      classify(row) ≠ null  ⟹  validate(row) == null
 *   2. off-diagram ⟹ flagged:   classify(row) == null ⟹  validate(row) ≠ null
 *      (so `validate` totally detects every off-diagram tuple — the reconciler's oracle)
 *   3. no legal path escapes:    every classifiable state is a node the transition
 *      graph can actually reach (bfsStates), and every reachable node is realized
 *      by some tuple — no orphan diagram nodes, no reachable-but-off-diagram states.
 *
 * This is model-checking without TLA+/Alloy: the space is a few hundred tuples,
 * so one dependency-free test proves no sequence of legal transitions reaches a
 * bad state. Pure — no DB, no Prisma value import.
 */
import { bfsStates, reachability, reachableStatesViolating } from '@/lib/lifecycle';
import {
    classify as classifyEnrollment,
    validate as validateEnrollment,
    STATES as ENROLLMENT_STATES,
    TRANSITIONS as ENROLLMENT_TRANSITIONS,
    type EnrollmentRow,
    type EnrollmentStateName,
} from '@/lib/programs/enrollmentState';
import {
    classify as classifyMembership,
    validate as validateMembership,
    TRANSITIONS as MEMBERSHIP_TRANSITIONS,
    ALL_STATUSES as MEMBERSHIP_ALL_STATUSES,
    ALL_KINDS as MEMBERSHIP_ALL_KINDS,
    INITIAL_STATES as MEMBERSHIP_INITIAL_STATES,
    LEGACY_STATUSES as MEMBERSHIP_LEGACY_STATUSES,
    type ClassifyRow as MembershipRow,
} from '@/lib/membership/lifecycle';

import {
    TRANSITIONS as HOUSEHOLD_TRANSITIONS,
    STATES as HOUSEHOLD_STATES,
    INITIAL_STATES as HOUSEHOLD_INITIAL_STATES,
} from '@/lib/membership/householdStatus';

const BOOLS = [false, true] as const;

describe('enrollment — exhaustive state space', () => {
    // Reachable diagram nodes (statuses/state-names), following legal edges from ∅.
    const reachable = new Set(bfsStates(ENROLLMENT_TRANSITIONS, ['UNENROLLED']));
    const realized = new Set<string>();

    test('every (status × held × req × den) tuple is on-diagram-clean or off-diagram-flagged', () => {
        for (const status of ['PENDING', 'ACTIVE'] as const) {
            for (const inventoryHeldAt of BOOLS) {
                for (const isPaymentPlanRequested of BOOLS) {
                    for (const paymentPlanDeniedAt of BOOLS) {
                        const row: EnrollmentRow = {
                            status,
                            inventoryHeldAt,
                            isPaymentPlanRequested,
                            paymentPlanDeniedAt,
                        };
                        const name = classifyEnrollment(row);
                        if (name !== null) {
                            // on-diagram ⟹ no invariant broken
                            expect(validateEnrollment(row)).toBeNull();
                            // classify agrees with the StateSet predicate for this tuple
                            expect(ENROLLMENT_STATES[name as EnrollmentStateName].has(row)).toBe(true);
                            // classifiable ⟹ a node the graph can reach (no off-diagram escapee)
                            expect(reachable.has(name)).toBe(true);
                            realized.add(name);
                        } else {
                            // off-diagram ⟹ validate flags exactly one invariant
                            expect(validateEnrollment(row)).not.toBeNull();
                        }
                    }
                }
            }
        }
    });

    test('every reachable node (bar ∅/no-row) is realized by some legal tuple', () => {
        const orphans = reachableStatesViolating(
            ENROLLMENT_TRANSITIONS,
            ['UNENROLLED'],
            (s) => s === 'UNENROLLED' || realized.has(s),
        );
        expect(orphans).toEqual([]);
    });
});

describe('membership — exhaustive state space', () => {
    const reachable = new Set(bfsStates(MEMBERSHIP_TRANSITIONS, MEMBERSHIP_INITIAL_STATES));
    const legacy = new Set<string>(MEMBERSHIP_LEGACY_STATUSES);
    const realized = new Set<string>();

    // Kind is the second axis because the machine's ACTIVE edges are kind-specific:
    // a PERSON_AGREEMENT settles on the signature and owes no clearance stamp.
    test('every (status × kind × 4 flags) tuple is on-diagram-clean or off-diagram-flagged', () => {
        for (const status of MEMBERSHIP_ALL_STATUSES) {
            for (const kind of MEMBERSHIP_ALL_KINDS) {
                for (const contractSignedAt of BOOLS) {
                    for (const bgConsentAt of BOOLS) {
                        for (const bgClearedAt of BOOLS) {
                            for (const paidAt of BOOLS) {
                                const row: MembershipRow = {
                                    status,
                                    kind,
                                    contractSignedAt,
                                    bgConsentAt,
                                    bgClearedAt,
                                    paidAt,
                                };
                                const name = classifyMembership(row);
                                if (name !== null) {
                                    expect(validateMembership(row)).toBeNull();
                                    // reachable, or the dead-but-guarded legacy status
                                    expect(reachable.has(name) || legacy.has(name)).toBe(true);
                                    realized.add(name);
                                } else {
                                    expect(validateMembership(row)).not.toBeNull();
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    test('every reachable status is realized by some legal tuple', () => {
        const orphans = reachableStatesViolating(
            MEMBERSHIP_TRANSITIONS,
            MEMBERSHIP_INITIAL_STATES,
            (s) => realized.has(s),
        );
        expect(orphans).toEqual([]);
    });

    test('the legacy status surfaces as unreachable, not as a dead-end', () => {
        // The reachability tool is where RENEWAL_PENDING_BG (dead-but-guarded) is
        // meant to show up — proven here rather than grepped for by hand.
        const r = reachability(
            MEMBERSHIP_TRANSITIONS,
            MEMBERSHIP_ALL_STATUSES,
            MEMBERSHIP_INITIAL_STATES,
            ['ACTIVE', 'ARCHIVED'],
        );
        expect(r.unreachable).toEqual(['RENEWAL_PENDING_BG']);
        expect(r.deadEnds).toEqual([]);
    });
});

describe('household status — owner rulings hold in the table', () => {
    const edges = HOUSEHOLD_TRANSITIONS.filter((t) => t.from !== '∅');

    test('DENIED → ACTIVE is not an edge', () => {
        expect(edges.some((t) => t.from === 'DENIED' && t.to === 'ACTIVE')).toBe(false);
    });

    test("DENIED's only exit is the board's restore to NONE", () => {
        const exits = edges.filter((t) => t.from === 'DENIED');
        expect(exits.map((t) => [t.to, t.actor])).toEqual([['NONE', 'board']]);
    });

    test('ACTIVE can only become ACTIVE via NONE, REVOKED (convergence)', () => {
        const into = edges.filter((t) => t.to === 'ACTIVE').map((t) => t.from).sort();
        expect(into).toEqual(['NONE', 'REVOKED']);
    });

    test('nothing returns ACTIVE or REVOKED to NONE', () => {
        expect(edges.filter((t) => t.to === 'NONE').map((t) => t.from)).toEqual(['DENIED']);
    });

    test('every state is reachable from creation', () => {
        const r = reachability(HOUSEHOLD_TRANSITIONS, HOUSEHOLD_STATES, HOUSEHOLD_INITIAL_STATES, HOUSEHOLD_STATES);
        expect(r.unreachable).toEqual([]);
        expect(r.deadEnds).toEqual([]);
    });
});
