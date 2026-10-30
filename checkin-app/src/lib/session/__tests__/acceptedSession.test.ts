import { isAcceptedSession } from '../acceptedSession';

describe('isAcceptedSession', () => {
    it('accepts a positive integer id with no denied household', () => {
        expect(isAcceptedSession({ id: 1 })).toBe(true);
        expect(isAcceptedSession({ id: 1, denied: false })).toBe(true);
    });

    it.each([
        ['missing', undefined],
        ['a numeric string', '1'],
        ['fractional', 1.5],
        ['NaN', NaN],
        ['zero', 0],
        ['negative', -1],
    ])('rejects an id that is %s', (_label, id) => {
        expect(isAcceptedSession({ id })).toBe(false);
    });

    it('rejects a denied household', () => {
        expect(isAcceptedSession({ id: 1, denied: true })).toBe(false);
    });
});
