import { canSeeCatalog, isTreehouseVolunteer } from '@/lib/volunteer';
import { ROLE_FLAGS } from '@/lib/roles';
import { ORG_DOMAIN } from '@/lib/config';

const activeAdult = { isActiveOrgMember: true, ageBand: 'adult' as const };

describe('isTreehouseVolunteer', () => {
    it('denies a missing user and a plain signed-in member', () => {
        expect(isTreehouseVolunteer(undefined)).toBe(false);
        expect(isTreehouseVolunteer({ ...activeAdult, programsLed: [] })).toBe(false);
    });

    it.each(ROLE_FLAGS)('admits the %s role without a membership', (flag) => {
        expect(isTreehouseVolunteer({ [flag]: true })).toBe(true);
    });

    it('admits a verified staff account without a membership', () => {
        expect(isTreehouseVolunteer({ hd: ORG_DOMAIN, emailVerified: true, email: `ops@${ORG_DOMAIN}` })).toBe(true);
    });

    it('does not take staff status from an email or an unverified claim', () => {
        expect(isTreehouseVolunteer({ email: `ops@${ORG_DOMAIN}` })).toBe(false);
        expect(isTreehouseVolunteer({ hd: ORG_DOMAIN, emailVerified: false, email: `ops@${ORG_DOMAIN}` })).toBe(false);
        // A dev persona minted with the org gate claims is still the persona, not staff.
        expect(isTreehouseVolunteer({ hd: ORG_DOMAIN, emailVerified: true, email: 'parent@example.com' })).toBe(false);
    });

    it.each([
        ['program leader', { programsLed: [3] }],
        ['program volunteer', { isProgramVolunteer: true }],
        ['volunteer family member', { isVolunteerFamily: true }],
    ])('admits a %s only as a known adult with an active membership', (_label, leg) => {
        expect(isTreehouseVolunteer({ ...leg, ...activeAdult })).toBe(true);
        expect(isTreehouseVolunteer({ ...leg, ...activeAdult, isActiveOrgMember: false })).toBe(false);
        expect(isTreehouseVolunteer({ ...leg, ...activeAdult, ageBand: 'youth' })).toBe(false);
        expect(isTreehouseVolunteer({ ...leg, ...activeAdult, ageBand: 'unknown' })).toBe(false);
    });

    it('ignores a volunteer-designation email', () => {
        expect(isTreehouseVolunteer({ ...activeAdult, email: 'volunteer@gmail.com' })).toBe(false);
    });
});

describe('canSeeCatalog', () => {
    it('admits every Treehouse Volunteer', () => {
        expect(canSeeCatalog({ isFinance: true })).toBe(true);
        expect(canSeeCatalog({ ...activeAdult, isProgramVolunteer: true })).toBe(true);
    });

    it('admits the youth of an active Volunteer Family, not of a lapsed one', () => {
        expect(canSeeCatalog({ ageBand: 'youth', isVolunteerFamily: true, isActiveOrgMember: true })).toBe(true);
        expect(canSeeCatalog({ ageBand: 'youth', isVolunteerFamily: true, isActiveOrgMember: false })).toBe(false);
    });

    it('admits a youth program volunteer, and not a plain youth member', () => {
        expect(canSeeCatalog({ ageBand: 'youth', isProgramVolunteer: true, isActiveOrgMember: true })).toBe(true);
        expect(canSeeCatalog({ ageBand: 'youth', isActiveOrgMember: true })).toBe(false);
    });

    it('denies a missing user', () => {
        expect(canSeeCatalog(undefined)).toBe(false);
    });
});
