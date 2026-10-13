/**
 * @jest-environment node
 */
/**
 * Security glue tests for the persona-mint authorize() in auth-options.ts.
 *
 * evaluateMint (the policy) is exhaustively unit-tested elsewhere; this drives the GLUE that wires
 * the caller's decoded token INTO evaluateMint and the decision back out into a minted session + a
 * ledger row. The escalation-relevant invariants:
 *   - the claims handed to evaluateMint come from the CALLER's token (getToken), never the target
 *     persona — a swap here would let any persona escalate to a verified-org mint;
 *   - the ledger/audit row is attributed to the REAL human (impersonator), never the persona;
 *   - prod is denied even if the provider somehow ran (defense in depth behind the provider gate);
 *   - "return to me" clears impersonatedBy.
 *
 * getToken / prisma / ledger / config are mocked, so no DB is required. evaluateMint is the REAL
 * implementation, spied so we can assert exactly what claims the glue passed it.
 */

import { getToken } from 'next-auth/jwt';
import { ORG_DOMAIN } from '@/lib/config';
import { config } from '@/lib/config';
import { evaluateMint } from '@/lib/impersonation';
import { recordLedger } from '@/lib/dev/ledger';
import prisma from '@/lib/prisma';

// getToken decrypts the CALLER cookie — the security boundary. Mock it to inject the caller.
jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));

// authorize() builds a cookie store via next/headers; getToken is mocked so the store is inert.
jest.mock('next/headers', () => ({ cookies: jest.fn(async () => ({})) }));

// Keep ORG_DOMAIN real (the real evaluateMint reads it), but make the env predicates settable so
// each test picks prod/dev/local and the provider is always present.
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

// Spy the REAL policy so we can assert the exact claims the glue passed in.
jest.mock('@/lib/impersonation', () => {
    const actual = jest.requireActual('@/lib/impersonation');
    return { __esModule: true, ...actual, evaluateMint: jest.fn(actual.evaluateMint) };
});

jest.mock('@/lib/dev/ledger', () => ({ recordLedger: jest.fn() }));

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { person: { findUnique: jest.fn(), findFirst: jest.fn() } },
}));

// jest.setup.js globally mocks @/lib/auth-options to `{}` (it normally pulls GoogleProvider's heavy
// import chain + requireEnv at load). We want the REAL module here — our config mock supplies the
// Google client env so it constructs cleanly. unmock overrides the global setup mock for this file.
jest.unmock('@/lib/auth-options');

// Imported after the mocks so the provider binds to them.
import { authOptions, PERSONA_MINT_PROVIDER_ID } from '@/lib/auth-options';

const mockGetToken = getToken as jest.Mock;
const mockEvaluateMint = evaluateMint as jest.Mock;
const mockRecordLedger = recordLedger as jest.Mock;
const mockFindUnique = (prisma as unknown as { person: { findUnique: jest.Mock } })
    .person.findUnique;
const mockFindFirst = (prisma as unknown as { person: { findFirst: jest.Mock } })
    .person.findFirst;
const mockCheckinEnv = config.checkinEnv as jest.Mock;

// next-auth v4 CredentialsProvider returns { id: "credentials", authorize: () => null, options }:
// the configured id AND the real authorize both live under `options`. (The top-level `id` is the
// literal "credentials" for every credentials provider, so we match on options.id.)
type AuthorizeFn = (
    credentials: Record<string, string> | undefined,
    req: unknown,
) => Promise<unknown>;
function getAuthorize(): AuthorizeFn {
    const provider = authOptions.providers.find(
        (p) => (p as { options?: { id?: string } }).options?.id === PERSONA_MINT_PROVIDER_ID,
    ) as unknown as { options: { authorize: AuthorizeFn } } | undefined;
    if (!provider) throw new Error('persona-mint provider not registered');
    return provider.options.authorize;
}

const REQ = { headers: {} };

const ORG_CALLER = {
    email: 'daniel@innovationtreehouse.org',
    hd: ORG_DOMAIN,
    emailVerified: true,
    impersonatedBy: null,
};

beforeEach(() => {
    jest.clearAllMocks();
    mockCheckinEnv.mockReturnValue('dev');
});

describe('persona-mint authorize() glue', () => {
    it('is registered as a provider (dev instance)', () => {
        expect(() => getAuthorize()).not.toThrow();
    });

    it('stays registered on a prod BUILD (NODE_ENV=production) when CHECKIN_ENV is dev — the cloud dev instance', () => {
        // The cloud dev instance runs the prod image: NODE_ENV=production + CHECKIN_ENV=dev
        // (Dockerfile pins NODE_ENV; deploy-dev.yml ships that image). Registration must key on
        // CHECKIN_ENV alone — a NODE_ENV clause here (#280) unregistered the provider on cloud
        // dev and every mint failed. Prod SAFETY is the policy's job: see the "prod env →
        // returns null even if the provider runs" test below.
        const env = process.env as Record<string, string | undefined>;
        const before = env.NODE_ENV;
        env.NODE_ENV = 'production';
        try {
            jest.isolateModules(() => {
                // Re-evaluate the module under NODE_ENV=production (providers are built at eval).
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('@/lib/auth-options') as typeof import('@/lib/auth-options');
                const provider = fresh.authOptions.providers.find(
                    (p) => (p as { options?: { id?: string } }).options?.id === fresh.PERSONA_MINT_PROVIDER_ID,
                );
                expect(provider).toBeDefined();
            });
        } finally {
            env.NODE_ENV = before;
        }
    });

    it('prod env → returns null even if the provider runs (defense in depth)', async () => {
        mockCheckinEnv.mockReturnValue('prod');
        mockGetToken.mockResolvedValue(ORG_CALLER);

        const result = await getAuthorize()({ mode: 'impersonate', personaId: '42' }, REQ);

        expect(result).toBeNull();
        // The glue still consulted the policy with checkinEnv:'prod' — the policy is what denies.
        expect(mockEvaluateMint).toHaveBeenCalledWith(
            expect.objectContaining({ checkinEnv: 'prod' }),
        );
        // No mint, no audit, no participant lookup.
        expect(mockRecordLedger).not.toHaveBeenCalled();
        expect(mockFindUnique).not.toHaveBeenCalled();
        expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('dev, non-org caller → null (no participant lookup, no ledger)', async () => {
        mockGetToken.mockResolvedValue({
            email: 'someone@gmail.com',
            hd: null,
            emailVerified: true,
            impersonatedBy: null,
        });

        const result = await getAuthorize()({ mode: 'impersonate', personaId: '42' }, REQ);

        expect(result).toBeNull();
        expect(mockRecordLedger).not.toHaveBeenCalled();
        expect(mockFindUnique).not.toHaveBeenCalled();
        expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('dev, anonymous caller → null', async () => {
        mockGetToken.mockResolvedValue(null);

        const result = await getAuthorize()({ mode: 'impersonate', personaId: '42' }, REQ);

        expect(result).toBeNull();
        // null caller is forwarded to the policy as null, not silently coerced.
        expect(mockEvaluateMint).toHaveBeenCalledWith(
            expect.objectContaining({ caller: null }),
        );
    });

    it('dev, org caller → mints the persona AND audits the IMPERSONATOR, not the persona', async () => {
        mockGetToken.mockResolvedValue(ORG_CALLER);
        // Target persona has a DIFFERENT email than the caller — the swap-bug tripwire.
        mockFindFirst.mockResolvedValue({ id: 42, email: 'jane@example.com', name: 'Jane Persona' });

        const result = await getAuthorize()({ mode: 'impersonate', personaId: '42' }, REQ);

        // Minted session is the persona, stamped with the real human as impersonatedBy.
        expect(result).toEqual({
            id: '42',
            email: 'jane@example.com',
            name: 'Jane Persona',
            impersonatedBy: 'daniel@innovationtreehouse.org',
        });

        // ESCALATION GUARD #1: the claims fed to the policy are the CALLER's token, never the
        // persona. A wiring swap (persona claims in place of caller) is the privilege-escalation bug.
        const passedCaller = mockEvaluateMint.mock.calls[0][0].caller;
        expect(passedCaller).toEqual({
            email: 'daniel@innovationtreehouse.org',
            hd: ORG_DOMAIN,
            emailVerified: true,
            impersonatedBy: null,
        });
        expect(passedCaller.email).not.toBe('jane@example.com');

        // ESCALATION GUARD #2: the ledger actor is the real human (impersonator), never the persona.
        expect(mockRecordLedger).toHaveBeenCalledTimes(1);
        const [action, actor, detail] = mockRecordLedger.mock.calls[0];
        expect(action).toBe('impersonate');
        expect(actor).toBe('daniel@innovationtreehouse.org');
        expect(actor).not.toBe('jane@example.com');
        expect(detail).toBe('jane@example.com'); // persona is the detail, not the actor
    });

    it('impersonate mode only resolves @example.com personas, even for a caller that passes evaluateMint (L2)', async () => {
        mockGetToken.mockResolvedValue(ORG_CALLER);

        // Success: an @example.com persona is found via the id+email-suffix filter.
        mockFindFirst.mockResolvedValueOnce({ id: 42, email: 'jane@example.com', name: 'Jane Persona' });
        const minted = await getAuthorize()({ mode: 'impersonate', personaId: '42' }, REQ);
        expect(minted).toEqual({
            id: '42',
            email: 'jane@example.com',
            name: 'Jane Persona',
            impersonatedBy: 'daniel@innovationtreehouse.org',
        });
        expect(mockFindFirst).toHaveBeenCalledWith({
            where: { id: 42, email: { endsWith: '@example.com' } },
        });

        // Failure: a real (non-@example.com) participant id never satisfies the filtered query —
        // the DB where-clause excludes it even though the caller already passed evaluateMint.
        mockFindFirst.mockResolvedValueOnce(null);
        const denied = await getAuthorize()({ mode: 'impersonate', personaId: '7' }, REQ);
        expect(denied).toBeNull();
    });

    it('return-to-me → clears impersonatedBy and audits a plain login as the real human', async () => {
        // Caller is mid-impersonation: a minted dev session carries the org gate claims + provenance.
        mockGetToken.mockResolvedValue({
            email: 'jane@example.com',
            hd: ORG_DOMAIN,
            emailVerified: true,
            impersonatedBy: 'daniel@innovationtreehouse.org',
        });
        // 'return' resolves the real human by email (decision.targetEmail).
        mockFindUnique.mockResolvedValue({ id: 7, email: 'daniel@innovationtreehouse.org', name: 'Daniel' });

        const result = await getAuthorize()({ mode: 'return' }, REQ);

        // Back to the real human, provenance cleared.
        expect(result).toEqual({
            id: '7',
            email: 'daniel@innovationtreehouse.org',
            name: 'Daniel',
            impersonatedBy: null,
        });
        // Looked up the real human by the email the policy chose, not a caller-supplied personaId.
        expect(mockFindUnique).toHaveBeenCalledWith({
            where: { email: 'daniel@innovationtreehouse.org' },
        });
        // No longer impersonating → recorded as a plain login attributed to the real human.
        const [action, actor] = mockRecordLedger.mock.calls[0];
        expect(action).toBe('login');
        expect(actor).toBe('daniel@innovationtreehouse.org');
    });

    it('passes the CALLER token claims into the policy even when a persona is named', async () => {
        // Distinctive caller; a different persona id. If the glue ever swapped these, the policy
        // would receive the persona's (empty) claims and a non-org caller would be denied OR an
        // attacker-chosen persona would set the gate — both caught by asserting the caller below.
        mockGetToken.mockResolvedValue({
            email: 'caller@innovationtreehouse.org',
            hd: ORG_DOMAIN,
            emailVerified: true,
            impersonatedBy: null,
        });
        mockFindFirst.mockResolvedValue({ id: 99, email: 'victim@example.com', name: 'Victim' });

        await getAuthorize()({ mode: 'impersonate', personaId: '99' }, REQ);

        expect(mockEvaluateMint.mock.calls[0][0].caller.email).toBe('caller@innovationtreehouse.org');
        expect(mockEvaluateMint.mock.calls[0][0].mode).toBe('impersonate');
    });

    it('logout mode, dev org caller → mints a synthetic guest session (no participant lookup), audited under the real human', async () => {
        mockGetToken.mockResolvedValue(ORG_CALLER);

        const result = await getAuthorize()({ mode: 'logout' }, REQ);

        // No target participant — the logged-out preview carries no id/roles downstream.
        expect(result).toEqual({
            id: 'guest',
            email: null,
            name: 'Logged out',
            impersonatedBy: 'daniel@innovationtreehouse.org',
        });
        expect(mockFindUnique).not.toHaveBeenCalled();
        expect(mockFindFirst).not.toHaveBeenCalled();
        const [action, actor, detail] = mockRecordLedger.mock.calls[0];
        expect(action).toBe('impersonate');
        expect(actor).toBe('daniel@innovationtreehouse.org');
        expect(detail).toBe('logged out');
    });
});
