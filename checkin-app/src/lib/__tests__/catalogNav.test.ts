import { isCatalogViewerClient } from '@/lib/catalogNav';
import type { SessionUser } from '@/types/auth';

const user = (claims: Partial<SessionUser>): SessionUser => ({ id: 7, ...claims });

// The nav admits exactly the server's audience: the shared volunteer definition.
describe('isCatalogViewerClient', () => {
    it('admits a finance role holder, as the server gate does', () => {
        expect(isCatalogViewerClient(user({ isFinance: true }))).toBe(true);
    });

    it('admits a program volunteer with an active membership', () => {
        expect(isCatalogViewerClient(user({ isProgramVolunteer: true, isActiveOrgMember: true }))).toBe(true);
    });

    it('denies a signed-out visitor and a plain member', () => {
        expect(isCatalogViewerClient(undefined)).toBe(false);
        expect(isCatalogViewerClient(user({ isActiveOrgMember: true }))).toBe(false);
    });
});
