/**
 * @jest-environment node
 */
/**
 * GET /api/safety/emergency-contacts serves contact pii to the front desk, so the
 * query selects only the household, member and contact columns the sheet shows.
 */
import { GET } from '../route';

const findMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { household: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
jest.mock('@/lib/auth', () => ({
    withAuth: (_options: unknown, handler: (req: Request) => Promise<Response>) => (req: Request) => handler(req),
}));

const req = () => new Request('http://localhost/api/safety/emergency-contacts');

beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([
        {
            id: 9,
            name: 'Doe',
            householdMembers: [
                { id: 2, name: 'Lead', email: 'lead@example.com', phone: '555', isHouseholdLead: true, visits: [{ id: 1 }] },
            ],
            emergencyContacts: [
                { id: 4, name: 'Aunt', phone: '556', email: null, relationship: 'aunt', conflictParticipantId: null },
            ],
        },
    ]);
});

it('selects only the household, member and contact columns the sheet shows', async () => {
    expect((await GET(req())).status).toBe(200);

    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('include');
    const { select } = args;
    expect(Object.keys(select).sort()).toEqual(['emergencyContacts', 'householdMembers', 'id', 'name']);
    expect(Object.keys(select.householdMembers.select).sort()).toEqual(['email', 'id', 'isHouseholdLead', 'name', 'phone', 'visits']);
    expect(Object.keys(select.emergencyContacts.select).sort()).toEqual(['conflictParticipantId', 'email', 'id', 'name', 'phone', 'relationship']);
});

it('ships each household with the fields the sheet reads', async () => {
    const body = await (await GET(req())).json();

    expect(body.households[0]).toEqual({
        id: 9,
        name: 'Doe',
        emergencyContactName: 'Aunt',
        emergencyContactPhone: '556',
        emergencyContacts: [{ id: 4, name: 'Aunt', phone: '556', email: null, relationship: 'aunt', invalid: false }],
        isPresent: true,
        householdMembers: [{ id: 2, name: 'Lead', isPresent: true }],
        leads: [{ id: 2, name: 'Lead', phone: '555', email: 'lead@example.com' }],
    });
});
