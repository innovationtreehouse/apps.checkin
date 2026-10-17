/**
 * @jest-environment node
 */
/**
 * Strip-assertion for GET /api/shop/certifications. Cert status is PUBLIC BY
 * DESIGN (posted in the shop), but the participant's email is not. A bag row is
 * a ToolStatus with nested tool (Tool) + person (Person):
 *
 *   - board/sysadmin (everyones:pii) → level + tool + person name + email.
 *   - member/certifier (member+public) → level + tool + person name;
 *                                        email (pii) STRIPPED.
 *
 * `level` is @sensitivity:member, so it is visible to any authenticated member
 * but would strip for a public/unauthenticated view. Tokens are pulled from the
 * live registry, so a policy edit that regresses email exposure fails here.
 *
 * Denied-household rejection (401) is covered end-to-end by the table-driven
 * registryAuthz.integration.test — this route's authorize:'authenticated' means
 * a denied session (resolved to unauthenticated at authenticateRequest) is
 * rejected at admission before this stripper ever runs.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { getRoute, type Role, type Token } from '@/security/core';
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

const ENDPOINT = 'GET /api/shop/certifications';
// The route currently selects person {id, name} only — no client needs
// email. This fixture includes email to lock the DECLARED policy: if a future
// edit adds email to the select, the stripper must still gate it to staff.
// A cert row for some OTHER member (id !== selfId → only the 'everyones' scope applies).
const row = () => ({
    personId: 99,
    toolId: 7,
    level: 'CERTIFIED',
    tool: { id: 7, name: 'Lathe', safetyGuide: null },
    person: { id: 99, name: 'Other Member', email: 'other@x.test' },
});

describe('shop/certifications field-stripping', () => {
    it('board sees level + tool + person name + email (pii)', () => {
        const tokens = tokensFor(ENDPOINT, 'isBoardMember');
        const out = stripValue('ToolStatus', row(), tokens, ctx()) as Record<string, unknown>;
        expect(out.level).toBe('CERTIFIED');
        expect((out.tool as Record<string, unknown>).name).toBe('Lathe');
        const p = out.person as Record<string, unknown>;
        expect(p.name).toBe('Other Member');
        expect(p.email).toBe('other@x.test');
    });

    it('member/certifier sees status but NOT email — email is stripped', () => {
        const tokens = tokensFor(ENDPOINT, 'authenticated');
        const out = stripValue('ToolStatus', row(), tokens, ctx()) as Record<string, unknown>;
        // cert status stays public-by-design:
        expect(out.level).toBe('CERTIFIED');
        expect((out.tool as Record<string, unknown>).name).toBe('Lathe');
        const p = out.person as Record<string, unknown>;
        expect(p.name).toBe('Other Member');
        // ...but the person's email does not leak to non-staff:
        expect(p.email).toBeUndefined();
    });

    it('the authenticated (member/certifier) view holds no everyones:pii grant', () => {
        expect(tokensFor(ENDPOINT, 'authenticated')).not.toContain('everyones:pii');
    });
});
