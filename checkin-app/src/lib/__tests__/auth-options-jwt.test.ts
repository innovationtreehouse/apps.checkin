/**
 * @jest-environment node
 */
/**
 * Privilege-revocation tests for the jwt() callback in auth-options.ts.
 *
 * The jwt() callback is the PRIMARY enforcement path for revocation: on every token refresh
 * (no `user` present, `token.id` set) it re-looks-up the participant and re-stamps authority
 * claims, so a deleted account or a board "Deny Membership" loses access within the refresh
 * window instead of when the JWT ages out. authClaims.test.ts covers the pure claim-stamper
 * (assignParticipantClaims) in isolation; this drives the callback WIRING around it.
 *
 * prisma is mocked (no DB). withAuroraResumeRetry passes through — it only retries on P1001,
 * which a mocked findUnique never throws. assignParticipantClaims is the REAL implementation so
 * we exercise the actual stamping the callback relies on.
 */

import prisma from '@/lib/prisma';
import { config, ORG_DOMAIN } from '@/lib/config';
import { addHouseholdLead } from '@/lib/household/leads';

// Real ORG_DOMAIN/evaluateMint; settable env predicates so auth-options constructs cleanly
// (GoogleProvider reads the client env at module load).
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

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
        household: { create: jest.fn() },
        // #1286: the jwt callback resolves the catalog-viewer volunteer leg.
        volunteerDesignation: { findMany: jest.fn().mockResolvedValue([]) },
        // createParticipantWithHousehold mints the person id through
        // mintPersonId(tx), which is one $queryRaw on the tx client (#1693).
        $queryRaw: jest.fn().mockResolvedValue([{ value: 2503 }]),
        $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prismaMockTx)),
    },
}));

jest.mock('@/lib/household/leads', () => ({ addHouseholdLead: jest.fn() }));

// setRoleFlag's write-choke-point plumbing (matrix + last-board guard + the PersonRole
// upsert/mirror dual-write) has its own integration coverage (adminRolesAPI.integration.test.ts);
// this file only drives the jwt() callback WIRING around it, so it's mocked here like
// addHouseholdLead above.
jest.mock('@/lib/roles', () => ({
    ...jest.requireActual('@/lib/roles'),
    setRoleFlag: jest.fn(),
}));

// jest.setup.js globally mocks @/lib/auth-options to `{}`; unmock to get the real callbacks.
jest.unmock('@/lib/auth-options');

import { authOptions, PERSONA_MINT_PROVIDER_ID } from '@/lib/auth-options';
import { FLAG_TO_KIND, type RoleFlag } from '@/lib/roles';

const mockFindUnique = (prisma as unknown as { person: { findUnique: jest.Mock } })
    .person.findUnique;
const mockUpdate = (prisma as unknown as { person: { update: jest.Mock } })
    .person.update;
const mockDesignations = (prisma as unknown as { volunteerDesignation: { findMany: jest.Mock } })
    .volunteerDesignation.findMany;
const mockCheckinEnv = config.checkinEnv as jest.Mock;

// The transaction client the `$transaction` mock above hands to its callback — same object as
// `prisma` itself is fine here since createParticipantWithHousehold only touches household/participant.
const prismaMockTx = prisma as unknown as { household: { create: jest.Mock }; person: { create: jest.Mock } };

type JwtCallback = NonNullable<NonNullable<typeof authOptions.callbacks>['jwt']>;
const jwt: JwtCallback = authOptions.callbacks!.jwt!;
type SessionCallback = NonNullable<NonNullable<typeof authOptions.callbacks>['session']>;
const session: SessionCallback = authOptions.callbacks!.session!;

// Minimal args the callback ignores on the refresh path (no google/persona provider).
function callRefresh(token: Record<string, unknown>) {
    return jwt({ token, account: null, profile: undefined } as unknown as Parameters<JwtCallback>[0]);
}

function dbParticipant(overrides: Record<string, unknown> = {}) {
    const merged = {
        id: 7,
        email: 'p@example.com',
        isSysadmin: true,
        isKeyholder: true,
        isBoardMember: true,
        isBackgroundCheckReviewer: true,
        householdId: 99,
        toolStatuses: [{ toolId: 1, level: 'CERTIFIED' }],
        household: { orgMembership: { status: 'ACTIVE' } },
        canAccessStaging: false,
        ...overrides,
    } as Record<string, unknown>;
    // Claims now derive from `roles` (PersonRole rows), not the boolean columns —
    // translate this fixture's flat flags into the shape auth-options actually reads.
    const roles = (Object.keys(FLAG_TO_KIND) as RoleFlag[])
        .filter((flag) => merged[flag])
        .map((flag) => ({ role: FLAG_TO_KIND[flag] }));
    return { ...merged, roles };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('jwt() callback — revocation enforcement on refresh', () => {
    it('deleted participant (findUnique → null, token.id set) ⇒ returns an empty token', async () => {
        mockFindUnique.mockResolvedValue(null);

        const result = await callRefresh({
            id: 7,
            isSysadmin: true,
            isKeyholder: true,
            isBoardMember: true,
            isBackgroundCheckReviewer: true,
        });

        // Fails closed: no identity, no roles carried forward.
        expect(result).toEqual({});
        expect((result as { id?: unknown }).id).toBeUndefined();
        expect((result as { isSysadmin?: unknown }).isSysadmin).toBeUndefined();
    });

    it('merge tombstone (LIVE_PERSON filter misses) ⇒ returns an empty token', async () => {
        // A merged-away person keeps its row and its roles; the filter in the where clause
        // is what makes the lookup miss, so assert the clause itself as well as the outcome.
        mockFindUnique.mockResolvedValue(null);

        const result = await callRefresh({ id: 7, isBoardMember: true });

        expect(mockFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 7, mergedIntoId: null } }),
        );
        expect(result).toEqual({});
    });

    it('DENIED membership ⇒ denied=true and every role flag forced false', async () => {
        mockFindUnique.mockResolvedValue(
            dbParticipant({ household: { orgMembership: { status: 'DENIED' } } }),
        );

        const result = (await callRefresh({
            id: 7,
            isSysadmin: true,
            isKeyholder: true,
            isBoardMember: true,
            isBackgroundCheckReviewer: true,
        })) as Record<string, unknown>;

        expect(result.denied).toBe(true);
        expect(result.isSysadmin).toBe(false);
        expect(result.isKeyholder).toBe(false);
        expect(result.isBoardMember).toBe(false);
        expect(result.isBackgroundCheckReviewer).toBe(false);
        expect(result.toolStatuses).toEqual([]);
        // Identity preserved so the /access-denied gate can still resolve the session.
        expect(result.id).toBe(7);
    });

    it('active isSysadmin ⇒ role flags re-stamped true', async () => {
        mockFindUnique.mockResolvedValue(dbParticipant());

        const result = (await callRefresh({
            id: 7,
            // Token came in with roles already stripped — refresh must restore them from the DB.
            isSysadmin: false,
            isKeyholder: false,
        })) as Record<string, unknown>;

        expect(mockFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 7, mergedIntoId: null } }),
        );
        expect(result.denied).toBe(false);
        expect(result.isSysadmin).toBe(true);
        expect(result.isKeyholder).toBe(true);
        expect(result.isBoardMember).toBe(true);
        expect(result.isBackgroundCheckReviewer).toBe(true);
        expect(result.toolStatuses).toEqual([{ toolId: 1, level: 'CERTIFIED' }]);
    });

    it('re-stamps canAccessStaging from the DB column on refresh (ops-stg gate)', async () => {
        mockFindUnique.mockResolvedValue(dbParticipant({ canAccessStaging: true }));

        const result = (await callRefresh({ id: 7, canAccessStaging: false })) as Record<string, unknown>;

        expect(result.canAccessStaging).toBe(true);
    });

    it('no token.id and no user ⇒ no DB lookup, token passed through untouched', async () => {
        const result = await callRefresh({ hd: 'x', emailVerified: true });

        expect(mockFindUnique).not.toHaveBeenCalled();
        expect(result).toEqual({ hd: 'x', emailVerified: true });
    });
});

describe('jwt() callback — catalog-viewer volunteer leg (#1286)', () => {
    const plainMember = { roles: [], programsLed: [] };

    it('matches a designation on the Gmail dot/plus-insensitive canonical email', async () => {
        mockFindUnique.mockResolvedValue({ ...dbParticipant({ email: 'Jane.Doe+club@gmail.com' }), ...plainMember });
        mockDesignations.mockResolvedValue([{ email: 'janedoe@gmail.com' }]);
        const token = await callRefresh({ id: 7 });
        expect(token.hasVolunteerDesignation).toBe(true);
    });

    it('matches a legacy non-canonical designation row', async () => {
        mockFindUnique.mockResolvedValue({ ...dbParticipant({ email: 'janedoe@gmail.com' }), ...plainMember });
        mockDesignations.mockResolvedValue([{ email: 'Jane.Doe@GoogleMail.com' }]);
        const token = await callRefresh({ id: 7 });
        expect(token.hasVolunteerDesignation).toBe(true);
    });

    it('keeps dots significant outside Gmail', async () => {
        mockFindUnique.mockResolvedValue({ ...dbParticipant({ email: 'jane.doe@example.com' }), ...plainMember });
        mockDesignations.mockResolvedValue([{ email: 'janedoe@example.com' }]);
        const token = await callRefresh({ id: 7 });
        expect(token.hasVolunteerDesignation).toBe(false);
    });

    it('skips the lookup when a role leg already admits', async () => {
        mockFindUnique.mockResolvedValue(dbParticipant());
        const token = await callRefresh({ id: 7, hasVolunteerDesignation: true });
        expect(mockDesignations).not.toHaveBeenCalled();
        expect(token.hasVolunteerDesignation).toBe(false);
    });

    it('skips the lookup and clears the claim for a DENIED household', async () => {
        mockFindUnique.mockResolvedValue({
            ...dbParticipant({ household: { orgMembership: { status: 'DENIED' } } }),
            ...plainMember,
        });
        mockDesignations.mockResolvedValue([{ email: 'p@example.com' }]);
        const token = await callRefresh({ id: 7, hasVolunteerDesignation: true });
        expect(mockDesignations).not.toHaveBeenCalled();
        expect(token.hasVolunteerDesignation).toBe(false);
    });
});

describe('jwt() callback — initial sign-in branch (user present)', () => {
    it('stamps claims from the participant resolved by user.email', async () => {
        mockFindUnique.mockResolvedValue(dbParticipant({ isSysadmin: true }));

        const result = (await jwt({
            token: {},
            user: { email: 'p@example.com' },
            account: { provider: 'google' },
            profile: { email_verified: true },
        } as unknown as Parameters<JwtCallback>[0])) as Record<string, unknown>;

        // Resolved by email on sign-in (not by id).
        expect(mockFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { email: 'p@example.com', mergedIntoId: null } }),
        );
        expect(result.id).toBe(7);
        expect(result.isSysadmin).toBe(true);
        expect(result.denied).toBe(false);
        // Google hosted-domain claims captured for the dev gate.
        expect(result.emailVerified).toBe(true);
    });

    it('lowercases a mixed-case user.email before the lookup (#292 read normalization)', async () => {
        mockFindUnique.mockResolvedValue(dbParticipant({ isSysadmin: false }));

        await jwt({
            token: {},
            user: { email: 'John.Doe@Example.com' },
            account: { provider: 'google' },
            profile: { email_verified: true },
        } as unknown as Parameters<JwtCallback>[0]);

        // Stored emails are lowercased on write, so the sign-in lookup key must be too —
        // otherwise Google's casing misses the row and NextAuth mints a duplicate.
        expect(mockFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { email: 'john.doe@example.com', mergedIntoId: null } }),
        );
    });

    it('promotes a BOOTSTRAP_SYSADMINS email to isSysadmin on sign-in', async () => {
        const prevEnv = process.env.BOOTSTRAP_SYSADMINS;
        process.env.BOOTSTRAP_SYSADMINS = 'Boss@Example.com';
        let freshJwt!: JwtCallback;
        let freshFindUnique!: jest.Mock;
        let freshSetRoleFlag!: jest.Mock;
        try {
            jest.isolateModules(() => {
                // Fresh module registry so BOOTSTRAP_SYSADMINS is re-read from the env just set above.
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const freshPrisma = (require('@/lib/prisma') as { default: { person: { findUnique: jest.Mock; update: jest.Mock } } }).default;
                freshFindUnique = freshPrisma.person.findUnique;
                freshFindUnique.mockResolvedValue(dbParticipant({ isSysadmin: false, email: 'boss@example.com' }));
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                freshSetRoleFlag = (require('@/lib/roles') as { setRoleFlag: jest.Mock }).setRoleFlag;
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                freshJwt = (require('@/lib/auth-options') as typeof import('@/lib/auth-options')).authOptions.callbacks!.jwt!;
            });

            const result = (await freshJwt({
                token: {},
                user: { email: 'boss@example.com' },
                account: { provider: 'google' },
                profile: { email_verified: true },
            } as unknown as Parameters<JwtCallback>[0])) as Record<string, unknown>;

            // Env comparison is case-insensitive (BOOTSTRAP_SYSADMINS is lowercased on parse).
            // The bootstrap promotion routes through the same write choke point every role
            // grant uses (lib/roles.ts setRoleFlag), passing the "system" actor bypass — not
            // a direct person.update, and not the matrix (there's no requesting user to check).
            expect(freshSetRoleFlag).toHaveBeenCalledWith(
                expect.anything(),
                7,
                'isSysadmin',
                true,
                'system',
            );
            expect(result.isSysadmin).toBe(true);
        } finally {
            process.env.BOOTSTRAP_SYSADMINS = prevEnv;
        }
    });

    it('does not re-promote a participant already isSysadmin', async () => {
        mockFindUnique.mockResolvedValue(dbParticipant({ isSysadmin: true }));

        await jwt({
            token: {},
            user: { email: 'p@example.com' },
            account: { provider: 'google' },
            profile: { email_verified: true },
        } as unknown as Parameters<JwtCallback>[0]);

        expect(mockUpdate).not.toHaveBeenCalled();
    });
});

describe('jwt() callback — persona-mint sign-in branch', () => {
    it('stamps impersonatedBy + org gate claims when checkinEnv is dev, and skips the participant lookup for a guest mint (no user.email)', async () => {
        const result = (await jwt({
            token: {},
            user: { impersonatedBy: 'real@innovationtreehouse.org' },
            account: { provider: PERSONA_MINT_PROVIDER_ID },
            profile: undefined,
        } as unknown as Parameters<JwtCallback>[0])) as Record<string, unknown>;

        expect(result.impersonatedBy).toBe('real@innovationtreehouse.org');
        expect(result.hd).toBe(ORG_DOMAIN);
        expect(result.emailVerified).toBe(true);
        expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it('does not carry the dev-instance gate claims when checkinEnv is not dev', async () => {
        mockCheckinEnv.mockReturnValueOnce('local');

        const result = (await jwt({
            token: {},
            user: { impersonatedBy: null },
            account: { provider: PERSONA_MINT_PROVIDER_ID },
            profile: undefined,
        } as unknown as Parameters<JwtCallback>[0])) as Record<string, unknown>;

        expect(result.impersonatedBy).toBeNull();
        expect(result.hd).toBeUndefined();
        expect(result.emailVerified).toBeUndefined();
    });
});

describe('session() callback', () => {
    it('copies token claims onto session.user, applying every `?? default` fallback', async () => {
        const result = await session({
            session: { user: {}, expires: '2099-01-01' },
            token: { id: 7 },
        } as unknown as Parameters<SessionCallback>[0]);

        const user = (result as unknown as { user: Record<string, unknown> }).user;
        expect(user.id).toBe(7);
        expect(user.denied).toBe(false);
        expect(user.householdLead).toBe(false);
        expect(user.programsLed).toEqual([]);
        expect(user.toolStatuses).toEqual([]);
        expect(user.impersonatedBy).toBeNull();
        expect(user.hd).toBeNull();
        expect(user.emailVerified).toBe(false);
        expect(user.canAccessStaging).toBe(false);
    });

    it('prefers explicit token values over the `??` defaults', async () => {
        const result = await session({
            session: { user: {}, expires: '2099-01-01' },
            token: {
                id: 7,
                denied: true,
                householdLead: true,
                programsLed: [1, 2],
                toolStatuses: [{ toolId: 1, level: 'CERTIFIED' }],
                impersonatedBy: 'real@x.org',
                hd: ORG_DOMAIN,
                emailVerified: true,
                canAccessStaging: true,
            },
        } as unknown as Parameters<SessionCallback>[0]);

        const user = (result as unknown as { user: Record<string, unknown> }).user;
        expect(user.denied).toBe(true);
        expect(user.householdLead).toBe(true);
        expect(user.programsLed).toEqual([1, 2]);
        expect(user.impersonatedBy).toBe('real@x.org');
        expect(user.hd).toBe(ORG_DOMAIN);
        expect(user.canAccessStaging).toBe(true);
    });

    it('is a no-op when session.user is absent', async () => {
        const bareSession = { expires: '2099-01-01' };
        const result = await session({
            session: bareSession,
            token: { id: 7 },
        } as unknown as Parameters<SessionCallback>[0]);

        expect(result).toEqual(bareSession);
    });
});

describe('Google provider profile() mapper', () => {
    it('maps a Google profile onto the NextAuth user shape', () => {
        // next-auth's GoogleProvider() factory returns its OWN default `.profile` at the top level
        // and stashes our config (including the real custom `profile`) under `.options` — same
        // wrapping auth-options-authorize.test.ts already relies on for the persona-mint provider.
        const google = authOptions.providers.find(
            (p) => (p as unknown as { id?: string }).id === 'google',
        ) as unknown as { options: { profile: (p: Record<string, unknown>) => unknown } };

        const mapped = google.options.profile({ sub: 'g-123', name: 'Ann', email: 'ann@x.org', picture: 'http://img/ann.png' });

        expect(mapped).toEqual({
            id: 'g-123',
            name: 'Ann',
            email: 'ann@x.org',
            image: 'http://img/ann.png',
            googleId: 'g-123',
        });
    });
});

describe('adapter — createUser / getUser (Participant.id is an Int, NextAuth IDs are strings)', () => {
    it('getUser: parses a numeric string id and stringifies the result', async () => {
        mockFindUnique.mockResolvedValue({ id: 7, email: 'p@example.com', name: 'P' });

        const user = await (authOptions.adapter!.getUser as (id: string) => Promise<unknown>)('7');

        expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 7 } });
        expect(user).toEqual({ id: '7', email: 'p@example.com', name: 'P' });
    });

    it('getUser: returns null for a non-numeric id without querying the DB', async () => {
        const user = await (authOptions.adapter!.getUser as (id: string) => Promise<unknown>)('not-a-number');

        expect(mockFindUnique).not.toHaveBeenCalled();
        expect(user).toBeNull();
    });

    it('getUser: returns null when no participant matches', async () => {
        mockFindUnique.mockResolvedValue(null);

        const user = await (authOptions.adapter!.getUser as (id: string) => Promise<unknown>)('7');

        expect(user).toBeNull();
    });

    it('createUser: creates a Household + Participant in one transaction, adds the household lead, and stringifies the id', async () => {
        (prismaMockTx.household.create as jest.Mock).mockResolvedValue({ id: 55 });
        (prismaMockTx.person.create as jest.Mock).mockResolvedValue({ id: 9, email: 'new@x.org', name: 'New Person' });

        const created = await (authOptions.adapter!.createUser as (u: Record<string, unknown>) => Promise<unknown>)({
            name: 'New Person',
            email: 'new@x.org',
        });

        expect(prismaMockTx.household.create).toHaveBeenCalledWith({ data: { name: 'New Person' } });
        expect(prismaMockTx.person.create).toHaveBeenCalledWith({
            data: { name: 'New Person', email: 'new@x.org', id: 2503, householdId: 55 },
        });
        expect(addHouseholdLead).toHaveBeenCalledWith(expect.anything(), 55, 9);
        expect(created).toEqual({ id: '9', email: 'new@x.org', name: 'New Person' });
    });

    it('createUser: defaults email to "" when the participant has none', async () => {
        (prismaMockTx.household.create as jest.Mock).mockResolvedValue({ id: 56 });
        (prismaMockTx.person.create as jest.Mock).mockResolvedValue({ id: 10, email: null, name: 'No Email' });

        const created = await (authOptions.adapter!.createUser as (u: Record<string, unknown>) => Promise<unknown>)({
            name: 'No Email',
        });

        expect((created as { email: string }).email).toBe('');
    });
});
