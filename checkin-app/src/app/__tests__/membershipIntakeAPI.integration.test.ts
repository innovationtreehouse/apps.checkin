/**
 * @jest-environment node
 */
/**
 * Integration tests for the membership intake flow:
 *   GET/POST /api/membership, PATCH /api/membership/intake, POST .../submit
 */

import { GET, POST } from '@/app/api/membership/route';
import { PATCH } from '@/app/api/membership/intake/route';
import { POST as SUBMIT } from '@/app/api/membership/intake/submit/route';
import { createRenewalProcess, beginRenewal } from '@/lib/membership/renewal';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { expectAuditRow, auditJson } from '@/test-helpers/expectAuditRow';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
// beginRenewal -> notifyReviewers sends email when re-review is needed; mock it out.
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'membership-intake-test';

function asUser(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false } });
}
function req(body?: unknown) {
    return new Request('http://localhost:4000/api/membership', {
        method: 'POST',
        ...(body ? { body: JSON.stringify(body) } : {}),
    }) as unknown as Parameters<typeof POST>[0];
}

describe('Membership Intake API', () => {
    let leadId: number;
    let leadHouseholdId: number;
    let nonLeadId: number;
    let activeLeadId: number;

    async function wipe() {
        const tagged = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { householdId: true } });
        const hhIds = tagged.map((u) => u.householdId).filter((x): x is number => x !== null);
        if (hhIds.length === 0) return;
        // Include participants created mid-flow (children/second parents lack the TAG email).
        const inHh = await prisma.person.findMany({ where: { householdId: { in: hhIds } }, select: { id: true } });
        const allIds = inHh.map((p) => p.id);
        await prisma.backgroundCheckAttestation.deleteMany({ where: { process: { orgMembership: { householdId: { in: hhIds } } } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: hhIds } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: hhIds } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: allIds } } });
        await prisma.person.deleteMany({ where: { householdId: { in: hhIds } } });
        await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
    }

    beforeAll(async () => {
        await wipe();

        const lead = await prisma.person.create({
            data: { email: `lead-${TAG}@example.com`, name: 'Lead Parent', household: { create: { name: 'Intake Flow HH' } } },
        });
        leadId = lead.id;
        leadHouseholdId = lead.householdId!;
        await prisma.person.update({ where: { id: leadId }, data: { isHouseholdLead: true } });

        const nonLead = await prisma.person.create({
            data: { email: `nonlead-${TAG}@example.com`, name: 'Non Lead', householdId: leadHouseholdId },
        });
        nonLeadId = nonLead.id;

        const activeLead = await prisma.person.create({
            data: {
                email: `active-${TAG}@example.com`,
                name: 'Active Lead',
                household: { create: { name: 'Active Flow HH', orgMembership: { create: { status: 'ACTIVE' } } } },
            },
        });
        activeLeadId = activeLead.id;
        await prisma.person.update({ where: { id: activeLeadId }, data: { isHouseholdLead: true } });
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it('GET reports a household with no in-flight process', async () => {
        asUser(leadId);
        const res = await GET(req() as never);
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.hasHousehold).toBe(true);
        expect(data.process).toBeNull();
    });

    it('POST starts an INITIAL process at INTAKE and anchors a NONE membership', async () => {
        asUser(leadId);
        const res = await POST(req() as never);
        const data = await res.json();
        expect(res.status).toBe(201);
        expect(data.state.process.status).toBe('INTAKE');
        expect(data.state.process.kind).toBe('INITIAL');
        expect(data.state.membershipStatus).toBe('NONE');

        const membership = await prisma.orgMembership.findUnique({ where: { householdId: leadHouseholdId } });
        expect(membership?.status).toBe('NONE');
    });

    it('POST is idempotent — resumes the existing in-flight process', async () => {
        asUser(leadId);
        const first = await (await POST(req() as never)).json();
        const second = await (await POST(req() as never)).json();
        expect(second.state.process.id).toBe(first.state.process.id);
        const count = await prisma.orgMembershipProcess.count({ where: { orgMembership: { householdId: leadHouseholdId } } });
        expect(count).toBe(1);
    });

    it('rejects submit while required fields are missing', async () => {
        asUser(leadId);
        const res = await SUBMIT(req() as never);
        const data = await res.json();
        expect(res.status).toBe(400);
        expect(data.code).toBe('incomplete');
        // Still at INTAKE.
        const state = await (await GET(req() as never)).json();
        expect(state.process.status).toBe('INTAKE');
    });

    it('PATCH saves household + parent + a child, and GET reflects it', async () => {
        asUser(leadId);
        const patchReq = new Request('http://localhost:4000/api/membership/intake', {
            method: 'PATCH',
            body: JSON.stringify({
                household: { line1: '1 Treehouse Way', city: 'Austin', state: 'TX', postalCode: '78701', emergencyContactName: 'Aunt May', emergencyContactPhone: '555-555-0100' },
                primaryParent: { name: 'Lead Parent', dob: '1985-04-01', allergies: 'peanuts' },
                children: [{ name: 'Kid One', dob: '2015-06-01' }],
            }),
        });
        const res = await PATCH(patchReq as never);
        expect(res.status).toBe(200);

        const state = await (await GET(req() as never)).json();
        expect(state.prefill.household.line1).toBe('1 Treehouse Way');
        expect(state.prefill.primaryParent.allergies).toBe('peanuts');
        // Children are non-lead members; the household already has the non-lead
        // fixture, so assert Kid One is among them rather than an exact count.
        expect(state.prefill.children.some((c: { name: string }) => c.name === 'Kid One')).toBe(true);

        // Kid One was created as a non-lead (child).
        const kid = await prisma.person.findFirst({ where: { householdId: leadHouseholdId, name: 'Kid One' } });
        expect(kid).not.toBeNull();
        const kidLead = await prisma.person.findFirst({ where: { id: kid!.id, householdId: leadHouseholdId, isHouseholdLead: true }, select: { id: true } });
        expect(kidLead).toBeNull();
    });

    it('POST submit advances INTAKE -> EXTERNAL once required fields are present', async () => {
        asUser(leadId);
        const res = await SUBMIT(req() as never);
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.state.process.status).toBe('PENDING_EXTERNAL_ACTION');
        // Membership is still NONE — not active until paid.
        expect(data.state.membershipStatus).toBe('NONE');
    });

    it('rejects a non-lead member trying to save intake', async () => {
        asUser(nonLeadId);
        const patchReq = new Request('http://localhost:4000/api/membership/intake', {
            method: 'PATCH',
            body: JSON.stringify({ household: { line1: 'hacker lane' } }),
        });
        const res = await PATCH(patchReq as never);
        expect(res.status).toBe(403);
    });

    it('rejects starting an application for an already-active household', async () => {
        asUser(activeLeadId);
        const res = await POST(req() as never);
        const data = await res.json();
        expect(res.status).toBe(409);
        expect(data.code).toBe('already_member');
    });

    it('intake start writes a CREATE audit and submit an EDIT audit, both bound to the lead', async () => {
        const lead = await prisma.person.create({
            data: { email: `audit-lead-${TAG}@example.com`, name: 'Audit Lead', household: { create: { name: 'Audit Intake HH' } } },
        });
        await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
        asUser(lead.id);

        const startRes = await POST(req() as never);
        expect(startRes.status).toBe(201);
        const processId = (await startRes.json()).state.process.id;

        const createLog = await expectAuditRow(prisma, { action: 'CREATE', tableName: 'OrgMembershipProcess', affectedEntityId: processId });
        expect(createLog.actorId).toBe(lead.id);
        expect(auditJson(createLog.newData).status).toBe('INTAKE');

        // Fill the minimum required fields so submit advances INTAKE -> EXTERNAL.
        const patch = new Request('http://localhost:4000/api/membership/intake', {
            method: 'PATCH',
            body: JSON.stringify({
                household: { line1: '9 Audit Way', city: 'Austin', state: 'TX', postalCode: '78701', emergencyContactName: 'Aunt Audit', emergencyContactPhone: '555-555-9001' },
                primaryParent: { name: 'Audit Lead' },
            }),
        });
        expect((await PATCH(patch as never)).status).toBe(200);

        const submitRes = await SUBMIT(req() as never);
        expect(submitRes.status).toBe(200);
        const editLog = await expectAuditRow(prisma, { action: 'EDIT', tableName: 'OrgMembershipProcess', affectedEntityId: processId });
        expect(editLog.actorId).toBe(lead.id);
        expect(auditJson(editLog.oldData).status).toBe('INTAKE');
        expect(auditJson(editLog.newData).status).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('createRenewalProcess writes a SYSTEM_ACTOR CREATE; beginRenewal a person-actor EDIT', async () => {
        const owner = await prisma.person.create({
            data: {
                email: `renew-lead-${TAG}@example.com`, name: 'Renew Lead',
                household: { create: { name: 'Renew HH', orgMembership: { create: { status: 'ACTIVE' } } } },
            },
        });
        const householdId = owner.householdId!;
        const membership = await prisma.orgMembership.findUniqueOrThrow({ where: { householdId } });

        const proc = await createRenewalProcess(membership.id);
        expect(proc).not.toBeNull();

        const createLog = await expectAuditRow(prisma, { action: 'CREATE', tableName: 'OrgMembershipProcess', affectedEntityId: proc!.id });
        expect(createLog.actorId).toBe(0); // SYSTEM_ACTOR — cron, not a person
        expect(auditJson(createLog.newData).status).toBe('PENDING_RENEWAL');

        const begun = await beginRenewal(proc!.id, owner.id);
        expect(begun.status).not.toBe('PENDING_RENEWAL');
        const editLog = await expectAuditRow(prisma, { action: 'EDIT', tableName: 'OrgMembershipProcess', affectedEntityId: proc!.id });
        expect(editLog.actorId).toBe(owner.id);
        expect(auditJson(editLog.oldData).status).toBe('PENDING_RENEWAL');
    });
});
