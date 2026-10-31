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

    it('accepts a session with no join-pending claim, with or without the option', () => {
        expect(isAcceptedSession({ id: 1 }, { allowJoinPending: true })).toBe(true);
        expect(isAcceptedSession({ id: 1, householdJoinPending: false })).toBe(true);
    });

    it('rejects a join-pending session by default', () => {
        expect(isAcceptedSession({ id: 1, householdJoinPending: true })).toBe(false);
        expect(isAcceptedSession({ id: 1, householdJoinPending: true }, {})).toBe(false);
        expect(isAcceptedSession({ id: 1, householdJoinPending: true }, { allowJoinPending: false })).toBe(false);
    });

    it('accepts a join-pending session only with allowJoinPending', () => {
        expect(isAcceptedSession({ id: 1, householdJoinPending: true }, { allowJoinPending: true })).toBe(true);
    });

    it('allowJoinPending does not admit a denied household or a bad id', () => {
        const opts = { allowJoinPending: true };
        expect(isAcceptedSession({ id: 1, denied: true, householdJoinPending: true }, opts)).toBe(false);
        expect(isAcceptedSession({ id: 0, householdJoinPending: true }, opts)).toBe(false);
    });
});
