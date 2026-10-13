/**
 * @jest-environment node
 *
 * POST /api/trusted-adults is session-only: a kiosk-signed request is refused before the
 * handler runs, and a session discloses for the caller's own household.
 */

import { getServerSession } from 'next-auth/next';
import { getKioskPublicKeys, verifyKioskSignature } from '@/lib/verify-kiosk';
import { createTrustedAdult } from '@/lib/trusted-adult/service';
import { POST } from '@/app/api/trusted-adults/route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/auth-options', () => ({ authOptions: {} }));
jest.mock('@/lib/verify-kiosk', () => ({
    getKioskPublicKeys: jest.fn(),
    verifyKioskSignature: jest.fn(),
}));
jest.mock('@/lib/trusted-adult/service', () => ({
    ...jest.requireActual('@/lib/trusted-adult/service'),
    createTrustedAdult: jest.fn(),
}));

const body = { householdId: 10, trustedAdultName: 'Grandma', familyContext: 'Maternal grandmother.' };
const post = (headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/trusted-adults', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });

beforeEach(() => {
    jest.clearAllMocks();
    (getKioskPublicKeys as jest.Mock).mockReturnValue(['key']);
    (verifyKioskSignature as jest.Mock).mockReturnValue({ ok: true });
    (getServerSession as jest.Mock).mockResolvedValue(null);
    (createTrustedAdult as jest.Mock).mockResolvedValue({ id: 5 });
});

describe('POST /api/trusted-adults', () => {
    it('refuses a validly kiosk-signed request', async () => {
        const res = await POST(post({ 'x-kiosk-signature': 'sig' }));

        expect(res.status).toBe(403);
        expect(createTrustedAdult).not.toHaveBeenCalled();
    });

    it("creates for the signed-in member's own household", async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 3, householdId: 10 } });

        const res = await POST(post());

        expect(res.status).toBe(201);
        expect(createTrustedAdult).toHaveBeenCalledWith(
            expect.objectContaining({ householdId: 10, disclosedById: 3, origin: 'SELF_DISCLOSED' }),
        );
    });
});
