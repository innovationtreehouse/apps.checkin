/**
 * @jest-environment node
 */
/**
 * Regression guard for the NextAuth adapter's Int↔string id boundary in
 * auth-options.ts.
 *
 * Why this exists: the adapter's user/account methods run ONLY inside the real
 * Google OAuth callback — persona-mint/credentials sign-in (what flow tests use
 * via loginAs) never touches the adapter, and the global prisma mock in
 * jest.setup.js resolves ANY model name — so no other tier reaches this code.
 * Two bugs have shipped here as a result:
 *   - #708 (Participant→Person rename) missed the model map behind an `as` cast;
 *     getUserByEmail crashed with `undefined ... findUnique`.
 *   - createUser returned a string id that then crashed linkAccount writing it
 *     into Account.userId (Int) — `Expected Int, provided String` — on every
 *     first Google sign-in, while CI stayed green.
 *
 * The boundary is now unified: every user/account method converts ids through
 * toAdapterUser (Int→string out) / toDbId (string→Int in). This suite (a) mocks
 * prisma with ONLY the real model names and (b) actually CALLS the adapter
 * methods (their closures are lazy — a stale map or missed coercion only
 * explodes on invocation, exactly as in production), asserting BOTH directions
 * for every method that crosses the boundary.
 */

import prisma from '@/lib/prisma';
import { addHouseholdLead } from '@/lib/household/leads';

// Same env scaffolding as auth-options-jwt.test.ts: real ORG_DOMAIN, settable
// predicates so auth-options constructs cleanly at import time.
jest.mock('@/lib/config', () => {
    const actual = jest.requireActual('@/lib/config');
    return {
        __esModule: true,
        ...actual,
        config: {
            ...actual.config,
            checkinEnv: jest.fn(() => 'dev'),
            isDevInstance: jest.fn(() => true),
            isProd: jest.fn(() => false),
            nextAuthSecret: jest.fn(() => 'test-secret'),
            googleClientId: jest.fn(() => 'gid'),
            googleClientSecret: jest.fn(() => 'gsecret'),
        },
    };
});

// ONLY the real model names — a shim pointing at a renamed/stale model finds
// `undefined` here and throws, exactly like production. Do NOT add a fallback
// proxy; the whole point is that unknown model names must fail.
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn(), delete: jest.fn() },
        account: { findUnique: jest.fn(), create: jest.fn() },
        household: { create: jest.fn() },
        $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prismaMockTx)),
    },
}));

jest.mock('@/lib/household/leads', () => ({ addHouseholdLead: jest.fn() }));

// jest.setup.js globally mocks @/lib/auth-options to `{}`; unmock to get the real adapter.
jest.unmock('@/lib/auth-options');

import { authOptions } from '@/lib/auth-options';

// $queryRaw is here for the same reason every model name is: createParticipantWithHousehold
// mints the person id through mintPersonId(tx), which is one $queryRaw. Named
// explicitly, NOT via a fallback proxy — see the note above.
const prismaMockTx = {
    household: { create: jest.fn() },
    person: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ value: 2503 }]),
};

const mockPersonFindUnique = (prisma as unknown as { person: { findUnique: jest.Mock } })
    .person.findUnique;

// Adapter methods are typed optional on Adapter; the shim always provides these.
const adapter = authOptions.adapter as unknown as {
    getUserByEmail: (email: string) => Promise<{ id: string; email: string } | null>;
    getUserByAccount: (key: { provider: string; providerAccountId: string }) => Promise<{ id: string; email: string } | null>;
    getUser: (id: string) => Promise<{ id: string; email: string } | null>;
    createUser: (user: Record<string, unknown>) => Promise<{ id: string; email: string }>;
    updateUser: (user: { id: string; name?: string | null }) => Promise<{ id: string; email: string }>;
    linkAccount: (account: Record<string, unknown>) => Promise<unknown>;
};

const mockAccount = (prisma as unknown as { account: { findUnique: jest.Mock; create: jest.Mock } }).account;
const mockPersonUpdate = (prisma as unknown as { person: { update: jest.Mock } }).person.update;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('PrismaAdapter user-model shim (auth-options.ts)', () => {
    test('adapter is wired with the user→person mapping', () => {
        // If the shim referenced a stale model, `user` would be undefined and
        // PrismaAdapter would still construct — the breakage is lazy. Assert the
        // methods exist up front so a gutted adapter fails loudly here too.
        expect(typeof adapter.getUserByEmail).toBe('function');
        expect(typeof adapter.getUser).toBe('function');
        expect(typeof adapter.createUser).toBe('function');
    });

    test('getUserByEmail (the OAuth-callback path that broke in #708) queries prisma.person', async () => {
        mockPersonFindUnique.mockResolvedValue(null);
        // With a stale shim this throws `Cannot read properties of undefined
        // (reading 'findUnique')` — the exact production failure.
        await expect(adapter.getUserByEmail('who@example.com')).resolves.toBeNull();
        expect(mockPersonFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ email: 'who@example.com' }) }),
        );
    });

    // #292: Google hands NextAuth its own casing; the stored value is lowercased
    // on write, so the lookup key must be lowercased too or a mixed-case sign-in
    // misses the existing row and NextAuth mints a duplicate participant/household.
    test('getUserByEmail lowercases the lookup key (#292 read normalization)', async () => {
        mockPersonFindUnique.mockResolvedValue(null);
        await adapter.getUserByEmail('John.Doe@Example.com');
        expect(mockPersonFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ email: 'john.doe@example.com' }) }),
        );
    });

    test('getUser resolves numeric ids against prisma.person', async () => {
        mockPersonFindUnique.mockResolvedValue({ id: 42, email: 'p@example.com' });
        const user = await adapter.getUser('42');
        expect(mockPersonFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 42 } }),
        );
        expect(user).toEqual(expect.objectContaining({ id: '42', email: 'p@example.com' }));
    });

    test('createUser creates a Person inside a household transaction', async () => {
        prismaMockTx.household.create.mockResolvedValue({ id: 9 });
        prismaMockTx.person.create.mockResolvedValue({ id: 7, email: 'new@example.com' });
        prismaMockTx.$queryRaw.mockResolvedValue([{ value: 2503 }]);
        const created = await adapter.createUser({ email: 'new@example.com', name: 'New Person' });
        expect(prismaMockTx.person.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ householdId: 9 }) }),
        );
        expect(addHouseholdLead).toHaveBeenCalled();
        expect(created).toEqual(expect.objectContaining({ id: '7', email: 'new@example.com' }));
    });

    // #1693: the OAuth path is one of the nine sites that must pass an explicit
    // minted id. A sequence-minted id here is a silent gap on every first sign-in
    // — nothing else in this tree would notice.
    test('createUser passes the minted id through to person.create', async () => {
        prismaMockTx.household.create.mockResolvedValue({ id: 9 });
        prismaMockTx.person.create.mockResolvedValue({ id: 2503, email: 'minted@example.com' });
        prismaMockTx.$queryRaw.mockResolvedValue([{ value: 2503 }]);
        await adapter.createUser({ email: 'minted@example.com', name: 'Minted' });
        expect(prismaMockTx.$queryRaw).toHaveBeenCalledTimes(1);
        expect(prismaMockTx.person.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ id: 2503 }) }),
        );
    });

    // #1432 Decision 4: sign-in must never fail for want of a name. createUser
    // is the one remaining place a name is manufactured — from the email
    // local-part, never left null.
    test('createUser defaults a missing name to the email local-part (Decision 4)', async () => {
        prismaMockTx.household.create.mockResolvedValue({ id: 9 });
        prismaMockTx.person.create.mockResolvedValue({ id: 7, email: 'nodisplay@example.com' });
        prismaMockTx.$queryRaw.mockResolvedValue([{ value: 2503 }]);
        await adapter.createUser({ email: 'nodisplay@example.com' });
        expect(prismaMockTx.person.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ name: 'nodisplay' }) }),
        );
    });

    test('createUser defaults a whitespace-only name to the email local-part', async () => {
        prismaMockTx.household.create.mockResolvedValue({ id: 9 });
        prismaMockTx.person.create.mockResolvedValue({ id: 8, email: 'blank@example.com' });
        prismaMockTx.$queryRaw.mockResolvedValue([{ value: 2504 }]);
        await adapter.createUser({ email: 'blank@example.com', name: '   ' });
        expect(prismaMockTx.person.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ name: 'blank' }) }),
        );
    });

    test('getUserByEmail returns a string id (Int→string on the way out)', async () => {
        mockPersonFindUnique.mockResolvedValue({ id: 55, email: 'q@example.com' });
        const user = await adapter.getUserByEmail('q@example.com');
        expect(user).toEqual(expect.objectContaining({ id: '55', email: 'q@example.com' }));
    });

    test('getUserByAccount resolves the account→person and stringifies the id', async () => {
        mockAccount.findUnique.mockResolvedValue({ user: { id: 88, email: 'acct@example.com' } });
        const user = await adapter.getUserByAccount({ provider: 'google', providerAccountId: '114917684045724477868' });
        expect(mockAccount.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { provider_providerAccountId: { provider: 'google', providerAccountId: '114917684045724477868' } },
            }),
        );
        expect(user).toEqual(expect.objectContaining({ id: '88', email: 'acct@example.com' }));
    });

    // The bug from the checkin-dev logs: base linkAccount wrote the string userId
    // straight into Account.userId (Int) → `Expected Int, provided String`.
    test('linkAccount coerces the string userId to Int before prisma.account.create', async () => {
        mockAccount.create.mockResolvedValue({});
        await adapter.linkAccount({
            userId: '298',
            type: 'oauth',
            provider: 'google',
            providerAccountId: '114917684045724477868',
            access_token: 'tok',
            scope: 'openid email',
        });
        expect(mockAccount.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ userId: 298, provider: 'google' }) }),
        );
        // The id landing in the Int column must be a number, not the string "298".
        expect(typeof mockAccount.create.mock.calls[0][0].data.userId).toBe('number');
    });

    test('updateUser converts the string id to Int for the where clause', async () => {
        mockPersonUpdate.mockResolvedValue({ id: 12, email: 'u@example.com' });
        const user = await adapter.updateUser({ id: '12', name: 'Renamed' });
        expect(mockPersonUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 12 } }),
        );
        expect(user).toEqual(expect.objectContaining({ id: '12', email: 'u@example.com' }));
    });

    // #1432 site 14 / Decision 5: a provider that stops sending a name must
    // not erase one already on file — `name: null` must pass through as
    // `undefined` (Prisma leaves the column alone) rather than nulling it.
    test('updateUser with a null name leaves the stored name untouched', async () => {
        mockPersonUpdate.mockResolvedValue({ id: 12, email: 'u@example.com', name: 'Existing Name' });
        await adapter.updateUser({ id: '12', name: null });
        expect(mockPersonUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ name: undefined }) }),
        );
    });
});
