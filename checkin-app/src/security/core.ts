/**
 * Security policy core: types and the registry singleton.
 *
 * Token grammar:
 *   'public'                — public-tier fields, always visible (no row gate)
 *   'member'                — member-tier fields; flat token (no row gate) like
 *                             'public', but held only by authenticated members.
 *                             Granted to authenticated-session views, NOT to
 *                             anonymous/kiosk views. A member view holds BOTH
 *                             'member' and 'public'; anon holds only 'public'.
 *   '<scope>:<tier>'        — tier ∈ {pii, personal, internal}; the grant
 *                             applies on rows where the caller holds <scope>
 *
 * Sensitive-tier SEMANTICS (which fields go where):
 *   'pii'      — contact-identity band (email, phone, googleId). Routinely
 *                grantable to operational roles: program leads, keyholders,
 *                background-check reviewers.
 *   'personal' — the STRICT band: intimate data (dateOfBirth, home address,
 *                allergies, emergency contacts, visit times). Self, own
 *                household, and board/sysadmin; any other grant must be a
 *                deliberate, per-route operational decision (e.g. a lead's
 *                own program participants).
 *   'internal' — org/system bookkeeping (role flags, process state, audit
 *                fields). Board/sysadmin, plus narrow self-scoped grants.
 *   scope = 'everyones'     — broad grant; held on every row by default, but a
 *                             row-scoped model missing its scope key fails
 *                             closed and does NOT hold it (see scopesHeld)
 *   scope = 'their_own' | 'their_households' | 'led_households'
 *           | 'their_program_participants' | 'all_current_visitors' — per-row
 *                             predicates evaluated by the handler against a
 *                             prefetched CallerContext.
 *
 * Field visibility (per row):
 *   - field.tier === 'secret'        → never
 *   - field.tier === 'public'        → iff view includes 'public'
 *   - field.tier === 'member'        → iff view includes 'member'
 *   - otherwise (pii/personal/internal):
 *       iff view includes 'everyones:<tier>',
 *       OR view includes '<scope>:<tier>' for some <scope> the caller holds
 *       on this row.
 *
 * Roles select the view at request time (first match wins in orderedView).
 * Scopes select fields at row time (computed by access-resolvers per row).
 *
 * IMPORTANT: This file is CODEOWNERS-gated.
 */
import { classifications, type Models, type FieldsOf } from './generated/classifications';
import type { BusinessRole } from '@/types/auth';
import { assertNever } from '@/lib/lifecycle/classify';

export type { Models, FieldsOf };
export { classifications };

export type SensitiveTier = 'pii' | 'personal' | 'internal';
export type Tier = 'public' | 'member' | SensitiveTier | 'secret';

export type Scope =
    | 'everyones'
    | 'their_own'
    | 'their_households'
    // Caller LEADS the household the row belongs to. Deliberately distinct from
    // their_households, which is household-WIDE (a non-lead member holds it):
    // this one is the "may act for another member" relationship, so it is the
    // right token wherever sharing a home is not by itself enough.
    | 'led_households'
    | 'their_program_participants'
    // Caller leads/core-vols a program that a child of this row's household is
    // enrolled in (used for Trusted Adult pickup notes).
    | 'their_program_households'
    // Caller is a isKeyholder (global — front-desk staff). Unconditional per-row.
    | 'keyholders'
    | 'all_current_visitors';

export type Token = 'public' | 'member' | `${Scope}:${SensitiveTier}`;

/**
 * Role vocabulary. Roles are properties of the caller (sometimes parameterised
 * by request params), not of any row. Per-row data scoping lives in `Scope`.
 */
export type Role =
    | 'anyone'
    | 'unauthenticated'
    | 'authenticated'
    | 'kiosk'
    | 'isSysadmin'
    | 'isBoardMember'
    | 'isKeyholder'
    | 'isBackgroundCheckReviewer'
    | 'isOperations'
    // Holds a MAY_CERTIFY_OTHERS toolStatus (a shop certifier). Not a Person
    // role boolean — derived from session.user.toolStatuses (see callerHoldsRole).
    | 'certifier'
    | 'householdLead'
    | 'programLeadMentor'
    | 'programCoreVolunteer';

const VALID_SCOPES = new Set<Scope>([
    'everyones',
    'their_own',
    'their_households',
    'led_households',
    'their_program_participants',
    'their_program_households',
    'keyholders',
    'all_current_visitors',
]);
const VALID_SENSITIVE_TIERS = new Set<SensitiveTier>(['pii', 'personal', 'internal']);
// Exported so a guard test can assert BusinessRole (types/auth.ts) ⊆ VALID_ROLES —
// the gap that let #1104 add isOperations to BusinessRole without adding it here.
export const VALID_ROLES = new Set<Role>([
    'anyone',
    'unauthenticated',
    'authenticated',
    'kiosk',
    'isSysadmin',
    'isBoardMember',
    'isKeyholder',
    'isBackgroundCheckReviewer',
    'isOperations',
    'certifier',
    'householdLead',
    'programLeadMentor',
    'programCoreVolunteer',
]);

export function parseToken(
    t: string,
): { scope: Scope; tier: SensitiveTier } | 'public' | 'member' | null {
    if (t === 'public') return 'public';
    if (t === 'member') return 'member';
    const colon = t.indexOf(':');
    if (colon < 1) return null;
    const scope = t.slice(0, colon);
    const tier = t.slice(colon + 1);
    if (!VALID_SCOPES.has(scope as Scope)) return null;
    if (!VALID_SENSITIVE_TIERS.has(tier as SensitiveTier)) return null;
    return { scope: scope as Scope, tier: tier as SensitiveTier };
}

/**
 * Admission gate — who is allowed to *call* the endpoint. Distinct from
 * `orderedView`, which controls *what* they see once admitted.
 */
export type Authorize =
    | 'public'
    | 'authenticated'
    | 'self'
    | { anyRole: BusinessRole[] }
    // Shop certifier (a MAY_CERTIFY_OTHERS toolStatus). Admits certifiers OR
    // admins (isSysadmin/isBoardMember) — see resolveAccess. Backed by a
    // predicate because 'certifier' is not a Person role boolean.
    | 'certifier'
    | 'program-lead-mentor'
    | 'program-core-volunteer'
    | 'household-lead'
    | 'household-member'
    | 'kiosk';

/**
 * Response envelope:
 *   - string key  → `{ [key]: payload }`
 *   - null        → payload directly (no wrapper)
 */
export type Envelope = string | null;

export type OrderedViewEntry = readonly [Role, readonly Token[]];

export interface RouteSpec {
    endpoint: string;
    authorize: Authorize;
    envelope: Envelope;
    /**
     * Ordered list of (role, token-grant). The handler walks top-to-bottom
     * and uses the first role the caller satisfies. Order matters and is
     * part of the policy — a CODEOWNERS reviewer should treat reorders as
     * meaningful.
     */
    orderedView: readonly OrderedViewEntry[];
    /**
     * The models this route's handler is declared to return (top-level bag keys
     * + the models reached through their relations). Optional documentation of
     * the response surface; consumed by the §8 seam validator to check the
     * declared set against what the handler actually ships. Not enforced by the
     * runtime stripper (that gates per-field regardless of this list).
     */
    returns?: readonly Models[];
}

/**
 * Outbound surfaces have no caller — the data is being sent to a third party.
 * `tiers` is the unconditional list of tiers allowed on the wire. Anything
 * not listed (and `secret` regardless) is stripped before `send()` runs.
 */
export interface OutboundSpec {
    surface: string;
    tiers: readonly ('public' | SensitiveTier)[];
}

/**
 * Which CallerContext prefetches a route can possibly consume — derived
 * statically from its RouteSpec (authorize + orderedView roles + granted token
 * scopes). buildCallerContext skips the DB queries behind any field not
 * needed, so a route whose grants never consult program/visitor scopes pays
 * zero context queries.
 *
 * Skipping is fail-closed by construction: an unfetched field is an empty
 * set, which can only SHRINK scopesHeld — and a scope no view token grants
 * can never flip fieldVisible anyway. The equivalence test
 * (tests/security/ctxNeeds.test.ts) proves output-identity per registered
 * route; the total switches below (assertNever) force this derivation to be
 * revisited whenever a Scope/Role/Authorize variant is added.
 */
export interface CtxNeeds {
    /** programsLed, programsCoreVolIn, participantIdsInScopePrograms */
    programs: boolean;
    /** householdIdsInScopePrograms (implies programs) */
    programHouseholds: boolean;
    /** eventIdsInScopePrograms (implies programs) */
    programEvents: boolean;
    /** activeVisitorIds (fetched only for keyholders) */
    activeVisitors: boolean;
    /** ledHouseholdMemberIds (fetched only for household leads) */
    ledHouseholdMembers: boolean;
}

export const ALL_CTX_NEEDS: CtxNeeds = Object.freeze({
    programs: true,
    programHouseholds: true,
    programEvents: true,
    activeVisitors: true,
    ledHouseholdMembers: true,
});

function scopeNeeds(scope: Scope): Partial<CtxNeeds> {
    switch (scope) {
        case 'everyones':
        case 'their_own':
        case 'their_households':
        case 'keyholders':
            // Resolved from the session alone — no prefetch.
            return {};
        case 'led_households':
            // Visit (and any future model keyed on personId rather than
            // householdId) reaches the household only through its members.
            return { ledHouseholdMembers: true };
        case 'their_program_participants':
            // participantIds AND (RSVP/Visit) eventIds both hang off this scope;
            // the bag's models aren't statically known, so fetch both.
            return { programs: true, programEvents: true };
        case 'their_program_households':
            return { programs: true, programHouseholds: true };
        case 'all_current_visitors':
            return { activeVisitors: true };
        default:
            return assertNever(scope);
    }
}

function roleNeeds(role: Role): Partial<CtxNeeds> {
    switch (role) {
        case 'anyone':
        case 'unauthenticated':
        case 'authenticated':
        case 'kiosk':
        case 'isSysadmin':
        case 'isBoardMember':
        case 'isKeyholder':
        case 'isBackgroundCheckReviewer':
        case 'isOperations':
        case 'certifier':
        case 'householdLead':
            // callerHoldsRole answers these from the session alone.
            return {};
        case 'programLeadMentor':
        case 'programCoreVolunteer':
            return { programs: true };
        default:
            return assertNever(role);
    }
}

function authorizeNeeds(authorize: Authorize): Partial<CtxNeeds> {
    if (typeof authorize !== 'string') return {}; // anyRole — session flags only
    switch (authorize) {
        case 'public':
        case 'authenticated':
        case 'self':
        case 'certifier':
        case 'household-lead':
        case 'household-member':
        case 'kiosk':
            return {};
        case 'program-lead-mentor':
        case 'program-core-volunteer':
            return { programs: true };
        default:
            return assertNever(authorize);
    }
}

export function deriveCtxNeeds(spec: RouteSpec): CtxNeeds {
    const needs: CtxNeeds = {
        programs: false,
        programHouseholds: false,
        programEvents: false,
        activeVisitors: false,
        ledHouseholdMembers: false,
    };
    Object.assign(needs, authorizeNeeds(spec.authorize));
    for (const [role, tokens] of spec.orderedView) {
        Object.assign(needs, roleNeeds(role));
        for (const tok of tokens) {
            const parsed = parseToken(tok);
            if (parsed !== null && typeof parsed === 'object') {
                Object.assign(needs, scopeNeeds(parsed.scope));
            }
        }
    }
    return needs;
}

/** A RouteSpec as stored: ctxNeeds is DERIVED at registration, never authored. */
export interface RegisteredRoute extends RouteSpec {
    readonly ctxNeeds: CtxNeeds;
}

const _routes = new Map<string, RegisteredRoute>();
const _outbounds = new Map<string, OutboundSpec>();

export function defineRoute(spec: RouteSpec): RouteSpec {
    if (_routes.has(spec.endpoint)) {
        throw new Error(`Duplicate route registration: ${spec.endpoint}`);
    }
    const seenRoles = new Set<string>();
    for (const [role, tokens] of spec.orderedView) {
        if (!VALID_ROLES.has(role)) {
            throw new Error(`Route ${spec.endpoint}: unknown role '${role}'`);
        }
        if (seenRoles.has(role)) {
            throw new Error(`Route ${spec.endpoint}: duplicate role '${role}' in orderedView`);
        }
        seenRoles.add(role);
        for (const tok of tokens) {
            if (parseToken(tok) === null) {
                throw new Error(`Route ${spec.endpoint}: invalid token '${tok}'`);
            }
        }
    }
    // Derived AFTER validation (deriveCtxNeeds assumes tokens parse). The spread
    // order means an (illegally) author-supplied ctxNeeds is overwritten.
    _routes.set(spec.endpoint, { ...spec, ctxNeeds: deriveCtxNeeds(spec) });
    return spec;
}

export function defineOutbound(spec: OutboundSpec): OutboundSpec {
    if (_outbounds.has(spec.surface)) {
        throw new Error(`Duplicate outbound surface: ${spec.surface}`);
    }
    for (const t of spec.tiers) {
        if (t !== 'public' && !VALID_SENSITIVE_TIERS.has(t as SensitiveTier)) {
            throw new Error(`Outbound ${spec.surface}: invalid tier '${t}'`);
        }
    }
    _outbounds.set(spec.surface, spec);
    return spec;
}

export function getRoute(endpoint: string): RegisteredRoute | undefined {
    return _routes.get(endpoint);
}

export function getOutbound(surface: string): OutboundSpec | undefined {
    return _outbounds.get(surface);
}

export function allRoutes(): IterableIterator<[string, RegisteredRoute]> {
    return _routes.entries();
}

export function allOutbounds(): IterableIterator<[string, OutboundSpec]> {
    return _outbounds.entries();
}

/**
 * The single field-visibility predicate used by both the handler stripper
 * and the contract tests.
 */
export function fieldVisible(
    tier: Tier,
    tokens: readonly Token[],
    scopesHeld: ReadonlySet<Scope>,
): boolean {
    if (tier === 'secret') return false;
    if (tier === 'public') return tokens.includes('public');
    if (tier === 'member') return tokens.includes('member');
    for (const tok of tokens) {
        if (tok === 'public' || tok === 'member') continue;
        const parsed = parseToken(tok);
        if (parsed === null || parsed === 'public' || parsed === 'member') continue;
        if (parsed.tier !== tier) continue;
        // 'everyones' is a normal scope here: scopesHeld() seeds it for every
        // row EXCEPT a row-scoped model whose scope key is absent, which fails
        // closed by omitting it. So even an everyones:* grant is gated on the
        // caller actually holding the everyones scope on this row.
        if (scopesHeld.has(parsed.scope)) return true;
    }
    return false;
}
