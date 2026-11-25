/**
 * @jest-environment node
 *
 * Refusals on the private reads the registry gates: no session gets 401, a caller
 * outside the gate gets 403 before the route queries anything, and a read scoped
 * to the caller ignores a request naming someone else.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import prisma from '@/lib/prisma';
import type { AuthenticatedUser } from '@/types/auth';
import { getKeyVolunteerSelfStatus } from '@/lib/membership/keyVolunteer';
import { householdQuestion } from '@/lib/household/joinQuestion';
import { GET as bgAttestations } from '@/app/api/membership-audit/bg-attestations/route';
import { GET as keyVolunteer } from '@/app/api/membership/key-volunteer/route';
import { GET as reviews } from '@/app/api/membership/reviews/route';
import { GET as applications } from '@/app/api/membership-ops/applications/route';
import { GET as household } from '@/app/api/household/route';
import { GET as householdQuestionRead } from '@/app/api/profile/household-question/route';
import { GET as profile } from '@/app/api/profile/route';
import { GET as profileVisits } from '@/app/api/profile/visits/route';
import { GET as trustedAdultsMine } from '@/app/api/trusted-adults/mine/route';
import { GET as trustedAdultsOperational } from '@/app/api/trusted-adults/operational/route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/auth-options', () => ({ authOptions: {} }));
jest.mock('@/lib/logger', () => ({ logBackendError: jest.fn(), logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('@/lib/orgMembership', () => ({ membershipValidThrough: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/emailIdentity', () => ({ getEmailSenderIdentity: jest.fn().mockResolvedValue({ replyTo: null }) }));
jest.mock('@/lib/appSettings', () => ({
    ...jest.requireActual('@/lib/appSettings'),
    orgToday: jest.fn().mockResolvedValue(new Date(Date.UTC(2026, 10, 25))),
}));
jest.mock('@/lib/membership/keyVolunteer', () => ({
    ...jest.requireActual('@/lib/membership/keyVolunteer'),
    getKeyVolunteerSelfStatus: jest.fn(),
}));
jest.mock('@/lib/household/joinQuestion', () => ({
    ...jest.requireActual('@/lib/household/joinQuestion'),
    householdQuestion: jest.fn(),
}));
// Every model method is a fresh jest.fn: findMany resolves [], count 0, anything else null.
jest.mock('@/lib/prisma', () => {
    const defaults: Record<string, unknown> = { findMany: [], count: 0 };
    const models = new Map<string, Record<string, jest.Mock>>();
    const model = (name: string) => {
        let methods = models.get(name);
        if (!methods) {
            const fns: Record<string, jest.Mock> = {};
            methods = new Proxy(fns, {
                get: (target, method) => {
                    if (typeof method !== 'string') return undefined;
                    target[method] ??= jest.fn().mockResolvedValue(defaults[method] ?? null);
                    return target[method];
                },
            });
            models.set(name, methods);
        }
        return methods;
    };
    const client: object = new Proxy({}, {
        get: (_target, prop) => {
            if (typeof prop !== 'string' || prop === 'then') return undefined;
            if (prop === '$transaction') {
                return (arg: unknown) => (typeof arg === 'function' ? arg(client) : Promise.all(arg as Promise<unknown>[]));
            }
            return model(prop);
        },
    });
    return { __esModule: true, default: client, resetModels: () => models.clear() };
});

const { resetModels } = jest.requireMock<{ resetModels: () => void }>('@/lib/prisma');

type Read = (req: NextRequest) => Promise<Response>;

const CALLER = 1, OTHER = 2, OWN_HH = 10, OTHER_HH = 20;
const member: Partial<AuthenticatedUser> = {
    id: CALLER, householdId: OWN_HH, isSysadmin: false, isBoardMember: false, isKeyholder: false,
    isBackgroundCheckReviewer: false, isFinance: false,
};

function signedInAs(user: Partial<AuthenticatedUser> | null) {
    jest.mocked(getServerSession).mockResolvedValue(user && { user, expires: '2099-01-01T00:00:00.000Z' });
}

const get = (read: Read, path: string) => read(new Request(`http://localhost${path}`) as unknown as NextRequest);

beforeEach(() => {
    jest.clearAllMocks();
    resetModels();
});

describe.each<[string, Read]>([
    ['/api/membership-audit/bg-attestations', bgAttestations],
    ['/api/membership/key-volunteer', keyVolunteer],
    ['/api/membership/reviews', reviews],
    ['/api/membership-ops/applications', applications],
    ['/api/household', household],
    ['/api/profile/household-question', householdQuestionRead],
    ['/api/profile', profile],
    ['/api/profile/visits', profileVisits],
    ['/api/trusted-adults/mine', trustedAdultsMine],
    ['/api/trusted-adults/operational', trustedAdultsOperational],
])('GET %s with no session', (path, read) => {
    it('is refused with 401', async () => {
        signedInAs(null);
        const res = await get(read, path);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });
});

describe('role-gated reads refuse a signed-in caller without the role', () => {
    const reviewer = { ...member, isBackgroundCheckReviewer: true };
    const sysadmin = { ...member, isSysadmin: true };
    const keyholder = { ...member, isKeyholder: true };
    const finance = { ...member, isFinance: true };

    it.each([
        ['a member', member], ['a keyholder', keyholder], ['finance', finance], ['a background-check reviewer', reviewer],
    ])('GET /api/membership-audit/bg-attestations refuses %s', async (_who, user) => {
        signedInAs(user);
        expect((await get(bgAttestations, '/api/membership-audit/bg-attestations')).status).toBe(403);
        expect(prisma.backgroundCheckAttestation.findMany).not.toHaveBeenCalled();
    });

    it.each([
        ['a member', member], ['a keyholder', keyholder], ['finance', finance], ['a sysadmin off the Board', sysadmin],
    ])('GET /api/membership/reviews refuses %s', async (_who, user) => {
        signedInAs(user);
        expect((await get(reviews, '/api/membership/reviews')).status).toBe(403);
        expect((await get(reviews, '/api/membership/reviews?mine=1')).status).toBe(403);
        expect(prisma.orgMembershipProcess.findMany).not.toHaveBeenCalled();
    });

    it.each([
        ['a member', member], ['a keyholder', keyholder], ['finance', finance], ['a background-check reviewer', reviewer],
    ])('GET /api/membership-ops/applications refuses %s', async (_who, user) => {
        signedInAs(user);
        expect((await get(applications, '/api/membership-ops/applications')).status).toBe(403);
        expect((await get(applications, '/api/membership-ops/applications?archived=1')).status).toBe(403);
        expect(prisma.orgMembershipProcess.findMany).not.toHaveBeenCalled();
    });

    it('GET /api/trusted-adults/mine refuses a caller in no household', async () => {
        signedInAs({ ...member, householdId: undefined });
        expect((await get(trustedAdultsMine, '/api/trusted-adults/mine')).status).toBe(403);
        expect(prisma.trustedAdult.findMany).not.toHaveBeenCalled();
    });
});

describe('caller-scoped reads ignore a request naming someone else', () => {
    it('GET /api/membership/key-volunteer reads only the caller', async () => {
        signedInAs(member);
        jest.mocked(getKeyVolunteerSelfStatus).mockResolvedValue({
            personId: CALLER, owesSignature: false, agreementVersion: 1, requestStarted: false, documentConfigured: true,
        });
        expect((await get(keyVolunteer, `/api/membership/key-volunteer?personId=${OTHER}`)).status).toBe(200);
        expect(jest.mocked(getKeyVolunteerSelfStatus).mock.calls).toEqual([[CALLER]]);
    });

    it('GET /api/profile/household-question asks only about the caller', async () => {
        signedInAs(member);
        jest.mocked(householdQuestion).mockResolvedValue(null);
        expect((await get(householdQuestionRead, `/api/profile/household-question?personId=${OTHER}`)).status).toBe(200);
        expect(jest.mocked(householdQuestion).mock.calls).toEqual([[CALLER]]);
    });

    it('GET /api/profile returns the caller, not the person named', async () => {
        signedInAs(member);
        const people: Record<number, { id: number; name: string; visits: never[] }> = {
            [CALLER]: { id: CALLER, name: 'Caller Person', visits: [] },
            [OTHER]: { id: OTHER, name: 'Other Person', visits: [] },
        };
        (prisma.person.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id: number } }) => Promise.resolve(people[where.id] ?? null));
        const res = await get(profile, `/api/profile?id=${OTHER}&personId=${OTHER}`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(await res.json())).not.toContain('Other Person');
        for (const [args] of (prisma.person.findUnique as jest.Mock).mock.calls) expect(args.where).toEqual({ id: CALLER });
    });

    it("GET /api/profile/visits returns only the caller's visits", async () => {
        signedInAs(member);
        const at = new Date();
        const visits = [
            { id: 101, personId: CALLER, arrivedAt: at, departedAt: null, event: null },
            { id: 202, personId: OTHER, arrivedAt: at, departedAt: null, event: { name: 'Other Person Event' } },
        ];
        (prisma.visit.findMany as jest.Mock).mockImplementation(({ where }: { where: { personId?: number } }) =>
            Promise.resolve(visits.filter((v) => where.personId === undefined || v.personId === where.personId)));
        const res = await get(profileVisits, `/api/profile/visits?personId=${OTHER}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(JSON.stringify(body)).not.toContain('Other Person Event');
        expect(body.visits.map((v: { id: number }) => v.id)).toEqual([101]);
        expect((prisma.visit.findMany as jest.Mock).mock.calls.at(-1)?.[0].where.personId).toBe(CALLER);
    });

    it("GET /api/household returns the caller's household, not the one named", async () => {
        signedInAs(member);
        const households: Record<number, { id: number; name: string; householdMembers: never[]; orgMembership: null }> = {
            [CALLER]: { id: OWN_HH, name: 'Own Household', householdMembers: [], orgMembership: null },
            [OTHER]: { id: OTHER_HH, name: 'Other Household', householdMembers: [], orgMembership: null },
        };
        (prisma.person.findUnique as jest.Mock).mockImplementation(({ where, select }: { where: { id: number }; select: { household?: unknown } }) =>
            Promise.resolve(select.household
                ? { household: households[where.id] ?? null }
                : { householdId: OWN_HH, isHouseholdLead: false, isSysadmin: false }));
        const res = await get(household, `/api/household?householdId=${OTHER_HH}&id=${OTHER}`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(await res.json())).not.toContain('Other Household');
        for (const [args] of (prisma.person.findUnique as jest.Mock).mock.calls) expect(args.where).toEqual({ id: CALLER });
    });

    it("GET /api/trusted-adults/mine returns only the caller's household", async () => {
        signedInAs(member);
        const rows = [
            { id: 1, householdId: OWN_HH, trustedAdultName: 'Own Grandma', reviews: [] },
            { id: 2, householdId: OTHER_HH, trustedAdultName: 'Other Grandpa', reviews: [] },
        ];
        (prisma.trustedAdult.findMany as jest.Mock).mockImplementation(({ where }: { where: { householdId?: number } }) =>
            Promise.resolve(rows.filter((r) => where.householdId === undefined || r.householdId === where.householdId)));
        const res = await get(trustedAdultsMine, `/api/trusted-adults/mine?householdId=${OTHER_HH}`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(await res.json())).not.toContain('Other Grandpa');
        expect((prisma.trustedAdult.findMany as jest.Mock).mock.calls[0][0].where.householdId).toBe(OWN_HH);
    });

    it('GET /api/trusted-adults/operational gives a member who leads no program nothing', async () => {
        signedInAs(member);
        const res = await get(trustedAdultsOperational, '/api/trusted-adults/operational');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ trustedAdults: [] });
        expect(prisma.trustedAdult.findMany).not.toHaveBeenCalled();
    });
});
