/**
 * @jest-environment node
 *
 * Delivery guard — the third leg the security suite was missing.
 *
 * The suite already proves two of the three things a policy owes:
 *   - ADMISSION       — who may invoke the route      (registryAuthz.integration)
 *   - NO OVER-EXPOSURE— nothing leaks above the tier  (policy.contract.integration)
 * Neither proves DELIVERY: that an admitted persona actually RECEIVES fields.
 * A view narrowed to deny-all (or to a tier the model has no field at, or to
 * `secret`) returns 200 with an empty body and passes BOTH — while the real
 * user journey silently ships blank. That gap is where PR #1137 finding 1 lives.
 *
 * This closes the leg at the unit layer. For every registered route that
 * declares `returns`, and every persona in its `orderedView`, it runs the REAL
 * stripper over fully-populated synthetic rows under a caller context built to
 * satisfy exactly the scopes that persona's tokens reference, then asserts the
 * persona receives at least one field across the whole bag. A deny-all view
 * blanks every model → zero fields → red build.
 *
 * Granularity is per (route, persona), NOT per (route, persona, model): a
 * returns-model legitimately delivers nothing to some personas (anon sees a
 * Program's public columns but none of its EmergencyContacts), so a per-model
 * assertion would false-fail. Deny-all blanks the ENTIRE bag, which this catches.
 *
 * Pure — no DB, no HTTP, no seeded caller.
 *
 * WHAT THIS DOES NOT COVER: per-row scope correctness on the LIVE handler's
 * select. A synthetic row always carries the binding field, so the class where
 * a handler's `select` omits it (e.g. `Visit.personId`, #1137 finding 1, which
 * strips the timestamps at runtime) is invisible here — that needs a
 * route-specific INTEGRATION delivery assertion in the route's conversion PR.
 * This guard owns deny-all / stripper-blank / wrong-tier / secret-only views.
 */
import { allRoutes, parseToken, type Token, classifications } from '@/security/core';
import { stripValue } from '@/security/stripper';
import { SCOPE_BINDINGS, ROW_SCOPE_KEY } from '@/security/scopeBindings';
import type { Match, ScopeBindings, CtxSet } from '@/security/scopes';
import type { CallerContext } from '@/security/access-resolvers';
import '@/security/registry';

function emptyCtx(): CallerContext {
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
    };
}

// A row with every classified field of `model` present and non-null. Values are
// sentinels — the stripper gates on tier, not value — except a ROW_SCOPE_KEY
// field, which must be numeric or scopesHeld fails closed (drops `everyones`).
function fullRow(model: string): Record<string, unknown> {
    const tiers = classifications[model as keyof typeof classifications] as Record<string, string>;
    const row: Record<string, unknown> = {};
    for (const field of Object.keys(tiers)) row[field] = `<${field}>`;
    const scopeKey = ROW_SCOPE_KEY[model];
    if (scopeKey) row[scopeKey] = 1;
    return row;
}

// Mutate (row, ctx) so `evalMatch(m, row, ctx)` holds. Mirrors the Match
// vocabulary in scopes.ts (eqCtx/inCtx are number-guarded, so use a number).
const SENTINEL = 1;
function satisfy(m: Match, row: Record<string, unknown>, ctx: CallerContext): void {
    if ('all' in m) {
        m.all.forEach(sub => satisfy(sub, row, ctx));
    } else if ('flag' in m) {
        ctx[m.flag] = true;
    } else if ('isNull' in m) {
        row[m.field] = null;
    } else if ('eqCtx' in m) {
        row[m.field] = SENTINEL;
        ctx[m.eqCtx] = SENTINEL;
    } else if ('inCtx' in m) {
        // May target one set or an OR over several; satisfying any is enough.
        row[m.field] = SENTINEL;
        const first = (Array.isArray(m.inCtx) ? m.inCtx[0] : m.inCtx) as CtxSet;
        ctx[first] = new Set<number>([SENTINEL]);
    }
    // { custom } — an opaque predicate; cannot be synthesized generically, so
    // it is left unsatisfied. A route delivering ONLY via a custom-bound scope
    // would surface here as zero delivery; none exist today, and such a route
    // would rightly demand a route-specific test rather than this generic guard.
}

// Scopes referenced by a token list (public/member carry none).
function scopesInTokens(tokens: readonly Token[]): Set<string> {
    const out = new Set<string>();
    for (const tok of tokens) {
        const parsed = parseToken(tok);
        if (parsed && parsed !== 'public' && parsed !== 'member') out.add(parsed.scope);
    }
    return out;
}

// Fields of `model` that survive the strip for this persona, given a row+ctx
// built to satisfy exactly the scopes the persona's tokens reference.
function deliveredFields(model: string, tokens: readonly Token[]): string[] {
    const row = fullRow(model);
    const ctx = emptyCtx();
    const wanted = scopesInTokens(tokens);
    const bindings = (SCOPE_BINDINGS as ScopeBindings)[model] ?? {};
    for (const [scope, match] of Object.entries(bindings)) {
        if (match && wanted.has(scope)) satisfy(match, row, ctx);
    }
    const out = stripValue(model, row, tokens, ctx);
    if (!out || typeof out !== 'object') return [];
    const tiers = classifications[model as keyof typeof classifications] as Record<string, string>;
    return Object.keys(out as Record<string, unknown>).filter(k => k in tiers);
}

describe('Delivery guard — every admitted persona receives data', () => {
    const routes = Array.from(allRoutes()).filter(([, spec]) => spec.returns?.length);

    it('covers every route that declares returns', () => {
        expect(routes.length).toBeGreaterThan(0);
    });

    for (const [endpoint, spec] of routes) {
        for (const [role, tokens] of spec.orderedView) {
            it(`${endpoint} · ${role} delivers ≥1 field`, () => {
                const perModel = spec.returns!.map(model => ({
                    model,
                    delivered: deliveredFields(model, tokens),
                }));
                const total = perModel.reduce((n, m) => n + m.delivered.length, 0);
                // A view that delivers nothing across the whole bag is deny-all /
                // over-narrow — the admitted persona gets a 200 with no data.
                if (total === 0) {
                    throw new Error(
                        `${endpoint} [${role}] delivers ZERO fields under [${tokens.join(', ')}].\n` +
                            `Per-model: ${JSON.stringify(perModel)}\n` +
                            `An admitted persona must receive data; this view is deny-all / over-narrow.`,
                    );
                }
                expect(total).toBeGreaterThan(0);
            });
        }
    }
});
