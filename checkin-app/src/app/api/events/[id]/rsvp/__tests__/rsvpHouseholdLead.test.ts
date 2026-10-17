/**
 * @jest-environment node
 *
 * Security boundary for the household-lead RSVP feature: a lead may RSVP for a
 * member of their household; a non-lead may not RSVP for anyone but themselves.
 * The guard is `canActFor` in @/lib/household/activityMembers.
 */

import { PATCH } from '@/app/api/events/[id]/rsvp/route';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const mockParticipantFindMany = jest.fn();
const mockEventFindUnique = jest.fn();
const mockRsvpUpsert = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: { findMany: (...a: unknown[]) => mockParticipantFindMany(...a) },
        event: { findUnique: (...a: unknown[]) => mockEventFindUnique(...a) },
        programParticipant: { findUnique: jest.fn() },
        programVolunteer: { findUnique: jest.fn() },
        rSVP: { upsert: (...a: unknown[]) => mockRsvpUpsert(...a) },
    },
}));

const params = Promise.resolve({ id: '5' });
const body = (b: object) => new Request('http://localhost/api/events/5/rsvp', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}) as unknown as import("next/server").NextRequest;

beforeEach(() => {
    jest.clearAllMocks();
    // Program-less event in the future → enrollment check is skipped.
    mockEventFindUnique.mockResolvedValue({ id: 5, programId: null, endAt: new Date(Date.now() + 3600_000) });
    mockRsvpUpsert.mockResolvedValue({ eventId: 5, personId: 2, status: 'ATTENDING' });
});

it('lets a household lead RSVP for a member of their household', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, householdId: 10, householdLead: true } });
    mockParticipantFindMany.mockResolvedValue([{ id: 1, name: 'Lead' }, { id: 2, name: 'Kid' }]);

    const res = await PATCH(body({ status: 'ATTENDING', participantId: 2 }), { params });

    expect(res.status).toBe(200);
    expect(mockRsvpUpsert).toHaveBeenCalledTimes(1);
    expect(mockRsvpUpsert.mock.calls[0][0].create.personId).toBe(2);
});

it('forbids a non-lead from RSVPing for someone else', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, householdId: 10, householdLead: false } });

    const res = await PATCH(body({ status: 'ATTENDING', participantId: 2 }), { params });

    expect(res.status).toBe(403);
    expect(mockRsvpUpsert).not.toHaveBeenCalled();
});

it("lets a program's lead mentor RSVP to that program's event", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 7 } });
    // Neither enrolled nor a listed volunteer — the lead-mentor tie is the only one.
    mockEventFindUnique.mockResolvedValue({
        id: 5, programId: 3, endAt: new Date(Date.now() + 3600_000), program: { id: 3, leadMentorId: 7 },
    });

    const res = await PATCH(body({ status: 'ATTENDING' }), { params });

    expect(res.status).toBe(200);
    expect(mockRsvpUpsert.mock.calls[0][0].create.personId).toBe(7);
});

it('forbids RSVPing to a program event with no tie to the program', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 7 } });
    mockEventFindUnique.mockResolvedValue({
        id: 5, programId: 3, endAt: new Date(Date.now() + 3600_000), program: { id: 3, leadMentorId: 99 },
    });

    const res = await PATCH(body({ status: 'ATTENDING' }), { params });

    expect(res.status).toBe(403);
    expect(mockRsvpUpsert).not.toHaveBeenCalled();
});

it('forbids a lead from RSVPing for someone outside their household', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, householdId: 10, householdLead: true } });
    mockParticipantFindMany.mockResolvedValue([{ id: 1, name: 'Lead' }, { id: 2, name: 'Kid' }]);

    const res = await PATCH(body({ status: 'ATTENDING', participantId: 99 }), { params });

    expect(res.status).toBe(403);
    expect(mockRsvpUpsert).not.toHaveBeenCalled();
});
