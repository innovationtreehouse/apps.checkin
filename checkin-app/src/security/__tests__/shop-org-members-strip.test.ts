/**
 * @jest-environment node
 */
/**
 * Strip-assertion for GET /api/shop/org-members. The route returns every active
 * member's {id, name, email}. The view decides who sees email (pii):
 *
 *   - board/sysadmin (everyones:pii) → name + email.
 *   - certifier (member+public)      → name only; email STRIPPED.
 *
 * This deliberately tightens the pre-migration behavior, which returned every
 * member's email to any certifier. Tokens are pulled from the live registry.
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

const ENDPOINT = 'GET /api/shop/org-members';
// Another member (not the caller) — id !== selfId, so only the 'everyones' scope applies.
const member = { id: 99, name: 'Other Member', email: 'other@x.test' };

describe('shop/org-members field-stripping', () => {
    it('board sees name + email (pii)', () => {
        const tokens = tokensFor(ENDPOINT, 'isBoardMember');
        const out = stripValue('Person', member, tokens, ctx()) as Record<string, unknown>;
        expect(out.name).toBe('Other Member');
        expect(out.email).toBe('other@x.test');
    });

    it('certifier sees name only — email is stripped', () => {
        const tokens = tokensFor(ENDPOINT, 'certifier');
        const out = stripValue('Person', member, tokens, ctx()) as Record<string, unknown>;
        expect(out.name).toBe('Other Member');
        expect(out.email).toBeUndefined();
    });

    it('the certifier view holds no everyones:pii grant', () => {
        expect(tokensFor(ENDPOINT, 'certifier')).not.toContain('everyones:pii');
    });
});
