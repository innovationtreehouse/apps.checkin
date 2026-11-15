import { isAcceptedSession } from '../acceptedSession';
import { ORG_DOMAIN } from '@/lib/config';

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

describe('isAcceptedSession — dev instance org gate', () => {
    const ORIGINAL_ENV = process.env.CHECKIN_ENV;
    const ORIGINAL_URL = process.env.NEXTAUTH_URL;
    const deployedDev = () => {
        process.env.CHECKIN_ENV = 'dev';
        process.env.NEXTAUTH_URL = 'https://ops-dev.innovationtreehouse.org';
    };
    afterEach(() => {
        if (ORIGINAL_ENV === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = ORIGINAL_ENV;
        if (ORIGINAL_URL === undefined) delete process.env.NEXTAUTH_URL;
        else process.env.NEXTAUTH_URL = ORIGINAL_URL;
    });

    const stranger = { id: 2, hd: null, emailVerified: true };
    const otherWorkspace = { id: 2, hd: 'example.org', emailVerified: true };
    const unverifiedOrg = { id: 1, hd: ORG_DOMAIN, emailVerified: false };
    const orgMember = { id: 1, hd: ORG_DOMAIN, emailVerified: true };

    it('on deployed dev, refuses a session that is not a verified org account', () => {
        deployedDev();
        expect(isAcceptedSession(stranger)).toBe(false);
        expect(isAcceptedSession(otherWorkspace)).toBe(false);
        expect(isAcceptedSession(unverifiedOrg)).toBe(false);
        expect(isAcceptedSession({ id: 1 })).toBe(false);
        expect(isAcceptedSession({ ...stranger, householdJoinPending: true }, { allowJoinPending: true })).toBe(false);
    });

    it('on deployed dev, accepts a verified org account', () => {
        deployedDev();
        expect(isAcceptedSession(orgMember)).toBe(true);
    });

    it('on deployed dev, accepts a minted persona, which carries the org gate claims', () => {
        deployedDev();
        const persona = { id: 7, hd: ORG_DOMAIN, emailVerified: true, impersonatedBy: 'org@innovationtreehouse.org' };
        expect(isAcceptedSession(persona)).toBe(true);
    });

    it('is off on dev at localhost, as under plain jest', () => {
        process.env.CHECKIN_ENV = 'dev';
        delete process.env.NEXTAUTH_URL;
        expect(isAcceptedSession(stranger)).toBe(true);
        process.env.NEXTAUTH_URL = 'http://localhost:4000';
        expect(isAcceptedSession(stranger)).toBe(true);
    });

    it.each(['local', 'stg', 'prod', undefined])('does not apply the org gate when CHECKIN_ENV is %s, even on the ops-dev host', (env) => {
        process.env.NEXTAUTH_URL = 'https://ops-dev.innovationtreehouse.org';
        if (env === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = env;
        expect(isAcceptedSession(stranger)).toBe(true);
        expect(isAcceptedSession({ id: 1 })).toBe(true);
    });
});
