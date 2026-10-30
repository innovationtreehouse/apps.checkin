/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import prisma from '@/lib/prisma';

/**
 * The Key Volunteer grandfathering migration. Runs the migration's OWN statement
 * (extracted between its markers) and asserts:
 *   - a live holder of a gated role gets KEY_VOLUNTEER and an agreement signed at
 *     version 1, with no Zoho request, each audited under the migration's name
 *   - a person already holding KEY_VOLUNTEER, a merge tombstone, and a person
 *     holding only an ungated role are left alone
 *   - a second run changes nothing
 */

const MIGRATION_SQL = path.join(
    __dirname,
    '../../../prisma/migrations/20261102120000_key_volunteer_grandfather/migration.sql',
);
const ACTOR = 'migration:key-volunteer-grandfather';

function grandfatherStatement(): string {
    const raw = fs.readFileSync(MIGRATION_SQL, 'utf8');
    const afterStart = raw.split('-- >>> GRANDFATHER START')[1];
    return afterStart
        .slice(afterStart.indexOf('\n') + 1)
        .split('-- <<< GRANDFATHER END')[0]
        .trim()
        .replace(/;$/, '');
}

const TAG = 'kv-grandfather-test';

describe('Key Volunteer grandfathering migration', () => {
    let householdId: number;
    let boardId: number;
    let alreadyKvId: number;
    let tombstoneId: number;
    let opsOnlyId: number;
    let startedAt: Date;

    beforeAll(async () => {
        const household = await prisma.household.create({ data: { name: `${TAG} household` } });
        householdId = household.id;
        const person = (name: string, extra: { mergedIntoId?: number } = {}) =>
            prisma.person.create({ data: { name, email: `${name}-${TAG}@example.com`, householdId, ...extra } });

        boardId = (await person('board')).id;
        alreadyKvId = (await person('already-kv')).id;
        opsOnlyId = (await person('ops-only')).id;
        tombstoneId = (await person('tombstone', { mergedIntoId: boardId })).id;

        await prisma.personRole.createMany({
            data: [
                { personId: boardId, role: 'BOARD' },
                { personId: boardId, role: 'FINANCE' },
                { personId: alreadyKvId, role: 'KEYHOLDER' },
                { personId: alreadyKvId, role: 'KEY_VOLUNTEER' },
                { personId: opsOnlyId, role: 'OPERATIONS' },
                { personId: tombstoneId, role: 'BG_REVIEWER' },
            ],
        });

        startedAt = new Date();
        await prisma.$executeRawUnsafe(grandfatherStatement());
    });

    afterAll(async () => {
        // The statement covers every role holder in the database, so undo all it wrote.
        const written = await prisma.auditLog.findMany({
            where: { actorSystem: ACTOR, timestamp: { gte: startedAt } },
            select: { id: true, tableName: true, affectedEntityId: true },
        });
        const processIds = written.filter((a) => a.tableName === 'OrgMembershipProcess').map((a) => a.affectedEntityId);
        const rolePersonIds = written.filter((a) => a.tableName === 'PersonRole').map((a) => a.affectedEntityId);
        await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processIds } } });
        await prisma.personRole.deleteMany({ where: { personId: { in: rolePersonIds }, role: 'KEY_VOLUNTEER' } });
        await prisma.auditLog.deleteMany({ where: { id: { in: written.map((a) => a.id) } } });
        const ours = [boardId, alreadyKvId, opsOnlyId, tombstoneId];
        await prisma.orgMembershipProcess.deleteMany({ where: { subjectPersonId: { in: ours } } });
        await prisma.personRole.deleteMany({ where: { personId: { in: ours } } });
        await prisma.person.deleteMany({ where: { id: tombstoneId } });
        await prisma.person.deleteMany({ where: { id: { in: [boardId, alreadyKvId, opsOnlyId] } } });
        await prisma.household.deleteMany({ where: { id: householdId } });
    });

    it('makes a live gated-role holder a Key Volunteer signed at version 1', async () => {
        const role = await prisma.personRole.findUnique({ where: { personId_role: { personId: boardId, role: 'KEY_VOLUNTEER' } } });
        expect(role).not.toBeNull();
        expect(role?.grantedById).toBeNull();

        const processes = await prisma.orgMembershipProcess.findMany({ where: { subjectPersonId: boardId } });
        expect(processes).toHaveLength(1);
        expect(processes[0]).toMatchObject({
            kind: 'KEY_VOLUNTEER_AGREEMENT',
            status: 'ACTIVE',
            agreementVersion: 1,
            orgMembershipId: null,
            zohoEnvelopeId: null,
            zohoActionId: null,
            zohoSignerPersonId: null,
        });
        expect(processes[0].contractSignedAt).not.toBeNull();

        const audits = await prisma.auditLog.findMany({ where: { actorSystem: ACTOR, timestamp: { gte: startedAt } } });
        expect(audits.filter((a) => a.tableName === 'PersonRole' && a.affectedEntityId === boardId)).toHaveLength(1);
        expect(audits.filter((a) => a.tableName === 'OrgMembershipProcess' && a.affectedEntityId === processes[0].id)).toHaveLength(1);
        expect(audits.every((a) => a.actorId === 0)).toBe(true);
    });

    it('leaves an existing Key Volunteer, a tombstone and an ungated holder alone', async () => {
        for (const personId of [alreadyKvId, tombstoneId, opsOnlyId]) {
            expect(await prisma.orgMembershipProcess.count({ where: { subjectPersonId: personId } })).toBe(0);
        }
        expect(await prisma.personRole.count({ where: { personId: { in: [tombstoneId, opsOnlyId] }, role: 'KEY_VOLUNTEER' } })).toBe(0);
    });

    it('changes nothing on a second run', async () => {
        expect(await prisma.$executeRawUnsafe(grandfatherStatement())).toBe(0);
        expect(await prisma.orgMembershipProcess.count({ where: { subjectPersonId: boardId } })).toBe(1);
    });
});
