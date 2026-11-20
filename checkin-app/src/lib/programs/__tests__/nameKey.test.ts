/**
 * @jest-environment node
 */
import { isProgramNameTaken, programNameFields, programNameKey } from '@/lib/programs/nameKey';

describe('programNameKey', () => {
    it('trims and lower-cases, keeping inner spaces', () => {
        expect(programNameKey('  Robotics  Club ')).toBe('robotics  club');
    });

    it('gives case and outer-space variants one key', () => {
        expect(new Set(['Robotics', 'robotics ', 'ROBOTICS', '\tRobotics'].map(programNameKey))).toEqual(new Set(['robotics']));
    });

    it('stores the name trimmed beside its key', () => {
        expect(programNameFields('  Robotics ')).toEqual({ name: 'Robotics', nameKey: 'robotics' });
    });
});

describe('isProgramNameTaken', () => {
    const p2002 = (fields: string[]) => ({ code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { fields } } } } });

    it('matches a collision on the name key index', () => {
        expect(isProgramNameTaken(p2002(['"nameKey"', '"appliesToYear"']))).toBe(true);
    });

    it.each([
        ['another unique index', p2002(['"shopifyVariantId"'])],
        ['another error code', { code: 'P2025' }],
        ['a plain error', new Error('boom')],
    ])('ignores %s', (_label, error) => {
        expect(isProgramNameTaken(error)).toBe(false);
    });
});
