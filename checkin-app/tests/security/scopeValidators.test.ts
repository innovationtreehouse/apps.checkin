/**
 * Unit tests for the CI security validators (scopes.ts). These are authored
 * but NOT wired as build gates in this chip (see §7.6); these tests prove the
 * validators detect what they are meant to, so wiring them later (Step 3) is a
 * one-liner with known-good behavior.
 */
import {
    validateBindings,
    validateRouteGrants,
    isScopable,
    type ScopeBindings,
    type RouteGrantSpec,
} from '@/security/scopes';
import { SCOPE_BINDINGS, OPT_OUT_PENDING_ROUTE } from '@/security/scopeBindings';
import { classifications, allRoutes } from '@/security/core';
// Side-effect import: registers every route via defineRoute() so allRoutes()
// yields the real policy surface for the CI gate below.
import '@/security/registry';

const CLS = classifications as unknown as Record<string, Record<string, string>>;

describe('validateBindings — field-existence (typo catcher)', () => {
    it('flags a binding field absent from the model', () => {
        const bad: ScopeBindings = { Person: { their_own: { field: 'householdID', eqCtx: 'householdId' } } };
        expect(validateBindings(bad, CLS, new Set())).toContain('Person.householdID — no such field');
    });

    it('flags an unknown model', () => {
        const bad: ScopeBindings = { Nope: { their_own: { field: 'id', eqCtx: 'selfId' } } };
        expect(validateBindings(bad, CLS, new Set())).toContain("binding for unknown model 'Nope'");
    });

    it('descends into `all` combinators', () => {
        const bad: ScopeBindings = {
            Visit: { all_current_visitors: { all: [{ flag: 'isKeyholder' }, { field: 'gone', isNull: true }] } },
        };
        expect(validateBindings(bad, CLS, new Set())).toContain('Visit.gone — no such field');
    });
});

describe('validateBindings — coverage (forgotten-model catcher)', () => {
    it('flags a sensitive, scopable, unbound, un-queued model', () => {
        // VolunteerDesignation is sensitive (email pii) + scopable via its
        // createdById FK; with an empty queue it must error. (MembershipProcess
        // was the old exemplar but is now un-scopable by the direct-FK heuristic
        // once bare `id` left SCOPABLE_FIELDS — it has only membershipId/
        // manualPaymentById, neither a recognised actor FK.)
        const errs = validateBindings(SCOPE_BINDINGS, CLS, new Set());
        expect(errs.some(e => e.startsWith('VolunteerDesignation is sensitive and scopable'))).toBe(true);
    });

    it('does not flag it when queued in OPT_OUT_PENDING_ROUTE', () => {
        const errs = validateBindings(SCOPE_BINDINGS, CLS, OPT_OUT_PENDING_ROUTE);
        expect(errs.some(e => e.startsWith('VolunteerDesignation is sensitive'))).toBe(false);
    });

    it('isScopable: structurally un-scopable model (no actor FK) is exempt', () => {
        // VerificationToken: identifier/token/expires — no id, no FK.
        expect(isScopable('VerificationToken', CLS)).toBe(false);
    });
});

describe('validateBindings — RSVP eventId re-add', () => {
    it('no longer flags RSVP.programId (RSVP is eventId-bound)', () => {
        // RSVP has no programId column; the program-lead grant resolves through
        // eventId. No field-existence error should appear and RSVP must be clean.
        const errs = validateBindings(SCOPE_BINDINGS, CLS, OPT_OUT_PENDING_ROUTE);
        expect(errs).not.toContain('RSVP.programId — no such field');
        expect(errs.some(e => e.startsWith('RSVP.'))).toBe(false);
    });
});

describe('validateRouteGrants — seam check', () => {
    const bindings: ScopeBindings = { Person: { their_own: { field: 'id', eqCtx: 'selfId' } } };

    it('flags a granted scope that no returned model binds', () => {
        const routes: RouteGrantSpec[] = [
            { endpoint: '/api/x', orderedView: [['authenticated', ['their_households:pii']]], returns: ['Person'] },
        ];
        const errs = validateRouteGrants(routes, bindings);
        expect(errs.some(e => e.includes("grants 'their_households:*'"))).toBe(true);
    });

    it('passes when the grant resolves and ignores everyones', () => {
        const routes: RouteGrantSpec[] = [
            { endpoint: '/api/y', orderedView: [['authenticated', ['their_own:pii', 'everyones:internal', 'public']]], returns: ['Person'] },
        ];
        expect(validateRouteGrants(routes, bindings)).toEqual([]);
    });

    // The CI gate below passes only if the seam is actually EVALUATED for the
    // self-correction grant — a route whose `returns` is missing is skipped, so
    // "green" alone does not prove the grant was checked. Strip led_households
    // from the Visit binding and the real spec must go red.
    it('bites on the real self-correction spec when Visit loses its led_households binding', () => {
        const patch = [...allRoutes()].find(
            ([ep]) => ep === 'PATCH /api/attendance/manual/[id]',
        )?.[1];
        expect(patch?.returns).toEqual(['Visit']);
        const errs = validateRouteGrants([patch as RouteGrantSpec], {
            ...SCOPE_BINDINGS,
            Visit: {
                their_own: SCOPE_BINDINGS.Visit.their_own,
                all_current_visitors: SCOPE_BINDINGS.Visit.all_current_visitors,
            },
        });
        expect(errs.some(e => e.includes("grants 'led_households:*'"))).toBe(true);
    });

    it('skips a route that has not declared `returns` (incremental coverage)', () => {
        const routes: RouteGrantSpec[] = [
            { endpoint: '/api/undeclared', orderedView: [['authenticated', ['their_households:pii']]] },
        ];
        expect(validateRouteGrants(routes, bindings)).toEqual([]);
    });
});

// ─── THE CI GATE ─────────────────────────────────────────────────────────────
// Asserts zero validator errors over the REAL registry. Every future route PR is
// now mechanically checked: a binding field typo, a forgotten sensitive model, or
// a route granting a row-scoped scope no returned model binds fails the build.
describe('CI gate — zero errors over the real registry', () => {
    it('validateBindings is clean (Blockers 1+2 landed)', () => {
        expect(validateBindings(SCOPE_BINDINGS, CLS, OPT_OUT_PENDING_ROUTE)).toEqual([]);
    });

    it('validateRouteGrants is clean (every granted row-scope resolves on a returned model)', () => {
        const routes: RouteGrantSpec[] = [...allRoutes()].map(([, spec]) => spec);
        expect(validateRouteGrants(routes, SCOPE_BINDINGS)).toEqual([]);
    });
});
