/**
 * @jest-environment node
 */
/**
 * Route contract for GET/POST /api/membership/check-started: any signed-in caller is
 * admitted, the service's rows ship through the registry's view, and a row carries
 * personId, name and a two-valued state only — never a clearance date or review
 * state, even if the service handed one over. ExternalError codes map to HTTP.
 */
import { GET, POST } from '../route';
import { getServerSession } from 'next-auth/next';
import { checkStartedRows, markCheckStarted, type CheckStartedRow } from '@/lib/membership/checkStarted';
import { householdLeadship } from '@/lib/household/leads';
import { ExternalError } from '@/lib/membership/external';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/membership/checkStarted', () => ({ checkStartedRows: jest.fn(), markCheckStarted: jest.fn() }));
jest.mock('@/lib/household/leads', () => ({ ...jest.requireActual('@/lib/household/leads'), householdLeadship: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { person: { findMany: jest.fn().mockResolvedValue([{ id: 7 }, { id: 8 }]) } },
}));

const URL_ = 'http://localhost:4000/api/membership/check-started';
const req = (init?: RequestInit) => new Request(URL_, init) as unknown as Parameters<typeof GET>[0];
const get = () => GET(req());
const post = (body: unknown) => POST(req({ method: 'POST', body: JSON.stringify(body) }));

function signedIn(lead: boolean) {
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: 7, householdId: 3, isHouseholdLead: lead } });
    jest.mocked(householdLeadship).mockResolvedValue(lead ? { householdId: 3, canManage: true } : null);
}

// Extra fields stand in for a service that leaked detail; the view must strip them.
const serviceRows: (CheckStartedRow & Record<string, unknown>)[] = [
    { personId: 7, name: 'Me', state: 'NEEDS_MARKING', clearedAt: '2026-01-01', reviewStatus: 'BLOCKED' },
    { personId: 8, name: 'Adult Child', state: 'NOTHING_TO_DO', clearedAt: '2026-01-01', reviewStatus: 'BLOCKED' },
];

beforeEach(() => {
    jest.mocked(checkStartedRows).mockReset().mockResolvedValue(serviceRows);
    jest.mocked(markCheckStarted).mockReset().mockResolvedValue({ processId: 1 });
});

describe('GET /api/membership/check-started', () => {
    it('401s a caller with no session', async () => {
        jest.mocked(getServerSession).mockResolvedValue(null);
        expect((await get()).status).toBe(401);
        expect(checkStartedRows).not.toHaveBeenCalled();
    });

    it("gives a lead each row's personId, name and state, and nothing else", async () => {
        signedIn(true);
        const res = await get();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            rows: [
                { personId: 7, name: 'Me', state: 'NEEDS_MARKING' },
                { personId: 8, name: 'Adult Child', state: 'NOTHING_TO_DO' },
            ],
        });
        expect(checkStartedRows).toHaveBeenCalledWith(7);
    });

    it("keeps a non-lead's view of anyone else's row to personId and name", async () => {
        signedIn(false);
        const { rows } = await (await get()).json();
        expect(rows).toEqual([{ personId: 7, name: 'Me', state: 'NEEDS_MARKING' }, { personId: 8, name: 'Adult Child' }]);
    });
});

describe('POST /api/membership/check-started', () => {
    it('marks the named person as the caller and returns the refreshed rows', async () => {
        signedIn(true);
        const res = await post({ personId: 8 });
        expect(res.status).toBe(200);
        expect(markCheckStarted).toHaveBeenCalledWith(8, 7);
        expect((await res.json()).rows).toHaveLength(2);
    });

    it('400s a missing or junk personId', async () => {
        signedIn(true);
        expect((await post({})).status).toBe(400);
        expect((await post({ personId: 'x' })).status).toBe(400);
        expect(markCheckStarted).not.toHaveBeenCalled();
    });

    it.each([
        ['not_lead', 403],
        ['wrong_phase', 409],
        ['not_found', 404],
    ] as const)('maps ExternalError %s to %i', async (code, status) => {
        signedIn(true);
        jest.mocked(markCheckStarted).mockRejectedValue(new ExternalError(code, 'refused'));
        const res = await post({ personId: 8 });
        expect(res.status).toBe(status);
        expect((await res.json()).error).toBe('refused');
    });
});
