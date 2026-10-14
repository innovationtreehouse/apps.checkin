/**
 * Client gate ↔ server Authorize token pairs (threat model D35). Each library's
 * nav entries, pages and count providers decide visibility with a client
 * predicate; the routes behind them admit with a token resolved in
 * security/access-resolvers.ts. gateEquality.test.ts asserts each pair admits
 * the same GATE_PERSONAS. A new library adds one line to GATE_PAIRS.
 */
import type { TodoCounts } from '@/app/api/nav/todo-counts/route';
import { PAGES } from '@/components/pageRegistry';
import { isCatalogViewerClient } from '@/lib/catalogNav';
import { EXPENSE_OPS_SECTION_ROLES, hasAnyRole } from '@/lib/libraryNav';
import { LIBRARY_COUNT_PROVIDERS } from '@/lib/navLibraryCounts';
import { LIBRARY_KEYS, type LibraryKey } from '@/lib/libraryRelease';
import { ORG_DOMAIN } from '@/lib/config';
import type { Authorize } from '@/security/core';
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
    // A program treasurer has no session claim; the server reads it from the DB.
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

/** Persona ids the server's treasurer lookup finds a treasurer row for. */
export const TREASURER_IDS = new Set(GATE_PERSONAS.filter(([n]) => n === 'treasurer').map(([, u]) => u.id));

/** The nav payload as todo-counts builds it for this viewer, every library released. */
export function countsFor(user: AuthenticatedUser): TodoCounts {
    return {
        member: { household: [], programs: [], programsAwaitingFinance: 0 },
        building: 0,
        buildingHousehold: 0,
        buildingReachable: true,
        activePrograms: 0,
        releasedLibraries: [...LIBRARY_KEYS],
        // The expense provider's approver signal, with the treasurer lookup stubbed like the server's.
        libraries: { expense: { approver: user.programsLed?.length || TREASURER_IDS.has(user.id) ? 1 : 0 } },
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
    return (user) => entry.visible(user, true, countsFor(user));
};

export type GatePair = {
    name: string;
    client: ClientGate;
    token: Authorize;
    /** Personas the two sides deliberately disagree on. Each use carries a comment saying why. */
    differsFor?: readonly PersonaName[];
};

/** Count providers pair as `counts:<library>`; gateEquality fails on a provider with no pair. */
export const GATE_PAIRS: GatePair[] = [
    { name: 'catalogNav isCatalogViewerClient', client: isCatalogViewerClient, token: 'catalog-viewer' },
    { name: 'page /catalog', client: page('/catalog'), token: 'catalog-viewer' },
    { name: 'page /inventory/org-items', client: page('/inventory/org-items'), token: 'catalog-viewer' },
    { name: 'page /inventory/merge-conflicts', client: page('/inventory/merge-conflicts'), token: 'inventory-manager' },
    { name: 'Expense Ops section', client: (u) => hasAnyRole(u, EXPENSE_OPS_SECTION_ROLES), token: 'finance-or-board' },
    { name: 'page /expense/settings', client: page('/expense/settings'), token: 'finance-or-board' },
    { name: 'page /budgets', client: page('/budgets'), token: 'finance-or-board' },
    { name: 'page /donations', client: page('/donations'), token: 'finance-or-board' },
    {
        name: 'page /my-programs/expense-approvals',
        client: page('/my-programs/expense-approvals'),
        token: 'expense-approver',
        // FINANCE and BOARD approve from Expense Ops, not My Programs.
        differsFor: ['board', 'finance'],
    },
    // The provider runs for every signed-in viewer; the approver rule it reports is paired on the page above.
    { name: 'counts:expense', client: counts('expense'), token: 'authenticated' },
];
