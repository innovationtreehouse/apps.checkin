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
    let orgMembershipId: number;
    let refusedActorId: number;
    let actorId: number;

    const application = () =>
        prisma.orgMembershipProcess.create({ data: { orgMembershipId, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION' } });
    const envelopeAudits = (processId: number) =>
        prisma.auditLog.findMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId } });

    beforeAll(async () => {
        const hh = await prisma.household.create({ data: { name: `HH ${TAG}` } });
        householdId = hh.id;
        orgMembershipId = (await prisma.orgMembership.create({ data: { householdId, status: 'NONE' } })).id;
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
        const processes = await prisma.orgMembershipProcess.findMany({ where: { orgMembershipId }, select: { id: true } });
        await prisma.auditLog.deleteMany({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: { in: processes.map((p) => p.id) } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembershipId } });
        await prisma.orgMembership.delete({ where: { id: orgMembershipId } });
        await prisma.person.deleteMany({ where: { householdId } });
        await prisma.household.delete({ where: { id: householdId } });
    });

    it('a refused audit row rolls the envelope back', async () => {
        const { id } = await application();
        await expect(setZohoEnvelope(id, 'REQ-REFUSED', refusedActorId)).rejects.toThrow(/audit write refused/);
        const after = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id } });
        expect(after.zohoEnvelopeId).toBeNull();
        expect(await envelopeAudits(id)).toHaveLength(0);
    });

    it('the normal path writes the envelope and its audit row', async () => {
        const { id } = await application();
        const updated = await setZohoEnvelope(id, 'REQ-OK', actorId);
        expect(updated.zohoEnvelopeId).toBe('REQ-OK');
        const audits = await envelopeAudits(id);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ actorId, actorSystem: null, newData: { zohoEnvelopeId: 'REQ-OK', zohoActionId: null, zohoSignerPersonId: null } });
    });
});
