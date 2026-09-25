/**
 * ctxNeeds — the proof the scoped CallerContext prefetch is behavior-neutral.
 *
 * buildCallerContext now fetches only the fields a route's policy can consume
 * (spec.ctxNeeds, derived in core.ts from authorize + orderedView roles +
 * granted token scopes). Skipping a fetch leaves that field an EMPTY set, so
 * this suite asserts, for EVERY registered route:
 *
 *   1. Admission (resolveAccess) is identical under a fully-populated context
 *      vs the same context masked to the route's ctxNeeds.
 *   2. The role walk (first orderedView role the caller holds — exactly the
 *      handler's loop) picks the same role under both.
 *   3. stripValue output is identical under both, for every view's token list
 *      × every bound model × representative rows.
 *
 * (1)–(3) are the only three consumers of CallerContext (the user handler fn
 * never sees it), so equality here IS output equality for the route.
 *
 * Masking — not re-fetching — mirrors the runtime exactly: an unfetched field
 * and a masked field are both empty sets. Pure unit test, no DB.
 *
 * On a mismatch the DERIVATION is wrong — fix deriveCtxNeeds (core.ts), never
 * this test. The total switches in core.ts (assertNever) separately force the
 * derivation to be revisited when a Scope/Role/Authorize variant is added.
 */
import {
    allRoutes,
    deriveCtxNeeds,
    ALL_CTX_NEEDS,
    type CtxNeeds,
    type Role,
    type Token,
} from '@/security/core';
import {
    callerHoldsRole,
    resolveAccess,
    type CallerContext,
} from '@/security/access-resolvers';
import { stripValue } from '@/security/stripper';
import { SCOPE_BINDINGS } from '@/security/scopeBindings';
import type { AuthResult, AuthenticatedUser } from '@/types/auth';
import prisma from '@/lib/prisma';
// Side-effect import: registers every route via defineRoute() so allRoutes()
// yields the real policy surface.
import '@/security/registry';

// The 'catalog-viewer' admission (access-resolvers) makes one inline DB read —
// a VolunteerDesignation lookup keyed by email — for callers who hold no role
// flag and lead no program. It's independent of CallerContext, so masked ≡ full
// still holds; this stub just keeps the "no real DB" invariant (jest.setup
// rejects the real client). Its result never varies with ctx, so null is fine.
beforeAll(() => {
    prisma.volunteerDesignation.findFirst = jest.fn().mockResolvedValue(null);
});

// ─── Personas: fully-populated contexts + matching AuthResults ────────────────

function ctx(opts: Partial<CallerContext> = {}): CallerContext {
    return {
        selfId: undefined,
        householdId: undefined,
        isKeyholder: false,
        isKiosk: false,
        programsLed: new Set(),
        programsCoreVolIn: new Set(),
        participantIdsInScopePrograms: new Set(),
        householdIdsInScopePrograms: new Set(),
        eventIdsInScopePrograms: new Set(),
        activeVisitorIds: new Set(),
        ledHouseholdMemberIds: new Set(),
        ...opts,
    };
}

function sessionUser(over: Partial<AuthenticatedUser> & { id: number }): AuthenticatedUser {
    return {
        email: `p${over.id}@example.com`,
        isSysadmin: false,
        isBoardMember: false,
        isKeyholder: false,
        isBackgroundCheckReviewer: false,
        isOperations: false,
        isInventoryManager: false,
        ...over,
    };
}

interface Persona {
    auth: AuthResult;
    full: CallerContext;
}

// Every persona's context is populated as if ALL fetches ran (the "full" side).
// Program-scoped fields are non-empty even for personas that wouldn't earn them
// from the DB — deliberately adversarial: if masking such a field ever changes
// route output, the derivation missed a consumer.
const PERSONAS: Record<string, Persona> = {
    anonymous: { auth: { type: 'unauthenticated' }, full: ctx() },
    kiosk: { auth: { type: 'kiosk' }, full: ctx({ isKiosk: true }) },
    member: {
        auth: { type: 'session', user: sessionUser({ id: 5, householdId: 2 }) },
        // ledHouseholdMemberIds populated for a NON-lead too (the runtime never
        // does this) — same adversarial principle as the program sets below.
        full: ctx({ selfId: 5, householdId: 2, ledHouseholdMemberIds: new Set([5, 6, 9]) }),
    },
    householdLead: {
        auth: {
            type: 'session',
            user: sessionUser({ id: 6, householdId: 2, householdLead: true }),
        },
        full: ctx({
            selfId: 6,
            householdId: 2,
            ledHouseholdMemberIds: new Set([5, 6, 9]),
        }),
    },
    programLead: {
        auth: { type: 'session', user: sessionUser({ id: 10, householdId: 4 }) },
        full: ctx({
            selfId: 10,
            householdId: 4,
            programsLed: new Set([100]),
            participantIdsInScopePrograms: new Set([9, 5]),
            householdIdsInScopePrograms: new Set([2]),
            eventIdsInScopePrograms: new Set([200]),
        }),
    },
    coreVolunteer: {
        auth: { type: 'session', user: sessionUser({ id: 11, householdId: 5 }) },
        full: ctx({
            selfId: 11,
            householdId: 5,
            programsCoreVolIn: new Set([101]),
            participantIdsInScopePrograms: new Set([9]),
            householdIdsInScopePrograms: new Set([2]),
            eventIdsInScopePrograms: new Set([201]),
        }),
    },
    keyholder: {
        auth: {
            type: 'session',
            user: sessionUser({ id: 12, householdId: 6, isKeyholder: true }),
        },
        full: ctx({
            selfId: 12,
            householdId: 6,
            isKeyholder: true,
            activeVisitorIds: new Set([9, 5]),
        }),
    },
    certifier: {
        auth: {
            type: 'session',
            user: sessionUser({
                id: 15,
                householdId: 9,
                toolStatuses: [{ toolId: 1, level: 'MAY_CERTIFY_OTHERS' }],
            }),
        },
        full: ctx({ selfId: 15, householdId: 9 }),
    },
    boardMember: {
        auth: {
            type: 'session',
            user: sessionUser({ id: 13, householdId: 7, isBoardMember: true }),
        },
        full: ctx({ selfId: 13, householdId: 7 }),
    },
    sysadmin: {
        auth: {
            type: 'session',
            user: sessionUser({ id: 14, householdId: 8, isSysadmin: true }),
        },
        full: ctx({ selfId: 14, householdId: 8 }),
    },
};

/** The runtime effect of skipping a fetch: that field is an empty set. */
function maskToNeeds(full: CallerContext, needs: CtxNeeds): CallerContext {
    return {
        ...full,
        programsLed: needs.programs ? full.programsLed : new Set(),
        programsCoreVolIn: needs.programs ? full.programsCoreVolIn : new Set(),
        participantIdsInScopePrograms: needs.programs
            ? full.participantIdsInScopePrograms
            : new Set(),
        householdIdsInScopePrograms: needs.programHouseholds
            ? full.householdIdsInScopePrograms
            : new Set(),
        eventIdsInScopePrograms: needs.programEvents ? full.eventIdsInScopePrograms : new Set(),
        activeVisitorIds: needs.activeVisitors ? full.activeVisitorIds : new Set(),
        ledHouseholdMemberIds: needs.ledHouseholdMembers
            ? full.ledHouseholdMemberIds
            : new Set(),
    };
}

// Representative rows: each carries every field any binding matches on (same
// shape as the S1 equivalence suite), so one row set exercises all models.
const ROWS: Array<Record<string, unknown> | null> = [
    null,
    {},
    { id: 1, name: 'X' },
    // caller-5 own / in-program / active visitor
    { id: 5, householdId: 2, participantId: 5, personId: 5, programId: 100, eventId: 200, userId: 5, actorId: 5, departedAt: null },
    // program participant via coreVol program / active visitor
    { id: 9, householdId: 2, participantId: 9, personId: 9, programId: 101, eventId: 201, userId: 9, actorId: 9, departedAt: null },
    // another's / out-of-program / departed
    { id: 7, householdId: 99, participantId: 7, personId: 7, programId: 88, eventId: 88, userId: 7, actorId: 7, departedAt: new Date(0) },
    // lead's own program (Program row id 100)
    { id: 100, householdId: 4, participantId: 10, personId: 10, programId: 100, eventId: 200, userId: 10, actorId: 10, departedAt: null },
];

const MODELS = [...Object.keys(SCOPE_BINDINGS), 'OrgMembershipProcess'];

// Param sets: program-scoped routes key roles/admission on params.id.
// 100 = programLead's program, 101 = coreVolunteer's, 999 = nobody's.
const PARAM_SETS: Array<Record<string, string>> = [{}, { id: '100' }, { id: '101' }, { id: '999' }];

/** Exactly the handler's orderedView walk. */
function chooseRole(
    orderedView: readonly (readonly [Role, readonly Token[]])[],
    auth: AuthResult,
    params: Record<string, string>,
    callerCtx: CallerContext,
): Role | undefined {
    for (const [role] of orderedView) {
        if (callerHoldsRole(role, auth, params, callerCtx)) return role;
    }
    return undefined;
}

describe('ctxNeeds — masked prefetch ≡ full prefetch for every registered route', () => {
    const routes = [...allRoutes()];

    it('has routes registered (side-effect import worked)', () => {
        expect(routes.length).toBeGreaterThan(0);
    });

    it('stores the derivation on every registered spec', () => {
        for (const [endpoint, spec] of routes) {
            expect({ endpoint, needs: spec.ctxNeeds }).toEqual({
                endpoint,
                needs: deriveCtxNeeds(spec),
            });
        }
    });

    it('admission + role walk are identical under masked context', async () => {
        for (const [endpoint, spec] of routes) {
            for (const [pName, { auth, full }] of Object.entries(PERSONAS)) {
                const masked = maskToNeeds(full, spec.ctxNeeds);
                for (const params of PARAM_SETS) {
                    const [a, b] = await Promise.all([
                        resolveAccess(spec.authorize, { auth, params, callerContext: full }),
                        resolveAccess(spec.authorize, { auth, params, callerContext: masked }),
                    ]);
                    expect({ endpoint, pName, params, allowed: b.allowed }).toEqual({
                        endpoint, pName, params, allowed: a.allowed,
                    });
                    expect({
                        endpoint, pName, params,
                        role: chooseRole(spec.orderedView, auth, params, masked),
                    }).toEqual({
                        endpoint, pName, params,
                        role: chooseRole(spec.orderedView, auth, params, full),
                    });
                }
            }
        }
    });

    it('stripValue output is identical under masked context (all views × models × rows)', () => {
        const mismatches: string[] = [];
        for (const [endpoint, spec] of routes) {
            for (const [pName, { full }] of Object.entries(PERSONAS)) {
                const masked = maskToNeeds(full, spec.ctxNeeds);
                for (const [role, tokens] of spec.orderedView) {
                    for (const model of MODELS) {
                        for (const row of ROWS) {
                            const a = stripValue(model, row, tokens, full);
                            const b = stripValue(model, row, tokens, masked);
                            if (JSON.stringify(a) !== JSON.stringify(b)) {
                                mismatches.push(
                                    `${endpoint} / ${pName} / view=${role} / ${model} / row=${JSON.stringify(row)}`,
                                );
                            }
                        }
                    }
                }
            }
        }
        expect(mismatches).toEqual([]);
    });
});

describe('deriveCtxNeeds — spot checks against the live registry', () => {
    const byEndpoint = new Map([...allRoutes()]);

    it('a self-scoped route needs no prefetch at all', () => {
        expect(byEndpoint.get('GET /api/profile')?.ctxNeeds).toEqual({
            programs: false,
            programHouseholds: false,
            programEvents: false,
            activeVisitors: false,
            ledHouseholdMembers: false,
        });
    });

    it('the self-correction PATCH needs the led-household roster', () => {
        expect(byEndpoint.get('PATCH /api/attendance/manual/[id]')?.ctxNeeds).toEqual({
            programs: false,
            programHouseholds: false,
            programEvents: false,
            activeVisitors: false,
            ledHouseholdMembers: true,
        });
    });

    it('the self-correction DELETE needs no prefetches (empty bag)', () => {
        expect(byEndpoint.get('DELETE /api/attendance/manual/[id]')?.ctxNeeds).toEqual({
            programs: false,
            programHouseholds: false,
            programEvents: false,
            activeVisitors: false,
            ledHouseholdMembers: false,
        });
    });

    it('the program roster route needs the program prefetches', () => {
        expect(byEndpoint.get('GET /api/programs/[id]')?.ctxNeeds).toEqual({
            programs: true,
            programHouseholds: true,
            programEvents: true,
            activeVisitors: false,
            ledHouseholdMembers: false,
        });
    });

    it('ALL_CTX_NEEDS is the everything mask (masking with it is a no-op)', () => {
        const full = PERSONAS.programLead.full;
        expect(maskToNeeds(full, ALL_CTX_NEEDS)).toEqual(full);
    });
});
