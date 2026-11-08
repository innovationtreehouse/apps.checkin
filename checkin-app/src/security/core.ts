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
 *   '<scope>:<tier>'        — tier ∈ {pii, personal, internal, hardship}; the
 *                             grant applies on rows where the caller holds <scope>
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
 *   'hardship' — whether a person or household asked for, holds, was granted
 *                or was refused help with a fee (a payment plan, a scholarship,
 *                a comp). Board and finance views only, plus the family's own
 *                rows; never a sysadmin or another staff role by default
 *                (docs/rules/revenue.md, Ownership).
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
 *   - otherwise (pii/personal/internal/hardship):
 *       iff view includes 'everyones:<tier>',
 *       OR view includes '<scope>:<tier>' for some <scope> the caller holds
 *       on this row.
 *
 * Roles select the view at request time (first match wins in orderedView).
 * Scopes select fields at row time (computed by access-resolvers per row).
 *
 * IMPORTANT: This file is CODEOWNERS-gated.
 */
import {
    classifications as checkinClassifications,
    relations as checkinRelations,
    marks as checkinMarks,
} from './generated/classifications';
import {
    classifications as catalogClassifications,
    relations as catalogRelations,
    marks as catalogMarks,
} from './generated/catalog-classifications';
import {
    classifications as catalogSyntheticClassifications,
    relations as catalogSyntheticRelations,
    marks as catalogSyntheticMarks,
} from './catalogSyntheticClassifications';
import * as inventoryGenerated from './generated/inventory-classifications';
import * as inventorySynthetic from './inventorySyntheticClassifications';
import * as expenseGenerated from './generated/expense-classifications';
import * as expenseSynthetic from './expenseSyntheticClassifications';
import * as incomeGenerated from './generated/income-classifications';
import * as incomeSynthetic from './incomeSyntheticClassifications';
import * as donationGenerated from './generated/donation-classifications';
import * as donationSynthetic from './donationSyntheticClassifications';
import * as workflowGenerated from './generated/workflow-classifications';
import * as workflowSynthetic from './workflowSyntheticClassifications';
import * as receiptGenerated from './generated/receipt-classifications';
import * as receiptSynthetic from './receiptSyntheticClassifications';
import * as programSynthetic from './programSyntheticClassifications';
import * as budgetOwnerSynthetic from './budgetOwnerSyntheticClassifications';
import * as keyVolunteerSynthetic from './keyVolunteerSyntheticClassifications';
import * as problemsSynthetic from './problemsSyntheticClassifications';
import * as shopifyReadGenerated from './generated/shopify-read-classifications';
import * as shopifyReadSynthetic from './shopifyReadSyntheticClassifications';
import type { BusinessRole } from '@/types/auth';
import { assertNever } from '@/lib/lifecycle/classify';

// Every classification source: checkin's schema, each vendored library's schema
// (its own `generator security` map), and hand-authored synthetic response
// models (e.g. CatalogItemCount). The flat merge below is
// the whole-system map every boundary consumer (stripper, outbound, registry)
// reads through — import `classifications` / `relations` from here, not from a
// source file. Model keys must be disjoint across sources, or a later source
// silently overwrites an earlier one; __tests__/classification-sources.test.ts
// enforces that.
export const CLASSIFICATION_SOURCES = [
    { source: 'checkin', classifications: checkinClassifications, relations: checkinRelations, marks: checkinMarks },
    { source: 'global-catalog', classifications: catalogClassifications, relations: catalogRelations, marks: catalogMarks },
    { source: 'catalog-synthetic', classifications: catalogSyntheticClassifications, relations: catalogSyntheticRelations, marks: catalogSyntheticMarks },
    { source: 'inventory', classifications: inventoryGenerated.classifications, relations: inventoryGenerated.relations, marks: inventoryGenerated.marks },
    { source: 'inventory-synthetic', classifications: inventorySynthetic.classifications, relations: inventorySynthetic.relations, marks: inventorySynthetic.marks },
    { source: 'expense', classifications: expenseGenerated.classifications, relations: expenseGenerated.relations, marks: expenseGenerated.marks },
    { source: 'expense-synthetic', classifications: expenseSynthetic.classifications, relations: expenseSynthetic.relations, marks: expenseSynthetic.marks },
    { source: 'income', classifications: incomeGenerated.classifications, relations: incomeGenerated.relations, marks: incomeGenerated.marks },
    { source: 'income-synthetic', classifications: incomeSynthetic.classifications, relations: incomeSynthetic.relations, marks: incomeSynthetic.marks },
    { source: 'donation', classifications: donationGenerated.classifications, relations: donationGenerated.relations, marks: donationGenerated.marks },
    { source: 'donation-synthetic', classifications: donationSynthetic.classifications, relations: donationSynthetic.relations, marks: donationSynthetic.marks },
    { source: 'workflow', classifications: workflowGenerated.classifications, relations: workflowGenerated.relations, marks: workflowGenerated.marks },
    { source: 'workflow-synthetic', classifications: workflowSynthetic.classifications, relations: workflowSynthetic.relations, marks: workflowSynthetic.marks },
    { source: 'receipt', classifications: receiptGenerated.classifications, relations: receiptGenerated.relations, marks: receiptGenerated.marks },
    { source: 'receipt-synthetic', classifications: receiptSynthetic.classifications, relations: receiptSynthetic.relations, marks: receiptSynthetic.marks },
    { source: 'program-synthetic', classifications: programSynthetic.classifications, relations: programSynthetic.relations, marks: programSynthetic.marks },
    { source: 'budget-owner-synthetic', classifications: budgetOwnerSynthetic.classifications, relations: budgetOwnerSynthetic.relations, marks: budgetOwnerSynthetic.marks },
    { source: 'key-volunteer-synthetic', classifications: keyVolunteerSynthetic.classifications, relations: keyVolunteerSynthetic.relations, marks: keyVolunteerSynthetic.marks },
    { source: 'problems-synthetic', classifications: problemsSynthetic.classifications, relations: problemsSynthetic.relations, marks: problemsSynthetic.marks },
    { source: 'shopify-read', classifications: shopifyReadGenerated.classifications, relations: shopifyReadGenerated.relations, marks: shopifyReadGenerated.marks },
    { source: 'shopify-read-synthetic', classifications: shopifyReadSynthetic.classifications, relations: shopifyReadSynthetic.relations, marks: shopifyReadSynthetic.marks },
] as const;

type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];
type MergeSources<S extends readonly ClassificationSource[], K extends 'classifications' | 'relations'> =
    S extends readonly [infer Head extends ClassificationSource, ...infer Rest extends readonly ClassificationSource[]]
        ? Head[K] & MergeSources<Rest, K>
        : unknown;

function mergeSources(key: 'classifications' | 'relations' | 'marks'): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const s of CLASSIFICATION_SOURCES) Object.assign(merged, s[key]);
    return merged;
}

export const classifications = mergeSources('classifications') as MergeSources<typeof CLASSIFICATION_SOURCES, 'classifications'>;
export const relations = mergeSources('relations') as MergeSources<typeof CLASSIFICATION_SOURCES, 'relations'>;
/** Finance marks per model: a response carrying one of these fields is a logged finance view. */
export const marks = mergeSources('marks') as Readonly<Record<string, readonly string[]>>;

export type Models = keyof typeof classifications;
export type FieldsOf<M extends Models> = keyof (typeof classifications)[M];

export type SensitiveTier = 'pii' | 'personal' | 'internal' | 'hardship';
export type Tier = 'public' | 'member' | SensitiveTier | 'secret';

const SCOPES = [
    'everyones',
    'their_own',
    'their_households',
    // Caller LEADS the household the row belongs to. Deliberately distinct from
    // their_households, which is household-WIDE (a non-lead member holds it):
    // this one is the "may act for another member" relationship, so it is the
    // right token wherever sharing a home is not by itself enough.
    'led_households',
    'their_program_participants',
    // Caller leads/core-vols a program that a child of this row's household is
    // enrolled in (used for Trusted Adult pickup notes).
    'their_program_households',
    // Caller is a isKeyholder (global — front-desk staff). Unconditional per-row.
    'keyholders',
    'all_current_visitors',
] as const;

export type Scope = (typeof SCOPES)[number];

export type Token = 'public' | 'member' | `${Scope}:${SensitiveTier}`;

/**
 * Role vocabulary. Roles are properties of the caller (sometimes parameterised
 * by request params), not of any row. Per-row data scoping lives in `Scope`.
 */
export const ROLES = [
    'anyone',
    'unauthenticated',
    'authenticated',
    'kiosk',
    'isSysadmin',
    'isBoardMember',
    'isKeyholder',
    'isBackgroundCheckReviewer',
    'isOperations',
    // Curates the global catalog. A Person role boolean, stamped on
    // the session like the others; grants the manager view on catalog routes.
    'isInventoryManager',
    // Finance staff. A Person role boolean, stamped on the session
    // like the others; grants the finance view on finance-library routes.
    'isFinance',
    // Holds a MAY_CERTIFY_OTHERS toolStatus (a shop certifier). Not a Person
    // role boolean — derived from session.user.toolStatuses (see callerHoldsRole).
    'certifier',
    'householdLead',
    'programLeadMentor',
    'programCoreVolunteer',
] as const;

export type Role = (typeof ROLES)[number];

const SCOPE_NAMES: ReadonlySet<string> = new Set(SCOPES);
const VALID_SENSITIVE_TIERS = new Set<SensitiveTier>(['pii', 'personal', 'internal', 'hardship']);

export function parseToken(
    t: string,
): { scope: Scope; tier: SensitiveTier } | 'public' | 'member' | null {
    if (t === 'public') return 'public';
    if (t === 'member') return 'member';
    const colon = t.indexOf(':');
    if (colon < 1) return null;
    const scope = t.slice(0, colon);
    const tier = t.slice(colon + 1);
    if (!SCOPE_NAMES.has(scope)) return null;
    if (!VALID_SENSITIVE_TIERS.has(tier as SensitiveTier)) return null;
    return { scope: scope as Scope, tier: tier as SensitiveTier };
}

// Fails to compile if a session flag, BusinessRole included, is not a Role.
type RoleSubset<T extends Role> = T;

/** Roles backed by a Person role flag on the session — what `anyRole` checks. */
export type SessionFlagRole = RoleSubset<BusinessRole | 'isInventoryManager' | 'isFinance'>;

/**
 * Admission gate — who is allowed to *call* the endpoint. Distinct from
 * `orderedView`, which controls *what* they see once admitted.
 */
export type Authorize =
    | 'public'
    | 'authenticated'
    | 'self'
    // Admits a caller holding any listed role flag. No sysadmin/board auto-admit.
    | { anyRole: SessionFlagRole[] }
    // Catalog read admission: the single chokepoint for reading the global
    // catalog — the catalog audience (canSeeCatalog, lib/volunteer.ts), decided
    // from session claims (docs/rules/inventory.md, Access). Broader than the ops
    // roles, deliberately: the catalog is non-pii reference data (writes stay
    // INVENTORY_MANAGER-only).
    | 'catalog-viewer'
    // Receipt submission: an adult whose household membership is
    // ACTIVE, or a Treehouse Volunteer (role holder or staff account) whatever
    // their age or membership. No background check (docs/rules/expenses.md).
    | 'receipt-submitter'
    // Catalog write admission: INVENTORY_MANAGER only.
    | 'inventory-manager'
    // FINANCE only. No sysadmin auto-admit: Finance Ops excludes
    // sysadmins (docs/rules/revenue.md).
    | 'finance'
    // FINANCE or BOARD: the board acts as finance's
    // superuser. No sysadmin auto-admit, as above.
    | 'finance-or-board'
    // A budget-bucket approver: FINANCE, BOARD, or anyone who approves
    // some bucket. No sysadmin auto-admit. Rows stay handler-filtered to the
    // buckets the caller approves.
    | 'expense-approver'
    // Expense sign-off admission: `receipt-submitter` (an adult member or
    // Treehouse Volunteer, for the submitter seat) or `expense-approver` (program
    // approver, Treasurer, Board seats). Far wider than the seat holders; the
    // library refuses a caller who holds no seat on the line.
    | 'expense-signer'
    // Shop certifier (a MAY_CERTIFY_OTHERS toolStatus). Admits certifiers OR
    // admins (isSysadmin/isBoardMember) — see resolveAccess. Backed by a
    // predicate because 'certifier' is not a Person role boolean.
    | 'certifier'
    | 'program-lead-mentor'
    | 'program-core-volunteer'
    | 'household-lead'
    | 'household-member'
    | 'kiosk'
    // A scheduled job holding the named machine secret (CRON_SECRET_ENV). Only
    // `Authorization: Bearer <secret>` admits; a session never does.
    | { cronSecret: CronSecretName };

/**
 * Machine secrets a cron route may name in `authorize: { cronSecret }`, each
 * read from its own env var so holding one never admits another job's route.
 */
export const CRON_SECRET_ENV = {
    'qbo-posting': 'QBO_POSTING_CRON_SECRET',
} as const;
export type CronSecretName = keyof typeof CRON_SECRET_ENV;

/**
 * Response envelope:
 *   - string key  → `{ [key]: payload }`
 *   - null        → payload directly (no wrapper)
 */
export type Envelope = string | null;

export type OrderedViewEntry = readonly [Role, readonly Token[]];

/** Records that live only in another system, named by system and record type. */
export const OUTSIDE_RECORD_NAMES = ['QuickBooks.Transaction', 'Benevity.Disbursement'] as const;

/**
 * A declared record id: a field of the row, a nested path (`members[].id`, or `dismissed[]`
 * for a list of ids), several fields joined into one id, or a path param.
 */
export type FinanceViewId = string | readonly string[] | { readonly param: string };

/** The model an id belongs to, or a field of the row whose value picks the model. */
export type FinanceViewModel = string | { readonly field: string; readonly map: Readonly<Record<string, string>> };

export interface FinanceViewRecordSpec {
    /** The bag key whose rows hold the records. */
    readonly key: Models;
    readonly id: FinanceViewId;
    readonly model: FinanceViewModel;
}

export interface FinanceViewSpec {
    readonly records?: readonly FinanceViewRecordSpec[];
    /** The query parameters that pick the screen; any other parameter stays out of the log. */
    readonly query?: readonly string[];
}

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
     * the response surface; consumed by the seam validator (validateRouteGrants) to check the
     * declared set against what the handler actually ships. Not enforced by the
     * runtime stripper (that gates per-field regardless of this list).
     */
    returns?: readonly Models[];
    /**
     * Which records a finance view on this route names, where the default (each top-level
     * row by its own model and `id`) is wrong, and which query parameters pick the screen.
     * GET only. Checked at registration by {@link financeViewErrors}.
     */
    financeView?: FinanceViewSpec;
    /** Admits a session with an open household question, which every other route refuses. */
    allowJoinPending?: true;
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
    /** householdMemberIds: the finance-view own-record check for household-owned records */
    householdMembers: boolean;
}

export const ALL_CTX_NEEDS: CtxNeeds = Object.freeze({
    programs: true,
    programHouseholds: true,
    programEvents: true,
    activeVisitors: true,
    ledHouseholdMembers: true,
    householdMembers: true,
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
        case 'isInventoryManager':
        case 'isFinance':
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
    if (typeof authorize !== 'string') return {}; // anyRole reads session flags; cronSecret reads a header
    switch (authorize) {
        case 'public':
        case 'authenticated':
        case 'self':
        case 'catalog-viewer':
        case 'receipt-submitter':
        case 'inventory-manager':
        case 'finance':
        case 'finance-or-board':
        case 'expense-approver':
        case 'expense-signer':
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

/**
 * Models a household owns for the finance-view own-record check: any member's view of
 * their household's rows is a view of their own (docs/in-design/FINANCE_VIEW_RECORD_IDS.md).
 */
export const HOUSEHOLD_OWNED_FINANCE_MODELS: ReadonlySet<string> = new Set(['ProgramParticipant', 'OrgMembershipProcess']);

export function deriveCtxNeeds(
    spec: Pick<RouteSpec, 'authorize' | 'orderedView'> & { returns?: readonly string[] },
): CtxNeeds {
    const needs: CtxNeeds = {
        programs: false,
        programHouseholds: false,
        programEvents: false,
        activeVisitors: false,
        ledHouseholdMembers: false,
        householdMembers: (spec.returns ?? []).some(model => HOUSEHOLD_OWNED_FINANCE_MODELS.has(model)),
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

/**
 * Content types a file route may serve — the owner-approved delivery allowlist.
 * Each type's response headers are fixed by fileHandler (./fileHandler.ts), not
 * chosen by the route.
 */
export const FILE_CONTENT_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
] as const;
export type FileContentType = (typeof FILE_CONTENT_TYPES)[number];

/**
 * A file route (plan rule 7: files are not JSON). Serves the bytes of exactly
 * one classified field, `file`, to a caller who passes `authorize` and whose
 * view (first matching `orderedView` role) covers that field on the row. A
 * field a file route serves is file-only: the JSON stripper never emits it.
 * Always GET; never `public` or `kiosk` — a file goes only to an identified
 * person.
 */
export interface FileRouteSpec {
    endpoint: string;
    authorize: Exclude<Authorize, 'public' | 'kiosk'>;
    orderedView: readonly OrderedViewEntry[];
    file: { model: Models; field: string };
}

export interface RegisteredFileRoute extends FileRouteSpec {
    readonly ctxNeeds: CtxNeeds;
}

const _routes = new Map<string, RegisteredRoute>();
const _fileRoutes = new Map<string, RegisteredFileRoute>();
const _fileOnlyFields = new Set<string>();
const _outbounds = new Map<string, OutboundSpec>();

function assertValidRegistration(endpoint: string, orderedView: readonly OrderedViewEntry[]): void {
    if (_routes.has(endpoint) || _fileRoutes.has(endpoint)) {
        throw new Error(`Duplicate route registration: ${endpoint}`);
    }
    const seenRoles = new Set<string>();
    for (const [role, tokens] of orderedView) {
        if (!ROLES.includes(role)) {
            throw new Error(`Route ${endpoint}: unknown role '${role}'`);
        }
        if (seenRoles.has(role)) {
            throw new Error(`Route ${endpoint}: duplicate role '${role}' in orderedView`);
        }
        seenRoles.add(role);
        for (const tok of tokens) {
            if (parseToken(tok) === null) {
                throw new Error(`Route ${endpoint}: invalid token '${tok}'`);
            }
        }
    }
}

export function defineRoute(spec: RouteSpec): RouteSpec {
    assertValidRegistration(spec.endpoint, spec.orderedView);
    const declarationErrors = financeViewErrors(spec);
    if (declarationErrors.length > 0) {
        throw new Error(`Route ${spec.endpoint}: bad finance-view declaration:\n  ${declarationErrors.join('\n  ')}`);
    }
    // Derived AFTER validation (deriveCtxNeeds assumes tokens parse). The spread
    // order means an (illegally) author-supplied ctxNeeds is overwritten.
    _routes.set(spec.endpoint, { ...spec, ctxNeeds: deriveCtxNeeds(spec) });
    return spec;
}

export function defineFileRoute(spec: FileRouteSpec): FileRouteSpec {
    const { endpoint, authorize, file } = spec;
    if (!endpoint.startsWith('GET ')) {
        throw new Error(`File route ${endpoint}: must be a GET endpoint`);
    }
    if (authorize === ('public' as Authorize) || authorize === ('kiosk' as Authorize)) {
        throw new Error(`File route ${endpoint}: authorize '${authorize}' is not allowed`);
    }
    assertValidRegistration(endpoint, spec.orderedView);
    const tiers = classifications[file.model] as Record<string, Tier> | undefined;
    const tier = tiers?.[file.field];
    if (tier === undefined) {
        throw new Error(`File route ${endpoint}: unknown field ${file.model}.${file.field}`);
    }
    if (tier === 'secret') {
        throw new Error(`File route ${endpoint}: ${file.model}.${file.field} is secret and never leaves`);
    }
    _fileRoutes.set(endpoint, { ...spec, ctxNeeds: deriveCtxNeeds({ ...spec, returns: [file.model] }) });
    _fileOnlyFields.add(`${file.model}.${file.field}`);
    return spec;
}

/** True iff a registered file route serves this field — the stripper drops it. */
export function isFileOnlyField(model: string, field: string): boolean {
    return _fileOnlyFields.has(`${model}.${field}`);
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

export function getFileRoute(endpoint: string): RegisteredFileRoute | undefined {
    return _fileRoutes.get(endpoint);
}

export function allFileRoutes(): IterableIterator<[string, RegisteredFileRoute]> {
    return _fileRoutes.entries();
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

// ---------------------------------------------------------------------------
// Finance-view declarations (docs/in-design/FINANCE_VIEW_RECORD_IDS.md §2)
// ---------------------------------------------------------------------------

type RelationMap = Readonly<Record<string, Readonly<Record<string, { model: string; isList: boolean }>>>>;
type TierMap = Readonly<Record<string, Readonly<Record<string, Tier>>>>;
const tierMap = classifications as unknown as TierMap;
const relationMap = relations as unknown as RelationMap;
const ALL_SCOPES: ReadonlySet<Scope> = new Set(SCOPES);

/** A declared id path: `list[].field`, `list[]`, or a plain `field`. */
export function parseIdPath(path: string): { list: string | null; field: string | null } {
    const at = path.indexOf('[]');
    if (at === -1) return { list: null, field: path };
    const rest = path.slice(at + 2);
    return { list: path.slice(0, at), field: rest.startsWith('.') ? rest.slice(1) : null };
}

export function modelRelations(model: string): Readonly<Record<string, { model: string; isList: boolean }>> {
    return relationMap[model] ?? {};
}

function tierOf(model: string, field: string): Tier | undefined {
    return tierMap[model]?.[field];
}

function anyScopeSees(tokens: readonly Token[], model: string, field: string): boolean {
    const tier = tierOf(model, field);
    return tier !== undefined && fieldVisible(tier, tokens, ALL_SCOPES);
}

/** True when some role holding `tokens` can be sent a marked field on `model` or its nested rows. */
export function marksVisible(tokens: readonly Token[], model: string, seen: Set<string> = new Set()): boolean {
    if (seen.has(model)) return false;
    seen.add(model);
    if ((marks[model] ?? []).some(field => anyScopeSees(tokens, model, field))) return true;
    return Object.values(modelRelations(model)).some(rel => marksVisible(tokens, rel.model, seen));
}

/** Every marked field is classified on its model. */
export function markErrors(): string[] {
    const errors: string[] = [];
    for (const [model, fields] of Object.entries(marks)) {
        for (const field of fields) {
            if (tierOf(model, field) === undefined) errors.push(`${model}.${field} is marked but not classified`);
        }
    }
    return errors;
}

function recordModelErrors(model: FinanceViewModel, elementModel: string): string[] {
    const known = (name: string) => name in tierMap || (OUTSIDE_RECORD_NAMES as readonly string[]).includes(name);
    if (typeof model === 'string') return known(model) ? [] : [`model '${model}' is neither classified nor an outside name`];
    const errors: string[] = [];
    if (tierOf(elementModel, model.field) === undefined) errors.push(`model field ${elementModel}.${model.field} is not classified`);
    const values = Object.values(model.map);
    if (values.length === 0) errors.push(`model map on '${model.field}' is empty`);
    for (const name of values) if (!known(name)) errors.push(`model '${name}' is neither classified nor an outside name`);
    return errors;
}

function recordErrors(spec: Pick<RouteSpec, 'endpoint' | 'orderedView' | 'returns'>, record: FinanceViewRecordSpec): string[] {
    const { key, id, model } = record;
    if (!(key in tierMap)) return [`key '${key}' is not a classified model`];
    const errors: string[] = [];
    if (spec.returns && !spec.returns.includes(key)) errors.push(`key '${key}' is not in the route's returns`);

    // The fields that must reach every role that can see a marked field: [model, field].
    const needed: [string, string][] = [];
    let elementModel: string = key;
    if (typeof id === 'object' && !Array.isArray(id) && 'param' in id) {
        if (!spec.endpoint.includes(`[${id.param}]`)) errors.push(`param '${id.param}' is not in the endpoint path`);
    } else {
        const paths: readonly string[] = typeof id === 'string' ? [id] : (id as readonly string[]);
        if (paths.length === 0) errors.push('id lists no field');
        const parsed = paths.map(parseIdPath);
        const lists = new Set(parsed.map(p => p.list));
        if (lists.size > 1) errors.push(`id fields ${paths.join(', ')} are not on one row`);
        const list = parsed[0]?.list ?? null;
        if (list !== null) {
            const rel = modelRelations(key)[list];
            if (rel) {
                elementModel = rel.model;
            } else if (tierOf(key, list) !== undefined) {
                needed.push([key, list]);
                if (parsed.some(p => p.field !== null)) errors.push(`'${list}' is a field of ${key}, not a nested row`);
            } else {
                errors.push(`'${list}' is neither a relation nor a field of ${key}`);
            }
        }
        for (const p of parsed) {
            if (p.field === null) continue;
            if (tierOf(elementModel, p.field) === undefined) errors.push(`id field ${elementModel}.${p.field} is not classified`);
            else needed.push([elementModel, p.field]);
        }
    }
    errors.push(...recordModelErrors(model, elementModel));
    if (typeof model === 'object' && tierOf(elementModel, model.field) !== undefined) needed.push([elementModel, model.field]);

    for (const [role, tokens] of spec.orderedView) {
        if (!marksVisible(tokens, key)) continue;
        for (const [m, f] of needed) {
            if (!anyScopeSees(tokens, m, f)) errors.push(`role '${role}' can see a marked field on ${key} but not ${m}.${f}`);
        }
    }
    return errors;
}

/**
 * Why a route's finance-view declaration is unsound, or [] when it is sound. A route
 * that can send a marked field on top-level rows with no `id` must declare their records.
 */
export function financeViewErrors(spec: Pick<RouteSpec, 'endpoint' | 'orderedView' | 'returns' | 'financeView'>): string[] {
    const declaration = spec.financeView;
    if (!spec.endpoint.startsWith('GET ')) {
        return declaration ? ['financeView is allowed only on a GET endpoint'] : [];
    }
    const errors: string[] = [];
    const returns = spec.returns ?? [];
    const nested = new Set(returns.flatMap(model => Object.values(modelRelations(model)).map(rel => rel.model)));
    const declared = new Set((declaration?.records ?? []).map(r => r.key));
    for (const model of returns) {
        if (nested.has(model) || declared.has(model) || tierOf(model, 'id') !== undefined) continue;
        if (spec.orderedView.some(([, tokens]) => marksVisible(tokens, model))) {
            errors.push(`${model} can carry a marked field on rows with no id; declare its records`);
        }
    }
    for (const record of declaration?.records ?? []) {
        errors.push(...recordErrors(spec, record).map(e => `${record.key}: ${e}`));
    }
    const query = declaration?.query ?? [];
    if (query.some(q => q.length === 0) || new Set(query).size !== query.length) {
        errors.push('query names must be non-empty and distinct');
    }
    return errors;
}
