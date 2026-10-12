/**
 * @jest-environment node
 */
/**
 * The signIn() callback in auth-options.ts: a Google account must have a verified email
 * before it is linked to a person record for the first time. An already-linked Google
 * account signs in as before; other providers are unaffected.
 */

import prisma from '@/lib/prisma';

jest.mock('@/lib/config', () => {
    const actual = jest.requireActual('@/lib/config');
    return {
        __esModule: true,
        ...actual,
        config: {
            ...actual.config,
            checkinEnv: jest.fn(() => 'local'),
            isDevInstance: jest.fn(() => true),
            isProd: jest.fn(() => false),
            nextAuthSecret: jest.fn(() => 'test-secret'),
            googleClientId: jest.fn(() => 'gid'),
            googleClientSecret: jest.fn(() => 'gsecret'),
        },
    };
});

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { account: { findUnique: jest.fn() } },
}));

// jest.setup.js globally mocks @/lib/auth-options to `{}`; unmock to get the real callbacks.
jest.unmock('@/lib/auth-options');

import { authOptions, PERSONA_MINT_PROVIDER_ID, UNVERIFIED_EMAIL_SIGNIN_ERROR } from '@/lib/auth-options';

type SignInCallback = NonNullable<NonNullable<typeof authOptions.callbacks>['signIn']>;
const signIn: SignInCallback = authOptions.callbacks!.signIn!;

const mockAccountFindUnique = (prisma as unknown as { account: { findUnique: jest.Mock } })
    .account.findUnique;

const REFUSED = `/signin?error=${UNVERIFIED_EMAIL_SIGNIN_ERROR}`;

function googleSignIn(emailVerified: boolean | undefined) {
    return signIn({
        user: { id: 'g-sub', email: 'a@example.org' },
        account: { provider: 'google', providerAccountId: 'g-sub', type: 'oauth' },
        profile: { email: 'a@example.org', email_verified: emailVerified },
    } as unknown as Parameters<SignInCallback>[0]);
}

beforeEach(() => mockAccountFindUnique.mockReset());

describe('authOptions.callbacks.signIn', () => {
    it('refuses an unlinked Google account whose email is not verified', async () => {
        mockAccountFindUnique.mockResolvedValue(null);
        await expect(googleSignIn(false)).resolves.toBe(REFUSED);
    });

    it('refuses an unlinked Google account that sends no email_verified claim', async () => {
        mockAccountFindUnique.mockResolvedValue(null);
        await expect(googleSignIn(undefined)).resolves.toBe(REFUSED);
    });

    it('allows an unlinked Google account whose email is verified', async () => {
        mockAccountFindUnique.mockResolvedValue(null);
        await expect(googleSignIn(true)).resolves.toBe(true);
    });

    it('allows an already-linked Google account even when its email is not verified', async () => {
        mockAccountFindUnique.mockResolvedValue({ id: 'acct-1' });
        await expect(googleSignIn(false)).resolves.toBe(true);
        expect(mockAccountFindUnique).toHaveBeenCalledWith({
            where: { provider_providerAccountId: { provider: 'google', providerAccountId: 'g-sub' } },
            select: { id: true },
        });
    });

    it('leaves persona-mint sign-in untouched', async () => {
        await expect(signIn({
            user: { id: '7', email: 'p@example.com' },
            account: { provider: PERSONA_MINT_PROVIDER_ID, providerAccountId: '7', type: 'credentials' },
        } as unknown as Parameters<SignInCallback>[0])).resolves.toBe(true);
        expect(mockAccountFindUnique).not.toHaveBeenCalled();
    });
});
