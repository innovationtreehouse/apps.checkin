/**
 * @jest-environment node
 */
/**
 * Unit tests for POST /api/membership-audit/person-agreement — the deny paths
 * (401 anon / 403 plain member, through the REAL withAuth with a mocked session) and the
 * two refusals the board needs to see a reason for. A denied caller must never reach the
 * service: opening an agreement writes an obligation against a named person.
 */
import type { NextRequest } from 'next/server';
import { POST } from '../route';
import { PersonAgreementError } from '@/lib/membership/personAgreementTriggers';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const openMock = jest.fn();
jest.mock('@/lib/membership/personAgreementTriggers', () => {
    class PersonAgreementError extends Error {
        constructor(public readonly code: string, message: string) {
            super(message);
            this.name = 'PersonAgreementError';
        }
    }
    return {
        PersonAgreementError,
        openPersonAgreementForBoard: (...args: unknown[]) => openMock(...args),
    };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

// A plain Request cast to NextRequest — next/server's class isn't constructible under
// jest, and handler() only ever reads url + json() off it.
function req(body: unknown = { personId: 7 }) {
    return new Request('http://localhost/api/membership-audit/person-agreement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as NextRequest;
}

const board = { user: { id: 3, isSysadmin: false, isBoardMember: true } };

beforeEach(() => {
    jest.clearAllMocks();
    openMock.mockResolvedValue({ id: 42, kind: 'PERSON_AGREEMENT' });
});

describe('POST /api/membership-audit/person-agreement', () => {
    it('401 when unauthenticated, without opening anything', async () => {
        mockSession.mockResolvedValue(null);
        const res = await POST(req());
        expect(res.status).toBe(401);
        expect(openMock).not.toHaveBeenCalled();
    });

    it('403 for a signed-in member with no board or sysadmin role, without opening anything', async () => {
        mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: false, isBoardMember: false } });
        const res = await POST(req());
        expect(res.status).toBe(403);
        expect(openMock).not.toHaveBeenCalled();
    });

    it('400 without a personId', async () => {
        mockSession.mockResolvedValue(board);
        const res = await POST(req({}));
        expect(res.status).toBe(400);
        expect(openMock).not.toHaveBeenCalled();
    });

    it('opens for a board member, crediting them as the actor', async () => {
        mockSession.mockResolvedValue(board);
        const res = await POST(req());
        expect(res.status).toBe(200);
        expect(openMock).toHaveBeenCalledWith(7, 3);
    });

    // The registry grant is internal+public and the route selects three fields, so
    // nothing identifying the subject can ride back out on the confirmation.
    it('echoes only the obligation — no subjectPersonId, no Zoho ids', async () => {
        mockSession.mockResolvedValue(board);
        openMock.mockResolvedValue({
            id: 42, kind: 'PERSON_AGREEMENT', status: 'PENDING_EXTERNAL_ACTION',
            subjectPersonId: 7, zohoEnvelopeId: 'req-secret', zohoActionId: 'act-secret',
        });

        const body = await (await POST(req())).json();

        expect(body.process).toEqual({ id: 42, kind: 'PERSON_AGREEMENT', status: 'PENDING_EXTERNAL_ACTION' });
    });

    it('409 with the reason when the subject is a household lead', async () => {
        mockSession.mockResolvedValue(board);
        openMock.mockRejectedValue(new PersonAgreementError('is_lead', 'A household lead signs the household agreement, not an individual one.'));
        const res = await POST(req());
        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('household lead') });
    });

    it('409 with the reason when the age is unknown', async () => {
        mockSession.mockResolvedValue(board);
        openMock.mockRejectedValue(new PersonAgreementError('age_unknown', "Record this person's date of birth (or mark them over 25) first."));
        const res = await POST(req());
        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('date of birth') });
    });
});
