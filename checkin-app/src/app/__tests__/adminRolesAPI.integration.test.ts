/**
 * @jest-environment node
 */
/**
 * Integration Tests for Admin Roles API
 * Tests GET and PATCH /api/roles for fetching and updating user roles.
 *
 * The PATCH matrix (PR-1, roles foundation): board grants/revokes ALL five
 * flags (including isSysadmin and removing isBoardMember); a sysadmin-only
 * actor (not board) may grant any flag, including adding board, but may
 * never remove board membership (403); the last board member can never be
 * removed (409), guarded by a `SELECT ... FOR UPDATE` lock over the board
 * set inside a transaction. Board-actor tests below deliberately create
 * their OWN board-member fixtures (rather than one file-wide board actor)
 * so the last-board-guard describes can reason about the GLOBAL board count
 * precisely — the guard counts every Person with isBoardMember=true, not
 * just this file's fixtures.
 */
import { GET, PATCH } from '@/app/api/roles/route';
import prisma from '@/lib/prisma';
import { ROLE_FLAGS } from '@/lib/roles';
import { getServerSession } from 'next-auth/next';

/** Does this person hold OPERATIONS in the table? isOperations has no Person column. */
async function hasOperationsRow(personId: number): Promise<boolean> {
    const row = await prisma.personRole.findUnique({
        where: { personId_role: { personId, role: 'OPERATIONS' } },
    });
    return row !== null;
}

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'roles-api-test';

function patchReq(body: unknown) {
    return new Request('http://localhost:4000/api/roles', {
        method: 'PATCH',
        body: JSON.stringify(body),
    }) as unknown as import("next/server").NextRequest;
}

function getReq() {
    return new Request('http://localhost:4000/api/roles', { method: 'GET' }) as unknown as import("next/server").NextRequest;
}

function asSession(user: Record<string, unknown>) {
    (getServerSession as jest.Mock).mockResolvedValue({ user });
}

describe('Admin Roles API Integration Tests', () => {
    let testSysAdminId: number;
    let testUserId: number;
    let testTargetUserId: number;
    let testStudentId: number;

    async function wipeTagged() {
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: TAG } },
            select: { id: true },
        });
        const ids = existingUsers.map((u) => u.id);
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
    }

    beforeAll(async () => {
        await wipeTagged();

        const sysadmin = await prisma.person.create({
            data: { email: `sysadmin-${TAG}@example.com`, name: 'Admin Roles Test', isSysadmin: true, household: { create: { name: "Test HH" } } },
        });
        testSysAdminId = sysadmin.id;

        const user = await prisma.person.create({
            data: { email: `user-${TAG}@example.com`, name: 'User Roles Test', household: { create: { name: "Test HH" } } },
        });
        testUserId = user.id;

        const targetUser = await prisma.person.create({
            data: { email: `target-${TAG}@example.com`, name: 'Target Roles Test', dateOfBirth: new Date('1990-01-01'), household: { create: { name: "Test HH" } } },
        });
        testTargetUserId = targetUser.id;

        const now = new Date();
        const tenYearsAgo = new Date(now.getFullYear() - 10, now.getMonth(), now.getDate());
        const student = await prisma.person.create({
            data: { email: `student-${TAG}@example.com`, name: 'Student Roles Test', dateOfBirth: tenYearsAgo, household: { create: { name: "Test HH" } } },
        });
        testStudentId = student.id;
    });

    afterAll(async () => {
        await wipeTagged();
    });

    beforeEach(() => jest.clearAllMocks());

    describe('GET /api/roles', () => {
        it('should return 401 Unauthorized without session', async () => {
            (getServerSession as jest.Mock).mockResolvedValue(null);
            const res = await GET(getReq());
            expect(res.status).toBe(401);
        });

        it('should return 403 Forbidden for non-admin users', async () => {
            asSession({ id: testUserId });
            const res = await GET(getReq());
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toContain('Forbidden');
        });

        it('should return all participants (youth flagged, dob hidden) for a isSysadmin', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await GET(getReq());
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.people).toBeDefined();
            expect(Array.isArray(data.people)).toBe(true);

            const ids = data.people.map((p: { id?: number }) => p.id);
            expect(ids).toContain(testTargetUserId);
            expect(ids).toContain(testStudentId);
            const adult = data.people.find((p: { id?: number }) => p.id === testTargetUserId);
            const student = data.people.find((p: { id?: number }) => p.id === testStudentId);
            expect(adult.isYouth).toBe(false);
            expect(student.isYouth).toBe(true);
            expect(adult).not.toHaveProperty('dateOfBirth');
            expect(student).not.toHaveProperty('dateOfBirth');
            // isOperations now rides along with the other four flags.
            expect(adult).toHaveProperty('isOperations');
            // canAccessStaging is a plain column, not a ROLE_FLAGS/PersonRole-backed
            // flag, but GET still surfaces it alongside the five.
            expect(adult).toHaveProperty('canAccessStaging', false);
        });
    });

    describe('PATCH /api/roles — validation', () => {
        it('should return 401 Unauthorized without session', async () => {
            (getServerSession as jest.Mock).mockResolvedValue(null);
            const res = await PATCH(patchReq({ targetUserId: testTargetUserId, isBoardMember: true }));
            expect(res.status).toBe(401);
        });

        it('should return 403 Forbidden for non-admin users', async () => {
            asSession({ id: testUserId });
            const res = await PATCH(patchReq({ targetUserId: testTargetUserId, isBoardMember: true }));
            expect(res.status).toBe(403);
        });

        it('should return 400 Bad Request if targetUserId is missing', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ isBoardMember: true }));
            expect(res.status).toBe(400);
        });

        it('should return 400 for an unknown role flag', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: testTargetUserId, isWizard: true }));
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toContain('isWizard');
        });

        it('should return 400 when no valid role fields are provided', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: testTargetUserId }));
            expect(res.status).toBe(400);
        });

        it('should return 404 for a non-existent target', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: 999_999_999, isOperations: true }));
            expect(res.status).toBe(404);
        });

        it('self-edit: a sysadmin may not change their own flags -> 403, unchanged', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: testSysAdminId, isOperations: true }));
            expect(res.status).toBe(403);
            expect(await hasOperationsRow(testSysAdminId)).toBe(false);
        });

        it('self-save with no change is a no-op -> 200, no audit row', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const audits = await prisma.auditLog.count({ where: { affectedEntityId: testSysAdminId } });
            const res = await PATCH(patchReq({ targetUserId: testSysAdminId, isOperations: false, isKeyholder: false, canAccessStaging: false }));
            expect(res.status).toBe(200);
            expect(await prisma.auditLog.count({ where: { affectedEntityId: testSysAdminId } })).toBe(audits);
        });

        it('a session with no integer actor id is refused (fail closed) -> 401, no write', async () => {
            asSession({ isSysadmin: true, isBoardMember: true });
            const res = await PATCH(patchReq({ targetUserId: testTargetUserId, isOperations: true }));
            expect(res.status).toBe(401);
            expect(await hasOperationsRow(testTargetUserId)).toBe(false);
        });
    });

    describe('PATCH /api/roles — board actor matrix', () => {
        let boardActorId: number;
        let board2Id: number;

        beforeAll(async () => {
            // PersonRole is what the lock/count and claims now read — every board fixture
            // that bypasses PATCH (this one included) must carry the table row, not just
            // the mirror column.
            const boardActor = await prisma.person.create({
                data: {
                    email: `board-actor-${TAG}@example.com`, name: 'Board Actor', isBoardMember: true,
                    household: { create: { name: "Test HH" } },
                    roles: { create: [{ role: 'BOARD' }] },
                },
            });
            boardActorId = boardActor.id;
            const board2 = await prisma.person.create({
                data: {
                    email: `board2-${TAG}@example.com`, name: 'Board Two', isBoardMember: true,
                    household: { create: { name: "Test HH" } },
                    roles: { create: [{ role: 'BOARD' }] },
                },
            });
            board2Id = board2.id;
        });

        afterAll(async () => {
            await prisma.auditLog.deleteMany({ where: { actorId: { in: [boardActorId, board2Id] } } });
            await prisma.person.deleteMany({ where: { id: { in: [boardActorId, board2Id] } } });
        });

        it('board grants isSysadmin on a target -> 200 (reverses the old board-cannot-touch-sysadmin guard)', async () => {
            asSession({ id: boardActorId, isBoardMember: true });
            const res = await PATCH(patchReq({ targetUserId: testTargetUserId, isSysadmin: true }));
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.message).toBe("Roles updated successfully");
            expect(data.user.isSysadmin).toBe(true);

            const row = await prisma.person.findUnique({ where: { id: testTargetUserId } });
            expect(row?.isSysadmin).toBe(true);
        });

        it('board grants/revokes isKeyholder, isBackgroundCheckReviewer, isOperations -> 200', async () => {
            asSession({ id: boardActorId, isBoardMember: true });

            const grant = await PATCH(patchReq({
                targetUserId: testTargetUserId,
                isKeyholder: true,
                isBackgroundCheckReviewer: true,
                isOperations: true,
            }));
            expect(grant.status).toBe(200);
            let row = await prisma.person.findUnique({ where: { id: testTargetUserId } });
            // Dual-write consistency: the four legacy-mirrored flags agree between the
            // table and the column; OPERATIONS has a row but (by design) no column.
            expect(row?.isKeyholder).toBe(true);
            expect(row?.isBackgroundCheckReviewer).toBe(true);
            expect(await hasOperationsRow(testTargetUserId)).toBe(true);
            expect(await prisma.personRole.findUnique({ where: { personId_role: { personId: testTargetUserId, role: 'KEYHOLDER' } } })).not.toBeNull();
            expect(await prisma.personRole.findUnique({ where: { personId_role: { personId: testTargetUserId, role: 'BG_REVIEWER' } } })).not.toBeNull();
            expect(row && 'isOperations' in row).toBe(false);

            const revoke = await PATCH(patchReq({ targetUserId: testTargetUserId, isKeyholder: false }));
            expect(revoke.status).toBe(200);
            row = await prisma.person.findUnique({ where: { id: testTargetUserId } });
            expect(row?.isKeyholder).toBe(false);
            expect(await prisma.personRole.findUnique({ where: { personId_role: { personId: testTargetUserId, role: 'KEYHOLDER' } } })).toBeNull();
        });

        it('writes an audit row with per-flag before/after on a successful change', async () => {
            asSession({ id: boardActorId, isBoardMember: true });
            const before = await hasOperationsRow(testTargetUserId);
            const res = await PATCH(patchReq({ targetUserId: testTargetUserId, isOperations: !before }));
            expect(res.status).toBe(200);

            const audit = await prisma.auditLog.findFirst({
                where: { actorId: boardActorId, affectedEntityId: testTargetUserId, action: 'EDIT' },
                orderBy: { id: 'desc' },
            });
            expect(audit).not.toBeNull();
            expect(audit?.tableName).toBe('PersonRole');
            expect(audit?.newData).toMatchObject({ isOperations: !before });
            expect(audit?.oldData).toMatchObject({ isOperations: before });
        });

        it('board removes board membership from another board member -> 200 (>=2 board members present)', async () => {
            asSession({ id: boardActorId, isBoardMember: true });
            const countBefore = await prisma.person.count({ where: { isBoardMember: true } });
            expect(countBefore).toBeGreaterThanOrEqual(2);

            const res = await PATCH(patchReq({ targetUserId: board2Id, isBoardMember: false }));
            expect(res.status).toBe(200);

            const row = await prisma.person.findUnique({ where: { id: board2Id } });
            expect(row?.isBoardMember).toBe(false);
        });

        it('a present flag equal to the current value is a no-op (still 200, no audit row written)', async () => {
            asSession({ id: boardActorId, isBoardMember: true });
            const before = await prisma.person.findUnique({ where: { id: testTargetUserId }, select: { isKeyholder: true } });
            const auditCountBefore = await prisma.auditLog.count({ where: { actorId: boardActorId, affectedEntityId: testTargetUserId } });

            const res = await PATCH(patchReq({ targetUserId: testTargetUserId, isKeyholder: !!before?.isKeyholder }));
            expect(res.status).toBe(200);

            const auditCountAfter = await prisma.auditLog.count({ where: { actorId: boardActorId, affectedEntityId: testTargetUserId } });
            expect(auditCountAfter).toBe(auditCountBefore);
        });
    });

    describe('PATCH /api/roles — sysadmin-only board grant/revoke', () => {
        let plainTargetId: number;

        beforeAll(async () => {
            const plain = await prisma.person.create({
                data: { email: `sysadmin-target-${TAG}@example.com`, name: 'Sysadmin Target', household: { create: { name: "Test HH" } } },
            });
            plainTargetId = plain.id;
        });

        afterAll(async () => {
            await prisma.auditLog.deleteMany({ where: { affectedEntityId: plainTargetId } });
            await prisma.person.deleteMany({ where: { id: plainTargetId } });
        });

        it('sysadmin-only adds board -> 200', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: plainTargetId, isBoardMember: true }));
            expect(res.status).toBe(200);
            const row = await prisma.person.findUnique({ where: { id: plainTargetId } });
            expect(row?.isBoardMember).toBe(true);
        });

        it('sysadmin-only grants/revokes a non-board flag incl. isOperations -> 200', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: plainTargetId, isOperations: true }));
            expect(res.status).toBe(200);
            expect(await hasOperationsRow(plainTargetId)).toBe(true);
        });

        it('sysadmin-only removes board -> 403 (message asserted), target unchanged', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: plainTargetId, isBoardMember: false }));
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toBe("Only board members can remove board membership");

            const row = await prisma.person.findUnique({ where: { id: plainTargetId } });
            expect(row?.isBoardMember).toBe(true);
        });
    });

    describe('PATCH /api/roles — board grant into a DENIED household', () => {
        let deniedPersonId: number;
        let deniedHouseholdId: number;

        beforeAll(async () => {
            const person = await prisma.person.create({
                data: { email: `denied-target-${TAG}@example.com`, name: 'Denied Target', household: { create: { name: "Test HH" } } },
            });
            deniedPersonId = person.id;
            deniedHouseholdId = person.householdId;
            await prisma.orgMembership.create({ data: { householdId: deniedHouseholdId, status: 'DENIED' } });
        });

        afterAll(async () => {
            if (deniedPersonId === undefined) return;
            await prisma.auditLog.deleteMany({ where: { affectedEntityId: deniedPersonId } });
            await prisma.orgMembership.deleteMany({ where: { householdId: deniedHouseholdId } });
            await prisma.person.deleteMany({ where: { id: deniedPersonId } });
        });

        it('refuses the grant (409) and writes neither the PersonRole row nor the mirror', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: deniedPersonId, isBoardMember: true }));
            expect(res.status).toBe(409);
            const data = await res.json();
            expect(data.error).toContain('denied membership');

            expect(await prisma.personRole.findUnique({
                where: { personId_role: { personId: deniedPersonId, role: 'BOARD' } },
            })).toBeNull();
            const row = await prisma.person.findUnique({ where: { id: deniedPersonId } });
            expect(row?.isBoardMember).toBe(false);
        });

        it('still allows a non-board flag on the same person (the guard is BOARD-only)', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: deniedPersonId, isOperations: true }));
            expect(res.status).toBe(200);
            expect(await hasOperationsRow(deniedPersonId)).toBe(true);
        });

        it('allows the grant once the household is restored', async () => {
            await prisma.orgMembership.update({ where: { householdId: deniedHouseholdId }, data: { status: 'NONE' } });
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: deniedPersonId, isBoardMember: true }));
            expect(res.status).toBe(200);

            // Leave no BOARD row behind: the last-board describes below assert a zero
            // ambient board count.
            await prisma.personRole.deleteMany({ where: { personId: deniedPersonId, role: 'BOARD' } });
            await prisma.person.update({ where: { id: deniedPersonId }, data: { isBoardMember: false } });
        });
    });

    describe('PATCH /api/roles — canAccessStaging (ops-stg gate escape hatch, sysadmin-only, NOT board-symmetric)', () => {
        let stagingTargetId: number;
        let stagingBoardActorId: number;

        beforeAll(async () => {
            const target = await prisma.person.create({
                data: { email: `staging-target-${TAG}@example.com`, name: 'Staging Target', household: { create: { name: "Test HH" } } },
            });
            stagingTargetId = target.id;
            // A board member who is NOT a sysadmin — the case the board-symmetric matrix
            // would otherwise wave through for the five ROLE_FLAGS.
            const boardActor = await prisma.person.create({
                data: {
                    email: `staging-board-actor-${TAG}@example.com`, name: 'Staging Board Actor', isBoardMember: true,
                    household: { create: { name: "Test HH" } },
                    roles: { create: [{ role: 'BOARD' }] },
                },
            });
            stagingBoardActorId = boardActor.id;
        });

        afterAll(async () => {
            await prisma.auditLog.deleteMany({ where: { actorId: { in: [stagingTargetId, stagingBoardActorId] } } });
            await prisma.person.deleteMany({ where: { id: { in: [stagingTargetId, stagingBoardActorId] } } });
        });

        it('a board member (non-sysadmin) cannot set canAccessStaging -> 403, target unchanged', async () => {
            asSession({ id: stagingBoardActorId, isBoardMember: true });
            const res = await PATCH(patchReq({ targetUserId: stagingTargetId, canAccessStaging: true }));
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toContain('Sysadmin');

            const row = await prisma.person.findUnique({ where: { id: stagingTargetId } });
            expect(row?.canAccessStaging).toBe(false);
        });

        it('a sysadmin sets canAccessStaging -> 200, persisted, and audited', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: stagingTargetId, canAccessStaging: true }));
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.user.canAccessStaging).toBe(true);

            const row = await prisma.person.findUnique({ where: { id: stagingTargetId } });
            expect(row?.canAccessStaging).toBe(true);

            const audit = await prisma.auditLog.findFirst({
                where: { actorId: testSysAdminId, affectedEntityId: stagingTargetId, action: 'EDIT' },
                orderBy: { id: 'desc' },
            });
            expect(audit?.newData).toMatchObject({ canAccessStaging: true });
            expect(audit?.oldData).toMatchObject({ canAccessStaging: false });
            // canAccessStaging is a column on Person, NOT a PersonRole row. Filing it
            // under "PersonRole" would hide the staging grant from anyone querying the
            // audit log by table.
            expect(audit?.tableName).toBe('Person');
        });

        it('a sysadmin can also revoke it -> 200, persisted', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: stagingTargetId, canAccessStaging: false }));
            expect(res.status).toBe(200);

            const row = await prisma.person.findUnique({ where: { id: stagingTargetId } });
            expect(row?.canAccessStaging).toBe(false);
        });

        it('setting it to its current value is a no-op (still 200, no audit row written)', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const auditCountBefore = await prisma.auditLog.count({ where: { actorId: testSysAdminId, affectedEntityId: stagingTargetId } });

            const res = await PATCH(patchReq({ targetUserId: stagingTargetId, canAccessStaging: false }));
            expect(res.status).toBe(200);

            const auditCountAfter = await prisma.auditLog.count({ where: { actorId: testSysAdminId, affectedEntityId: stagingTargetId } });
            expect(auditCountAfter).toBe(auditCountBefore);
        });

        it('combined with a ROLE_FLAGS update in one request: sysadmin may set both', async () => {
            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: stagingTargetId, canAccessStaging: true, isOperations: true }));
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.user.canAccessStaging).toBe(true);
            expect(data.user.isOperations).toBe(true);
        });

        it('one request touching both tables writes TWO audit rows, each under its own tableName', async () => {
            // Reset so this request changes both at once.
            await prisma.person.update({ where: { id: stagingTargetId }, data: { canAccessStaging: false } });
            await prisma.personRole.deleteMany({ where: { personId: stagingTargetId, role: 'OPERATIONS' } });
            const before = await prisma.auditLog.count({ where: { affectedEntityId: stagingTargetId } });

            asSession({ id: testSysAdminId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: stagingTargetId, canAccessStaging: true, isOperations: true }));
            expect(res.status).toBe(200);

            const rows = await prisma.auditLog.findMany({
                where: { affectedEntityId: stagingTargetId },
                orderBy: { id: 'desc' },
                take: 2,
            });
            expect(await prisma.auditLog.count({ where: { affectedEntityId: stagingTargetId } })).toBe(before + 2);

            const person = rows.find((r) => r.tableName === 'Person');
            const personRole = rows.find((r) => r.tableName === 'PersonRole');
            expect(person?.newData).toMatchObject({ canAccessStaging: true });
            expect(personRole?.newData).toMatchObject({ isOperations: true });
            // The role row must not carry the column change — that was the drift.
            expect(personRole?.newData).not.toHaveProperty('canAccessStaging');
            expect(person?.newData).not.toHaveProperty('isOperations');
        });
    });

    describe('PATCH /api/roles — own-household rule', () => {
        let householdId: number;
        let boardSelfId: number;
        let sysadminSelfId: number;
        let spouseId: number;
        let outsiderId: number;

        beforeAll(async () => {
            householdId = (await prisma.household.create({ data: { name: "Own HH" } })).id;
            boardSelfId = (await prisma.person.create({
                data: {
                    email: `own-board-${TAG}@example.com`, name: 'Own Board', isBoardMember: true,
                    householdId, roles: { create: [{ role: 'BOARD' }] },
                },
            })).id;
            sysadminSelfId = (await prisma.person.create({
                data: {
                    email: `own-sysadmin-${TAG}@example.com`, name: 'Own Sysadmin', isSysadmin: true,
                    household: { create: { name: "Test HH" } }, roles: { create: [{ role: 'SYSADMIN' }] },
                },
            })).id;
            spouseId = (await prisma.person.create({
                data: {
                    email: `own-spouse-${TAG}@example.com`, name: 'Own Spouse', isKeyholder: true,
                    householdId, roles: { create: [{ role: 'KEYHOLDER' }] },
                },
            })).id;
            outsiderId = (await prisma.person.create({
                data: { email: `own-outsider-${TAG}@example.com`, name: 'Outsider', household: { create: { name: "Test HH" } } },
            })).id;
        });

        afterAll(async () => {
            const ids = [boardSelfId, sysadminSelfId, spouseId, outsiderId].filter((id) => id !== undefined);
            if (ids.length === 0) return;
            await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { affectedEntityId: { in: ids } }] } });
            await prisma.person.deleteMany({ where: { id: { in: ids } } });
            if (householdId !== undefined) await prisma.household.deleteMany({ where: { id: householdId } });
        });

        async function auditCount(personId: number) {
            return prisma.auditLog.count({ where: { affectedEntityId: personId } });
        }

        it('a sysadmin cannot grant themself BOARD -> 403, no row, no audit', async () => {
            asSession({ id: sysadminSelfId, isSysadmin: true });
            const audits = await auditCount(sysadminSelfId);
            const res = await PATCH(patchReq({ targetUserId: sysadminSelfId, isBoardMember: true }));
            expect(res.status).toBe(403);
            expect(await prisma.personRole.findUnique({ where: { personId_role: { personId: sysadminSelfId, role: 'BOARD' } } })).toBeNull();
            expect(await auditCount(sysadminSelfId)).toBe(audits);
        });

        it('a board member cannot grant any role flag to someone in their household -> 403 for every flag', async () => {
            asSession({ id: boardSelfId, isBoardMember: true });
            for (const flag of ROLE_FLAGS.filter((f) => f !== 'isKeyholder')) {
                const res = await PATCH(patchReq({ targetUserId: spouseId, [flag]: true }));
                expect({ flag, status: res.status }).toEqual({ flag, status: 403 });
            }
            const rows = await prisma.personRole.findMany({ where: { personId: spouseId }, select: { role: true } });
            expect(rows.map((r) => r.role)).toEqual(['KEYHOLDER']);
        });

        it('a board member cannot revoke a role from someone in their household -> 403, unchanged', async () => {
            asSession({ id: boardSelfId, isBoardMember: true });
            const res = await PATCH(patchReq({ targetUserId: spouseId, isKeyholder: false }));
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toMatch(/own household/);
            expect(await prisma.personRole.findUnique({ where: { personId_role: { personId: spouseId, role: 'KEYHOLDER' } } })).not.toBeNull();
        });

        it('a sysadmin cannot set canAccessStaging on themself -> 403, unchanged', async () => {
            asSession({ id: sysadminSelfId, isSysadmin: true });
            const res = await PATCH(patchReq({ targetUserId: sysadminSelfId, canAccessStaging: true }));
            expect(res.status).toBe(403);
            const row = await prisma.person.findUnique({ where: { id: sysadminSelfId }, select: { canAccessStaging: true } });
            expect(row?.canAccessStaging).toBe(false);
        });

        it('the same actor may grant to someone outside their household -> 200, audited in the same request', async () => {
            asSession({ id: boardSelfId, isBoardMember: true });
            const res = await PATCH(patchReq({ targetUserId: outsiderId, isKeyholder: true, isOperations: true }));
            expect(res.status).toBe(200);
            const rows = await prisma.auditLog.findMany({ where: { actorId: boardSelfId, affectedEntityId: outsiderId, tableName: 'PersonRole' } });
            expect(rows.map((r) => r.newData)).toEqual(expect.arrayContaining([{ isKeyholder: true }, { isOperations: true }]));
            expect(rows.map((r) => r.oldData)).toEqual(expect.arrayContaining([{ isKeyholder: false }, { isOperations: false }]));
            expect(rows.every((r) => r.actorSystem === null)).toBe(true);
        });
    });

    describe('PATCH /api/roles — last-board guard', () => {
        let loneBoardId: number;
        let staleBoardId: number;

        beforeAll(async () => {
            // The lock/count the route guards on is PersonRole now — assert the ambient
            // invariant against the table, not the (dual-written but derivative) mirror.
            const ambient = await prisma.personRole.findMany({
                where: { role: 'BOARD' },
                include: { person: { select: { email: true, name: true } } },
            });
            if (ambient.length !== 0) {
                throw new Error(`Expected zero ambient board members before this describe, found ${ambient.length}: ${ambient.map((r) => `${r.person.name} <${r.person.email}>`).join(', ')}. A prior describe's board fixtures leaked.`);
            }
            const lone = await prisma.person.create({
                data: {
                    email: `lone-board-${TAG}@example.com`, name: 'Lone Board', isBoardMember: true,
                    household: { create: { name: "Test HH" } },
                    roles: { create: [{ role: 'BOARD' }] },
                },
            });
            loneBoardId = lone.id;
            const stale = await prisma.person.create({
                data: { email: `stale-board-${TAG}@example.com`, name: 'Stale Board', household: { create: { name: "Test HH" } } },
            });
            staleBoardId = stale.id;
        });

        afterAll(async () => {
            // If beforeAll threw before assignment, an undefined id would make these
            // where clauses match ALL rows — bail instead of cascading the failure.
            const ids = [loneBoardId, staleBoardId].filter((id) => id !== undefined);
            if (ids.length === 0) return;
            await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
            await prisma.person.deleteMany({ where: { id: { in: ids } } });
        });

        it('removing the last board member -> 409, board membership unchanged', async () => {
            // Self-removal is refused by the own-household rule, so the actor is someone
            // whose session still claims board after their own board row was revoked.
            asSession({ id: staleBoardId, isBoardMember: true });
            const res = await PATCH(patchReq({ targetUserId: loneBoardId, isBoardMember: false }));
            expect(res.status).toBe(409);
            const data = await res.json();
            expect(data.error).toBe("Cannot remove the last board member");

            const row = await prisma.person.findUnique({ where: { id: loneBoardId } });
            expect(row?.isBoardMember).toBe(true);
        });
    });

    describe('PATCH /api/roles — concurrent last-board race (FOR UPDATE lock)', () => {
        let raceAId: number;
        let raceBId: number;

        beforeAll(async () => {
            const ambient = await prisma.personRole.findMany({
                where: { role: 'BOARD' },
                include: { person: { select: { email: true, name: true } } },
            });
            if (ambient.length !== 0) {
                throw new Error(`Expected zero ambient board members before this describe, found ${ambient.length}: ${ambient.map((r) => `${r.person.name} <${r.person.email}>`).join(', ')}. A prior describe's board fixtures leaked.`);
            }
            const a = await prisma.person.create({
                data: {
                    email: `race-a-${TAG}@example.com`, name: 'Race A', isBoardMember: true,
                    household: { create: { name: "Test HH" } },
                    roles: { create: [{ role: 'BOARD' }] },
                },
            });
            raceAId = a.id;
            const b = await prisma.person.create({
                data: {
                    email: `race-b-${TAG}@example.com`, name: 'Race B', isBoardMember: true,
                    household: { create: { name: "Test HH" } },
                    roles: { create: [{ role: 'BOARD' }] },
                },
            });
            raceBId = b.id;
        });

        afterAll(async () => {
            // Drop ids left unassigned by a failed beforeAll so a fixture failure
            // doesn't cascade into a PrismaClientValidationError masking the real error.
            const ids = [raceAId, raceBId].filter((id) => id !== undefined);
            if (ids.length === 0) return;
            await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
            await prisma.person.deleteMany({ where: { id: { in: ids } } });
        });

        it('two concurrent cross-removals with count==2 -> exactly one 200 and one 409; final count is 1', async () => {
            // Deterministic mock-identity assignment: Promise.all evaluates its array
            // left-to-right, and each PATCH call synchronously reaches its
            // getServerSession() call (the first await inside authenticateRequest)
            // before the next array element is even invoked — so the first queued
            // mock value always resolves for reqA, the second for reqB, regardless
            // of which transaction's DB work finishes first.
            (getServerSession as jest.Mock)
                .mockResolvedValueOnce({ user: { id: raceAId, isBoardMember: true } })
                .mockResolvedValueOnce({ user: { id: raceBId, isBoardMember: true } });

            const [resA, resB] = await Promise.all([
                PATCH(patchReq({ targetUserId: raceBId, isBoardMember: false })),
                PATCH(patchReq({ targetUserId: raceAId, isBoardMember: false })),
            ]);

            const statuses = [resA.status, resB.status].sort();
            expect(statuses).toEqual([200, 409]);

            const loser = resA.status === 409 ? resA : resB;
            const loserData = await loser.json();
            expect(loserData.error).toBe("Cannot remove the last board member");

            // Assert on the table (the lock's source of truth), not the mirror, to prove
            // the FOR UPDATE lock is actually serializing against PersonRole now.
            const finalBoardCount = await prisma.personRole.count({ where: { role: 'BOARD', personId: { in: [raceAId, raceBId] } } });
            expect(finalBoardCount).toBe(1);
            // The mirror stays consistent with the table (dual-write).
            const finalMirrorCount = await prisma.person.count({ where: { isBoardMember: true, id: { in: [raceAId, raceBId] } } });
            expect(finalMirrorCount).toBe(1);
        });
    });

    describe('PersonRole backfill (migration 20260718180437_person_roles_table)', () => {
        // Same shape as the migration's INSERT...SELECT, restricted by id so it only
        // touches this describe's own fixtures on the shared test DB (running the
        // unrestricted migration SQL again here would collide with every other
        // describe's already-backfilled BOARD/etc. rows).
        async function runBackfill(ids: number[]) {
            const idList = ids.join(',');
            await prisma.$executeRawUnsafe(`
                INSERT INTO "PersonRole" ("personId", "role", "grantedAt")
                SELECT "id", 'SYSADMIN'::"PersonRoleKind", CURRENT_TIMESTAMP FROM "Person" WHERE "isSysadmin" = true AND "id" IN (${idList})
                UNION ALL
                SELECT "id", 'BOARD', CURRENT_TIMESTAMP FROM "Person" WHERE "isBoardMember" = true AND "id" IN (${idList})
                UNION ALL
                SELECT "id", 'KEYHOLDER', CURRENT_TIMESTAMP FROM "Person" WHERE "isKeyholder" = true AND "id" IN (${idList})
                UNION ALL
                SELECT "id", 'BG_REVIEWER', CURRENT_TIMESTAMP FROM "Person" WHERE "isBackgroundCheckReviewer" = true AND "id" IN (${idList});
            `);
        }

        it('backfills exactly one row per true legacy boolean, and no row for isOperations (never had a column)', async () => {
            // Simulates pre-migration data: legacy booleans set directly, no PersonRole
            // rows (as if these people existed before the table was created).
            const both = await prisma.person.create({
                data: { email: `backfill-both-${TAG}@example.com`, name: 'Backfill Both', isSysadmin: true, isBoardMember: true, household: { create: { name: "Test HH" } } },
            });
            const keyholderOnly = await prisma.person.create({
                data: { email: `backfill-kh-${TAG}@example.com`, name: 'Backfill KH', isKeyholder: true, household: { create: { name: "Test HH" } } },
            });
            const nobody = await prisma.person.create({
                data: { email: `backfill-nobody-${TAG}@example.com`, name: 'Backfill Nobody', household: { create: { name: "Test HH" } } },
            });

            try {
                expect(await prisma.personRole.count({ where: { personId: { in: [both.id, keyholderOnly.id, nobody.id] } } })).toBe(0);

                await runBackfill([both.id, keyholderOnly.id, nobody.id]);

                const bothRoles = (await prisma.personRole.findMany({ where: { personId: both.id }, select: { role: true } })).map(r => r.role).sort();
                expect(bothRoles).toEqual(['BOARD', 'SYSADMIN']);

                const khRoles = (await prisma.personRole.findMany({ where: { personId: keyholderOnly.id }, select: { role: true } })).map(r => r.role);
                expect(khRoles).toEqual(['KEYHOLDER']);

                expect(await prisma.personRole.count({ where: { personId: nobody.id } })).toBe(0);

                // isOperations never shipped a column — nothing to backfill it from.
                expect(await prisma.personRole.count({ where: { role: 'OPERATIONS', personId: { in: [both.id, keyholderOnly.id, nobody.id] } } })).toBe(0);
            } finally {
                await prisma.person.deleteMany({ where: { id: { in: [both.id, keyholderOnly.id, nobody.id] } } });
            }
        });
    });
});
