/**
 * @jest-environment node
 */
/**
 * Setting a signing envelope and its audit row commit together. A trigger makes
 * Postgres refuse audit rows by one actor, whichever client writes them, so that
 * actor's envelope change must roll back with the refused row.
 */
import { setZohoEnvelope } from '@/lib/membership/external';
import prisma from '@/lib/prisma';

const TAG = 'set-envelope-audit-test';

describe('setZohoEnvelope and its audit row', () => {
    let householdId: number;
    let refusedActorId: number;
    let actorId: number;

    // One household per application: a household has at most one in-flight INITIAL.
    const application = async (label: string) => {
        const hh = await prisma.household.create({ data: { name: `HH ${label} ${TAG}` } });
        const { id: orgMembershipId } = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        return prisma.orgMembershipProcess.create({ data: { orgMembershipId, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION' } });
    };
    const envelopeAudits = (processId: number) =>
        prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId } });

    beforeAll(async () => {
        householdId = (await prisma.household.create({ data: { name: `HH actors ${TAG}` } })).id;
        refusedActorId = (await prisma.person.create({ data: { email: `refused-${TAG}@example.com`, name: 'Refused Actor', householdId } })).id;
        actorId = (await prisma.person.create({ data: { email: `actor-${TAG}@example.com`, name: 'Board Actor', householdId } })).id;

        await prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION set_envelope_audit_refuse() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'audit write refused'; END
            $$ LANGUAGE plpgsql`);
        await prisma.$executeRawUnsafe(`
            CREATE TRIGGER set_envelope_audit_refuse BEFORE INSERT ON "AuditLog"
            FOR EACH ROW WHEN (NEW."actorId" = ${refusedActorId})
            EXECUTE FUNCTION set_envelope_audit_refuse()`);
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe('DROP TRIGGER set_envelope_audit_refuse ON "AuditLog"');
        await prisma.$executeRawUnsafe('DROP FUNCTION set_envelope_audit_refuse()');
        const ours = { orgMembership: { household: { name: { endsWith: TAG } } } };
        const processes = await prisma.orgMembershipProcess.findMany({ where: ours, select: { id: true } });
        await prisma.auditLog.deleteMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: { in: processes.map((p) => p.id) } } });
        await prisma.orgMembershipProcess.deleteMany({ where: ours });
        await prisma.orgMembership.deleteMany({ where: { household: { name: { endsWith: TAG } } } });
        await prisma.person.deleteMany({ where: { householdId } });
        await prisma.household.deleteMany({ where: { name: { endsWith: TAG } } });
    });

    it('a refused audit row rolls the envelope back', async () => {
        const { id } = await application('refused');
        await expect(setZohoEnvelope(id, 'REQ-REFUSED', refusedActorId)).rejects.toThrow(/audit write refused/);
        const after = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id } });
        expect(after.zohoEnvelopeId).toBeNull();
        expect(await envelopeAudits(id)).toHaveLength(0);
    });

    it('the normal path writes the envelope and its audit row', async () => {
        const { id } = await application('ok');
        const updated = await setZohoEnvelope(id, 'REQ-OK', actorId);
        expect(updated.zohoEnvelopeId).toBe('REQ-OK');
        const audits = await envelopeAudits(id);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ actorId, actorSystem: null, newData: { zohoEnvelopeId: 'REQ-OK', zohoActionId: null, zohoSignerPersonId: null } });
    });
});
