/**
 * Declarative scope-resolution engine.
 *
 * The per-row scope resolver used to be an imperative `switch (modelName)` in
 * access-resolvers.ts. This file is the data-driven replacement: a small
 * `Match` vocabulary, the `evalMatch` interpreter, and `makeScopesHeld` which
 * turns a binding table into a resolver with the IDENTICAL signature
 * `(modelName, row, ctx) => Set<Scope>`.
 *
 * Why this exists: making resolution *data* (scopeBindings.ts) instead of code
 * is the minimum needed for the CI security validators below — `validateBindings`
 * (field-typo + forgotten-model catchers) and `validateRouteGrants` (the
 * route-grant ↔ binding-scope seam check). None of them can run against an
 * opaque switch. See docs/security/auth-consistency-analysis.md §7.
 *
 * The bindings + table live in scopeBindings.ts; this file is the generic
 * engine. Kept deliberately local to checkin-app/src/security — no package
 * extraction (that is §7.7, out of scope).
 *
 * IMPORTANT: This file is CODEOWNERS-gated.
 */
import { parseToken, type Scope } from './core';
import type { CallerContext } from './access-resolvers';

// Context accessors a binding may match a row field against. Kept in lockstep
// with the shape of CallerContext (access-resolvers.ts).
export type CtxScalar = 'selfId' | 'householdId';
export type CtxSet =
    | 'programsLed'
    | 'programsCoreVolIn'
    | 'participantIdsInScopePrograms'
    | 'householdIdsInScopePrograms'
    | 'eventIdsInScopePrograms'
    | 'activeVisitorIds'
    | 'ledHouseholdMemberIds';
export type CtxFlag = 'isKeyholder' | 'isKiosk';

export type ScopePredicate = (row: Record<string, unknown>, ctx: CallerContext) => boolean;

/**
 * One condition under which a caller holds a scope on a row.
 *
 *   { field, eqCtx } — row[field] === ctx[scalar]   (number-guarded)
 *   { field, inCtx } — ctx[set].has(row[field])     (array = OR over sets)
 *   { flag }         — ctx[flag] === true
 *   { field, isNull }— row[field] == null
 *   { field, isTrue }— row[field] === true
 *   { all }          — every sub-match (AND)
 *   { custom }       — escape hatch; SKIPS validation, must be logged
 */
export type Match =
    | { field: string; eqCtx: CtxScalar }
    | { field: string; inCtx: CtxSet | readonly CtxSet[] }
    | { flag: CtxFlag }
    | { field: string; isNull: true }
    | { field: string; isTrue: true }
    | { all: readonly Match[] }
    | { custom: ScopePredicate };

export type ScopeBindings = Record<string, Partial<Record<Scope, Match>>>;

/**
 * Evaluate one Match against a row + caller context.
 *
 * The `typeof v === 'number'` guards on eqCtx/inCtx are load-bearing: they
 * encode the old switch's `x !== undefined` checks. Without them an anonymous
 * caller (selfId === undefined) would spuriously match a row whose field is
 * also absent (undefined === undefined).
 */
export function evalMatch(m: Match, row: Record<string, unknown>, ctx: CallerContext): boolean {
    if ('flag' in m) return ctx[m.flag] === true;
    if ('isNull' in m) return row[m.field] == null;
    // Strict === true: an unselected column is `undefined`, which must not match.
    if ('isTrue' in m) return row[m.field] === true;
    if ('all' in m) return m.all.every(s => evalMatch(s, row, ctx));
    if ('custom' in m) return m.custom(row, ctx);
    if ('eqCtx' in m) {
        const v = row[m.field];
        return typeof v === 'number' && v === ctx[m.eqCtx];
    }
    // inCtx
    const v = row[m.field];
    if (typeof v !== 'number') return false;
    const sets: readonly CtxSet[] = Array.isArray(m.inCtx) ? m.inCtx : [m.inCtx];
    return sets.some(s => ctx[s].has(v));
}

/**
 * Build a per-row scope resolver from a binding table.
 *
 * Preserves the live switch's preamble exactly:
 *   - `everyones` is seeded on every (present) row...
 *   - ...EXCEPT a row-scoped model (one with a `rowScopeKeys` entry) whose
 *     scope key is absent or non-numeric, which fails CLOSED — returns NO
 *     scopes, not even `everyones`, so a missing selected column can never let
 *     an `everyones:*` (admin/board) view leak a whole row.
 *   - a null / non-object row: row-scoped models fail closed; others get the
 *     broad scope.
 *
 * `rowScopeKeys` is the new home of the old ROW_SCOPE_KEY map. The §7.3 doc
 * sketch dropped it; the live switch has it and the equivalence test (and the
 * existing EmergencyContact fail-closed unit tests) require it.
 */
export function makeScopesHeld(
    bindings: ScopeBindings,
    rowScopeKeys: Record<string, string> = {},
) {
    return (
        modelName: string,
        row: Record<string, unknown> | null | undefined,
        ctx: CallerContext,
    ): Set<Scope> => {
        const scopeKey = rowScopeKeys[modelName];

        if (!row || typeof row !== 'object') {
            return scopeKey !== undefined ? new Set<Scope>() : new Set<Scope>(['everyones']);
        }
        // Defense-in-depth: row-scoped model missing its scope key → fail closed.
        if (scopeKey !== undefined && typeof row[scopeKey] !== 'number') {
            return new Set<Scope>();
        }

        const scopes = new Set<Scope>(['everyones']);
        const modelBindings = bindings[modelName];
        if (modelBindings) {
            for (const [scope, match] of Object.entries(modelBindings)) {
                if (match && evalMatch(match, row, ctx)) scopes.add(scope as Scope);
            }
        }
        return scopes;
    };
}

// ─── Validators (authored for CI; NOT wired as gates in this chip — see §7.6) ──

/** Walk a model's scope map, descending into `all` combinators, yielding leaf+compound matches. */
function allMatches(scopeMap: Partial<Record<Scope, Match>>): Match[] {
    const out: Match[] = [];
    const visit = (m: Match) => {
        out.push(m);
        if ('all' in m) m.all.forEach(visit);
    };
    for (const m of Object.values(scopeMap)) if (m) visit(m);
    return out;
}

/**
 * Column names by which a non-admin actor could own a row. A model with
 * sensitive fields but NONE of these is structurally un-scopable — no `their_*`
 * binding is even expressible, so its sensitive fields are reachable only via
 * `everyones:*` (admin) grants. That is a derivable fact, not a human opt-out.
 *
 * `id` is intentionally excluded: it is a bare primary key on every model, so
 * judging on it makes isScopable true everywhere and falsely demands a binding
 * for admin-only log/settings models (BoardSettings, ErrorLog, etc.). It IS a
 * real scope field for Person/Household/Program (`field: 'id'`), but all
 * three are BOUND, and the coverage loop skips bound models BEFORE isScopable
 * runs — so isScopable only ever judges UNBOUND models, where `id` carries no
 * actor meaning. The truth about id-as-scope lives in SCOPE_BINDINGS, not here.
 *
 * ponytail: name-list heuristic; derive from schema FKs if it drifts.
 */
const SCOPABLE_FIELDS = new Set([
    'householdId',
    'programId',
    'personId',
    'userId',
    'actorId',
    'createdById',
    'uploadedByUserId',
]);

export function isScopable(
    model: string,
    classifications: Record<string, Record<string, string>>,
): boolean {
    return Object.keys(classifications[model] ?? {}).some(f => SCOPABLE_FIELDS.has(f));
}

/**
 * (a) field-existence — every `field:` in a binding must exist on that model
 *     (the typo catcher: `row.householdID` silently never grants today).
 * (b) coverage — every sensitive model must be bound, auto-exempt via
 *     isScopable(), or sitting in the pending-route work queue (the
 *     forgotten-model catcher).
 *
 * Returns the list of errors (empty = clean). Authoring only — not wired.
 */
export function validateBindings(
    bindings: ScopeBindings,
    classifications: Record<string, Record<string, string>>,
    pendingRoute: ReadonlySet<string>,
): string[] {
    const errors: string[] = [];

    // (a) field-existence
    for (const [model, scopeMap] of Object.entries(bindings)) {
        if (!(model in classifications)) {
            errors.push(`binding for unknown model '${model}'`);
            continue;
        }
        for (const m of allMatches(scopeMap)) {
            if ('field' in m && !(m.field in classifications[model])) {
                errors.push(`${model}.${m.field} — no such field`);
            }
            if ('custom' in m) {
                console.warn(`[security] ${model} has a custom (unvalidated) scope binding`);
            }
        }
    }

    // (b) coverage
    for (const [model, fields] of Object.entries(classifications)) {
        const hasSensitive = Object.values(fields).some(t => t !== 'public' && t !== 'secret');
        if (!hasSensitive) continue;
        if (model in bindings) continue;
        if (!isScopable(model, classifications)) {
            console.info(
                `[security] ${model}: sensitive but un-scopable (no actor FK) — admin-only by construction`,
            );
            continue;
        }
        if (pendingRoute.has(model)) continue;
        errors.push(
            `${model} is sensitive and scopable but has no binding and is not in ` +
                `OPT_OUT_PENDING_ROUTE — silent over-restriction`,
        );
    }

    return errors;
}

/**
 * The seam check: every `scope:tier` token a route GRANTS in its orderedView
 * must be RESOLVABLE on at least one model that route returns — else the grant
 * silently strips to nothing (over-restriction). See §8.
 *
 * NOTE: this cannot be wired as a CI gate until RouteSpec declares a `returns`
 * field listing the model(s) its bag may contain. That arrives with the
 * route-migration track (Step 3); this chip deliberately does NOT add `returns`
 * to RouteSpec. Authored here so it exists and is tested in isolation.
 */
export interface RouteGrantSpec {
    endpoint: string;
    orderedView: readonly (readonly [unknown, readonly string[]])[];
    // Optional: a route that hasn't declared its response surface is skipped by
    // validateRouteGrants (incremental coverage), not errored.
    returns?: readonly string[];
}

export function validateRouteGrants(
    routes: Iterable<RouteGrantSpec>,
    bindings: ScopeBindings,
): string[] {
    const errors: string[] = [];
    for (const spec of routes) {
        // `returns` is optional on RouteSpec — a route that hasn't declared its
        // response surface yet is skipped (incremental coverage), not errored.
        // The check tightens automatically as routes backfill `returns`.
        const returns = spec.returns ?? [];
        if (returns.length === 0) continue;
        const grantedScopes = new Set<Scope>();
        for (const [, tokens] of spec.orderedView) {
            for (const tok of tokens) {
                const parsed = parseToken(tok);
                if (parsed && parsed !== 'public' && parsed !== 'member') {
                    grantedScopes.add(parsed.scope);
                }
            }
        }
        for (const scope of grantedScopes) {
            // 'everyones' is seeded on every row by the engine — never needs a binding.
            if (scope === 'everyones') continue;
            const resolvable = returns.some(
                model => bindings[model] && scope in bindings[model]!,
            );
            if (!resolvable) {
                errors.push(
                    `${spec.endpoint}: grants '${scope}:*' but none of its returns ` +
                        `[${returns.join(', ')}] bind '${scope}' — that grant silently ` +
                        `resolves to nothing (over-restriction).`,
                );
            }
        }
    }
    return errors;
}
