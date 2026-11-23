import { POSITION_LABELS, positionPageHref, type Position } from '../positionCheck';

describe('positionPageHref', () => {
    it('links a program position to its program', () => {
        expect(positionPageHref({ position: 'PROGRAM_VOLUNTEER', programId: 7 })).toBe('/program-ops/programs/7');
        expect(positionPageHref({ position: 'CORE_VOLUNTEER', programId: 7 })).toBe('/program-ops/programs/7');
    });

    it('links a bucket owner and a bucket treasurer to the budgets page', () => {
        expect(positionPageHref({ position: 'BUDGET_OWNER' })).toBe('/budgets');
        expect(positionPageHref({ position: 'BUDGET_TREASURER' })).toBe('/budgets');
    });

    const roles: Position[] = ['SYSADMIN', 'BOARD', 'KEYHOLDER', 'BG_REVIEWER', 'OPERATIONS', 'INVENTORY_MANAGER', 'FINANCE', 'KEY_VOLUNTEER'];
    it.each(roles)('links the %s role to the roles page', (position) => {
        expect(positionPageHref({ position })).toBe('/membership-ops/roles');
    });

    it('covers every position', () => {
        const linked = [...roles, 'PROGRAM_VOLUNTEER', 'CORE_VOLUNTEER', 'BUDGET_OWNER', 'BUDGET_TREASURER'];
        expect(linked.sort()).toEqual(Object.keys(POSITION_LABELS).sort());
    });

    it('links an acknowledgement with no position to the roles page', () => {
        expect(positionPageHref({})).toBe('/membership-ops/roles');
    });
});
