import { VALID_ROLES } from '@/security/core';
import type { BusinessRole } from '@/types/auth';

/**
 * Guard for the gap #1104 introduced: it added 'isOperations' to BusinessRole
 * (types/auth.ts, used by withAuth) without adding it to Role/VALID_ROLES
 * (security/core.ts, used by defineRoute/callerHoldsRole). A route declaring
 * `anyRole:['isOperations']` would 403 in withAuth's own gate today (that check
 * doesn't consult VALID_ROLES), but a route wired through the `orderedView`
 * seam (defineRoute) would throw "unknown role" — and callerHoldsRole's
 * exhaustive switch would fail to compile without a case. This test would have
 * caught the gap: every BusinessRole must be a recognized security-core Role.
 */
const BUSINESS_ROLES: BusinessRole[] = [
    'isSysadmin',
    'isBoardMember',
    'isKeyholder',
    'isBackgroundCheckReviewer',
    'isOperations',
    'isInventoryManager',
];

describe('BusinessRole ⊆ VALID_ROLES', () => {
    it.each(BUSINESS_ROLES)('%s is a recognized security/core Role', (role) => {
        expect(VALID_ROLES.has(role)).toBe(true);
    });
});
