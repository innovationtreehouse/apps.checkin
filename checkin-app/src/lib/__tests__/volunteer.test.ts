import { isTreehouseVolunteer } from '@/lib/volunteer';
import { ROLE_FLAGS } from '@/lib/roles';
import { ORG_DOMAIN } from '@/lib/config';

const active = { isActiveOrgMember: true };

describe('isTreehouseVolunteer', () => {
    it('denies a missing user and a plain signed-in member', () => {
        expect(isTreehouseVolunteer(undefined)).toBe(false);
        expect(isTreehouseVolunteer({ ...active, programsLed: [] })).toBe(false);
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
    ])('admits a %s with an active membership, and only then', (_label, leg) => {
        expect(isTreehouseVolunteer({ ...leg, ...active })).toBe(true);
        expect(isTreehouseVolunteer({ ...leg, isActiveOrgMember: false })).toBe(false);
        expect(isTreehouseVolunteer(leg)).toBe(false);
    });

    it('ignores a volunteer-designation email', () => {
        expect(isTreehouseVolunteer({ ...active, email: 'volunteer@gmail.com' })).toBe(false);
    });
});
