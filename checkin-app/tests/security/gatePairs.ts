/**
 * Client gate ↔ server Authorize token pairs (threat model D35). Each library's
 * nav entries, pages and count providers decide visibility with a client
 * predicate; the routes behind them admit with a token resolved in
 * security/access-resolvers.ts. gateEquality.test.ts asserts each pair admits
 * the same GATE_PERSONAS. A new library adds one line to GATE_PAIRS.
 */
import type { TodoCounts } from '@/lib/nav/todoCounts';
import { PAGES } from '@/components/pageRegistry';
import type { NavSection } from '@/lib/nav/types';
import { linkGate } from '@/lib/nav/gates';
import { FINANCE } from '@/lib/nav/sections/finance';
import { INVENTORY } from '@/lib/nav/sections/inventory';
import { REVENUE_OPS } from '@/lib/nav/sections/revenueOps';
import { canSeeCatalog, canSubmitReceipts } from '@/lib/volunteer';
import { LIBRARY_COUNT_PROVIDERS } from '@/lib/navLibraryCounts';
import { LIBRARY_KEYS, type LibraryKey } from '@/lib/libraryRelease';
import { ORG_DOMAIN } from '@/lib/config';
import { getRoute, type Authorize } from '@/security/core';
import '@/security/registry';
import type { AuthenticatedUser } from '@/types/auth';

const base: AuthenticatedUser = {
    id: 0,
    email: 'person@example.test',
    isSysadmin: false,
    isBoardMember: false,
    isKeyholder: false,
    isBackgroundCheckReviewer: false,
    isOperations: false,
    isInventoryManager: false,
    isFinance: false,
    programsLed: [],
    householdId: 7,
};

const staff = { hd: ORG_DOMAIN, emailVerified: true, email: `staff@${ORG_DOMAIN}` };

/** Persona name → session claims. A persona's id is its index + 1. */
const PERSONA_CLAIMS = {
    noClaims: {},
    adult: { ageBand: 'adult' },
    youth: { ageBand: 'youth' },
    activeAdult: { ageBand: 'adult', isActiveOrgMember: true },
    leadActiveAdult: { ageBand: 'adult', isActiveOrgMember: true, programsLed: [1] },
    leadActiveYouth: { ageBand: 'youth', isActiveOrgMember: true, programsLed: [1] },
    leadInactiveAdult: { ageBand: 'adult', programsLed: [1] },
    programVolunteerActiveAdult: { ageBand: 'adult', isActiveOrgMember: true, isProgramVolunteer: true },
    programVolunteerInactiveAdult: { ageBand: 'adult', isProgramVolunteer: true },
    volunteerFamilyActiveYouth: { ageBand: 'youth', isActiveOrgMember: true, isVolunteerFamily: true },
    volunteerFamilyActiveAdult: { ageBand: 'adult', isActiveOrgMember: true, isVolunteerFamily: true },
    staffAccount: staff,
    staffDomainUnverified: { ...staff, emailVerified: false },
    staffHdOffDomainEmail: { ...staff, email: 'persona@example.test' },
    // A bucket treasurer has no session claim; the server reads it from the bucket-approver lookup.
    treasurer: { ageBand: 'adult' },
    sysadmin: { isSysadmin: true },
    board: { isBoardMember: true },
    finance: { isFinance: true },
    inventoryManager: { isInventoryManager: true },
    keyholder: { isKeyholder: true },
    operations: { isOperations: true },
    bgReviewer: { isBackgroundCheckReviewer: true },
    everyFlag: {
        isSysadmin: true, isBoardMember: true, isKeyholder: true, isBackgroundCheckReviewer: true,
        isOperations: true, isInventoryManager: true, isFinance: true, programsLed: [1],
    },
} satisfies Record<string, Partial<AuthenticatedUser>>;

export type PersonaName = keyof typeof PERSONA_CLAIMS;

export const GATE_PERSONAS: Array<[PersonaName, AuthenticatedUser]> = Object.entries(PERSONA_CLAIMS).map(
    ([name, claims], i) => [name as PersonaName, { ...base, ...claims, id: i + 1 }],
);

/** Persona ids the stubbed bucket-approver lookup finds a bucket for: the treasurer and every program leader. */
export const APPROVER_IDS = new Set(
    GATE_PERSONAS.filter(([n, u]) => n === 'treasurer' || (u.programsLed?.length ?? 0) > 0).map(([, u]) => u.id),
);

/** The nav payload as todo-counts builds it for this viewer, every library released. */
export function countsFor(user: AuthenticatedUser): TodoCounts {
    return {
        member: { household: [], programs: [], programsAwaitingFinance: 0 },
        building: 0,
        buildingHousehold: 0,
        buildingReachable: true,
        activePrograms: 0,
        releasedLibraries: [...LIBRARY_KEYS],
        // The expense provider's approver signal, from the same stubbed directory as the server's.
        libraries: { expense: { approver: APPROVER_IDS.has(user.id) ? 1 : 0 } },
        lead: user.programsLed?.length
            ? { programs: user.programsLed.map((id) => ({ id, name: `p${id}`, totalEnrolled: 0, pending: [], upcoming: [] })) }
            : undefined,
    };
}

type ClientGate = (user: AuthenticatedUser) => boolean;

/** The registered count provider's own `visible` for `library`. */
const counts = (library: LibraryKey): ClientGate => {
    const provider = LIBRARY_COUNT_PROVIDERS.find((p) => p.library === library);
    if (!provider) throw new Error(`${library} has no count provider`);
    return provider.visible;
};

/** A signed-in viewer's pageRegistry visibility for `href`. */
const page = (href: string): ClientGate => {
    const entry = PAGES.find((p) => p.href === href);
    if (!entry) throw new Error(`${href} is not in pageRegistry PAGES`);
    return (user) => entry.visible(user, countsFor(user));
};

/** A registered route's own Authorize, read from the registry so the pair cannot drift from it. */
const routeToken = (endpoint: string): Authorize => {
    const route = getRoute(endpoint);
    if (!route) throw new Error(`${endpoint} is not registered`);
    return route.authorize;
};

/** A section tab's gate for `href`, with every library released. */
const tab = (section: NavSection, href: string): ClientGate => {
    const gate = linkGate(section, href);
    return (user) => gate(user, countsFor(user));
};

export type GatePair = {
    name: string;
    client: ClientGate;
    token: Authorize;
    /** Personas the two sides deliberately disagree on. Each use carries a comment saying why. */
    differsFor?: readonly PersonaName[];
};

/**
 * Count providers pair as `counts:<library>`; gateEquality fails on a provider with no pair.
 * A red-pill provider pairs with the route that acts on what it counts.
 */
export const GATE_PAIRS: GatePair[] = [
    { name: 'volunteer canSeeCatalog', client: canSeeCatalog, token: 'catalog-viewer' },
    { name: 'page /catalog', client: page('/catalog'), token: 'catalog-viewer' },
    { name: 'page /inventory/org-items', client: page('/inventory/org-items'), token: 'catalog-viewer' },
    { name: 'tab /inventory/receive-queue', client: tab(INVENTORY, '/inventory/receive-queue'), token: routeToken('GET /api/inventory/receive-queue') },
    { name: 'page /inventory/receive-queue', client: page('/inventory/receive-queue'), token: routeToken('GET /api/inventory/receive-queue') },
    { name: 'sub-tab /inventory/inventory-log', client: tab(INVENTORY, '/inventory/inventory-log'), token: routeToken('GET /api/inventory/inventory-log') },
    { name: 'page /inventory/inventory-log', client: page('/inventory/inventory-log'), token: routeToken('GET /api/inventory/inventory-log') },
    { name: 'sub-tab /inventory/inventory-log applies route', client: tab(INVENTORY, '/inventory/inventory-log'), token: routeToken('GET /api/inventory/received-inventory-deltas') },
    { name: 'page /inventory/inventory-log applies route', client: page('/inventory/inventory-log'), token: routeToken('GET /api/inventory/received-inventory-deltas') },
    { name: 'page /inventory/merge-conflicts', client: page('/inventory/merge-conflicts'), token: 'inventory-manager' },
    { name: 'counts:local-inventory', client: counts('local-inventory'), token: routeToken('POST /api/inventory/receive-queue/[id]/fulfill') },
    { name: 'tab /inventory/receiving', client: tab(INVENTORY, '/inventory/receiving'), token: routeToken('GET /api/workflow-mapping/receipts') },
    { name: 'page /inventory/receiving', client: page('/inventory/receiving'), token: routeToken('GET /api/workflow-mapping/receipts') },
    { name: 'tab /inventory/receiving counts route', client: tab(INVENTORY, '/inventory/receiving'), token: routeToken('GET /api/workflow-mapping/receipts/counts') },
    { name: 'counts:workflow-mapping', client: counts('workflow-mapping'), token: routeToken('POST /api/workflow-mapping/receipts/[id]/apply') },
    { name: 'Finance section', client: (u) => FINANCE.visible(u, null), token: 'finance-or-board' },
    { name: 'page /expense/settings', client: page('/expense/settings'), token: 'finance-or-board' },
    { name: 'page /budgets', client: page('/budgets'), token: 'finance-or-board' },
    { name: 'tab /income', client: tab(REVENUE_OPS, '/income'), token: routeToken('GET /api/income/items') },
    { name: 'page /income', client: page('/income'), token: routeToken('GET /api/income/items') },
    { name: 'sub-tab /income/payouts', client: tab(REVENUE_OPS, '/income/payouts'), token: routeToken('GET /api/income/payouts') },
    { name: 'sub-tab /income/reconciliation', client: tab(REVENUE_OPS, '/income/reconciliation'), token: routeToken('GET /api/income/reconciliation') },
    { name: 'sub-tab /income/reconciliation count route', client: tab(REVENUE_OPS, '/income/reconciliation'), token: routeToken('GET /api/income/reconciliation/count') },
    { name: 'counts:income', client: counts('income'), token: routeToken('POST /api/income/reconciliation/[id]/resolve') },
    { name: 'page /donations', client: page('/donations'), token: 'finance-or-board' },
    { name: 'page /donations nav-counts route', client: page('/donations'), token: routeToken('GET /api/donations/nav-counts') },
    {
        name: 'page /programs-i-lead/expense-approvals',
        client: page('/programs-i-lead/expense-approvals'),
        token: 'expense-approver',
        // FINANCE and BOARD approve from Finance, not Programs I Lead.
        differsFor: ['board', 'finance'],
    },
    { name: 'volunteer canSubmitReceipts', client: canSubmitReceipts, token: 'receipt-submitter' },
    { name: 'page /receipts', client: page('/receipts'), token: 'receipt-submitter' },
    { name: 'page /finance/review', client: page('/finance/review'), token: 'finance-or-board' },
    { name: 'counts:receipt', client: counts('receipt'), token: 'receipt-submitter' },
    // The provider runs for every signed-in viewer; the approver rule it reports is paired on the page above.
    { name: 'counts:expense', client: counts('expense'), token: 'authenticated' },
    { name: 'counts:bulk-donation', client: counts('bulk-donation'), token: routeToken('PATCH /api/donations/transactions/[id]/owner') },
];
