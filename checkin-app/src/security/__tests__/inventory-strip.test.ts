/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the local-inventory routes. Companion to the
 * registry/generator wiring; asserts the boundary layer directly, independent of
 * the route files:
 *
 *   1. Every human inventory endpoint resolves in the registry, stock reads
 *      admit the reused `catalog-viewer` gate, receiving reads admit
 *      INVENTORY_MANAGER, FINANCE or BOARD and refuse a catalog viewer, writes
 *      and the manager work-queue reads admit INVENTORY_MANAGER only, and the
 *      machine surface and dead settings routes stay unregistered.
 *   2. The stripper honours the inventory classification map: a viewer view
 *      (public only) drops `internal` fields (orgId, actor attribution, free
 *      text, cross-app plumbing); the manager view (everyones:internal) keeps
 *      them. Tokens come from the live registry, so a policy regression fails.
 *   3. The inventory `InventoryProvisionalItem` model and the catalog
 *      `ProvisionalItem` model coexist in the merged map with their own field
 *      sets — the collision the distinct name exists to prevent.
 */
import { stripValue } from '@/security/stripper';
import { resolveAccess, type CallerContext } from '@/security/access-resolvers';
import { getRoute, classifications, type Role, type Token } from '@/security/core';
import type { AuthenticatedUser } from '@/types/auth';
import '@/security/registry';

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

function tokensFor(endpoint: string, role: Role): readonly Token[] {
    const spec = getRoute(endpoint);
    if (!spec) throw new Error(`no registry entry for ${endpoint}`);
    const entry = spec.orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`no orderedView entry for ${role} on ${endpoint}`);
    return entry[1];
}

const READ_ENDPOINTS = [
    'GET /api/inventory/locations',
    'GET /api/inventory/org-items',
    'GET /api/inventory/org-items/[gtin13]',
    'GET /api/inventory/org-items/count',
];

// Receipts show spending (docs/rules/inventory.md, Access).
const RECEIVING_ENDPOINTS = [
    'GET /api/inventory/receive-queue',
    'GET /api/inventory/inventory-log',
    'GET /api/inventory/received-inventory-deltas',
    'GET /api/inventory/inventory-log/count',
    'GET /api/inventory/received-inventory-deltas/count',
];

// Manager work-queue reads, then writes.
const MANAGER_ENDPOINTS = [
    'GET /api/inventory/inventory-merge-conflicts',
    'GET /api/inventory/provisional-items',
    'GET /api/inventory/received-org-events',
    'POST /api/inventory/locations',
    'PUT /api/inventory/locations/[id]',
    'DELETE /api/inventory/locations/[id]',
    'POST /api/inventory/locations/[id]/reassign',
    'POST /api/inventory/org-items',
    'PUT /api/inventory/org-items/[gtin13]',
    'DELETE /api/inventory/org-items/[gtin13]',
    'DELETE /api/inventory/receive-queue/[id]',
    'POST /api/inventory/receive-queue/[id]/fulfill',
    'PUT /api/inventory/inventory-merge-conflicts/[id]/resolve',
];

// Never registered: the machine surface, the dead settings routes, and a
// count for the org-events ledger the in-process crossing replaces.
const UNREGISTERED_ENDPOINTS = [
    'GET /api/inventory/system-data',
    'GET /api/inventory/received-org-events/count',
    'POST /api/inventory/apply',
    'PUT /api/inventory/system-data',
];

describe('inventory route registry admission', () => {
    for (const endpoint of READ_ENDPOINTS) {
        it(`${endpoint} is registered and admits catalog-viewer`, () => {
            const spec = getRoute(endpoint);
            expect(spec).toBeDefined();
            expect(spec!.authorize).toBe('catalog-viewer');
        });
    }

    for (const endpoint of RECEIVING_ENDPOINTS) {
        it(`${endpoint} is registered and admits INVENTORY_MANAGER, FINANCE or BOARD`, () => {
            const spec = getRoute(endpoint);
            expect(spec).toBeDefined();
            expect(spec!.authorize).toEqual({ anyRole: ['isInventoryManager', 'isFinance', 'isBoardMember'] });
            expect(spec!.orderedView.map(([role]) => role)).toEqual(['isInventoryManager', 'isFinance', 'isBoardMember']);
        });
    }

    for (const endpoint of MANAGER_ENDPOINTS) {
        it(`${endpoint} is registered and admits INVENTORY_MANAGER only`, () => {
            const spec = getRoute(endpoint);
            expect(spec).toBeDefined();
            expect(spec!.authorize).toBe('inventory-manager');
        });
    }

    for (const endpoint of UNREGISTERED_ENDPOINTS) {
        it(`${endpoint} is not registered`, () => {
            expect(getRoute(endpoint)).toBeUndefined();
        });
    }

    it('read views never grant a sensitive tier beyond internal (no pii/personal)', () => {
        for (const endpoint of READ_ENDPOINTS) {
            const viewer = tokensFor(endpoint, 'authenticated');
            expect(viewer).toEqual(['public']);
        }
        for (const endpoint of [...READ_ENDPOINTS, ...RECEIVING_ENDPOINTS]) {
            for (const [, tokens] of getRoute(endpoint)!.orderedView) {
                expect(tokens).not.toContain('everyones:pii');
                expect(tokens).not.toContain('everyones:personal');
            }
        }
    });
});

describe('receiving read admission', () => {
    const noFlags: AuthenticatedUser = {
        id: 1,
        email: 'inv@x.test',
        isSysadmin: false,
        isBoardMember: false,
        isKeyholder: false,
        isBackgroundCheckReviewer: false,
        isOperations: false,
        isInventoryManager: false,
        isFinance: false,
    };
    const as = (claims: Partial<AuthenticatedUser>): AuthenticatedUser => ({ ...noFlags, ...claims });
    // A youth in an ACTIVE member household who volunteers: in the catalog audience, holds no role.
    const memberYouth = as({ ageBand: 'youth', isVolunteerFamily: true, isActiveOrgMember: true });
    const keyholder = as({ isKeyholder: true });
    const sysadmin = as({ isSysadmin: true });
    const manager = as({ isInventoryManager: true });
    const finance = as({ isFinance: true });
    const board = as({ isBoardMember: true });

    async function allowed(endpoint: string, user: AuthenticatedUser): Promise<boolean> {
        const result = await resolveAccess(getRoute(endpoint)!.authorize, {
            auth: { type: 'session', user },
            params: {},
            callerContext: ctx(),
        });
        return result.allowed;
    }

    it('the refused callers are catalog viewers', async () => {
        for (const user of [memberYouth, keyholder, sysadmin]) {
            expect(await allowed('GET /api/inventory/org-items', user)).toBe(true);
        }
    });

    it.each(RECEIVING_ENDPOINTS)('%s refuses a catalog viewer, a keyholder and a sysadmin', async (endpoint) => {
        for (const user of [memberYouth, keyholder, sysadmin]) {
            expect(await allowed(endpoint, user)).toBe(false);
        }
    });

    it.each(RECEIVING_ENDPOINTS)('%s admits INVENTORY_MANAGER, FINANCE and BOARD', async (endpoint) => {
        for (const user of [manager, finance, board]) {
            expect(await allowed(endpoint, user)).toBe(true);
        }
    });
});

describe('inventory field-stripping (InventoryLog)', () => {
    const row = () => ({
        id: 1,
        orgId: 'treehouse',
        userId: 42,
        username: 'jordan',
        changedAt: new Date('2026-01-01').toISOString(),
        changeType: 'manual_edit',
        gtin13: '0001112223334',
        fieldChanged: 'existingQuantity',
        valueBefore: '3',
        valueAfter: '5',
        receiptId: 'rcpt_9',
        rawQuantity: null,
        conversionFactor: null,
        conversionVersion: null,
    });

    const ENDPOINT = 'GET /api/inventory/inventory-log';

    it('manager sees operational fields AND internal attribution/plumbing', () => {
        const tokens = tokensFor(ENDPOINT, 'isInventoryManager');
        const out = stripValue('InventoryLog', row(), tokens, ctx()) as Record<string, unknown>;
        expect(out.gtin13).toBe('0001112223334');
        expect(out.changeType).toBe('manual_edit');
        expect(out.userId).toBe(42);
        expect(out.username).toBe('jordan');
        expect(out.orgId).toBe('treehouse');
        expect(out.receiptId).toBe('rcpt_9');
    });

    it('finance and the board see the same fields as the manager', () => {
        expect(tokensFor(ENDPOINT, 'isFinance')).toEqual(tokensFor(ENDPOINT, 'isInventoryManager'));
        expect(tokensFor(ENDPOINT, 'isBoardMember')).toEqual(tokensFor(ENDPOINT, 'isInventoryManager'));
    });

    it('a public-only view sees operational fields but NOT internal ones', () => {
        const out = stripValue('InventoryLog', row(), ['public'], ctx()) as Record<string, unknown>;
        // operational, posted in the building:
        expect(out.gtin13).toBe('0001112223334');
        expect(out.changeType).toBe('manual_edit');
        expect(out.valueBefore).toBe('3');
        // internal — actor attribution, org token, cross-app plumbing:
        expect(out.userId).toBeUndefined();
        expect(out.username).toBeUndefined();
        expect(out.orgId).toBeUndefined();
        expect(out.receiptId).toBeUndefined();
    });
});

describe('inventory field-stripping (InventoryProvisionalItem free text)', () => {
    const row = () => ({
        id: 1,
        provisionalGtin13: '0009998887776',
        name: 'Widget',
        usageBehavior: 'consumable',
        proposedByUserId: 7,
        orgId: 'treehouse',
        status: 'rejected',
        rejectionReason: 'duplicate of an existing part',
        resolvedToGtin13: null,
        conversionFactor: 1,
    });

    const ENDPOINT = 'GET /api/inventory/provisional-items';

    it('the route has no viewer view', () => {
        expect(getRoute(ENDPOINT)!.orderedView.map(([role]) => role)).toEqual(['isInventoryManager']);
    });

    it('a public-only view keeps the item but drops the rejection reason and proposer', () => {
        const out = stripValue('InventoryProvisionalItem', row(), ['public'], ctx()) as Record<string, unknown>;
        expect(out.name).toBe('Widget');
        expect(out.status).toBe('rejected');
        expect(out.rejectionReason).toBeUndefined();
        expect(out.proposedByUserId).toBeUndefined();
        expect(out.orgId).toBeUndefined();
    });

    it('manager sees the rejection reason and proposer', () => {
        const tokens = tokensFor(ENDPOINT, 'isInventoryManager');
        const out = stripValue('InventoryProvisionalItem', row(), tokens, ctx()) as Record<string, unknown>;
        expect(out.rejectionReason).toBe('duplicate of an existing part');
        expect(out.proposedByUserId).toBe(7);
    });
});

describe('classification merge keeps inventory and catalog provisional models disjoint', () => {
    it('both models exist with their own field sets', () => {
        // Inventory's provisional model has its own name so it does not collide
        // with the catalog schema's ProvisionalItem in the flat merge.
        const inventory = classifications.InventoryProvisionalItem as Record<string, string>;
        const catalog = classifications.ProvisionalItem as Record<string, string>;
        // inventory-only field:
        expect(inventory.usageBehavior).toBe('public');
        expect('usageBehavior' in catalog).toBe(false);
        // catalog-only field:
        expect(catalog.proposedName).toBe('public');
        expect('proposedName' in inventory).toBe(false);
    });
});

describe('inventory count routes', () => {
    it('return the public InventoryCount synthetic model', () => {
        expect(classifications.InventoryCount).toEqual({ total: 'public' });
        for (const endpoint of [...READ_ENDPOINTS, ...RECEIVING_ENDPOINTS].filter(e => e.endsWith('/count'))) {
            expect(getRoute(endpoint)!.returns).toEqual(['InventoryCount']);
            const out = stripValue('InventoryCount', { total: 42 }, getRoute(endpoint)!.orderedView[0][1], ctx());
            expect(out).toEqual({ total: 42 });
        }
    });
});
