/**
 * @jest-environment node
 */
/**
 * Integration Tests for Shop API Endpoints
 * Tests members, tools, and certifications sub-routes
 */

import { GET as getMembers } from '@/app/api/shop/org-members/route';
import { normalizeAuditData } from '@/lib/auditPayload';
import { SELF_GRANT_REFUSAL_TABLE } from '@/lib/membership/selfGrantGuard';
import { GET as getTools, POST as postTools } from '@/app/api/shop/tools/route';
import { GET as getCerts, POST as postCerts } from '@/app/api/shop/certifications/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
describe('Shop API Integration Tests', () => {
    let adminId: number;
    let boardId: number;
    let certifierId: number;
    let commonId: number;
    
    let mockToolId: number;

    beforeAll(async () => {
        // Clean up any leaked state
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'shop-api-test' } },
            select: { id: true, householdId: true }
        });
        const existingUserIds = existingUsers.map(u => u.id);
        const existingHouseholdIds = existingUsers.map(u => u.householdId).filter((id): id is number => id !== null);

        await prisma.auditLog.deleteMany({
            where: { actorId: { in: existingUserIds } }
        });
        await prisma.toolStatus.deleteMany({
            where: { personId: { in: existingUserIds } }
        });
        await prisma.visit.deleteMany({
            where: { personId: { in: existingUserIds } }
        });
        // RESTRICT: delete participants before their households
        await prisma.person.deleteMany({
            where: { id: { in: existingUserIds } }
        });
        // Memberships belong to the household; remove them before deleting households.
        await prisma.orgMembership.deleteMany({
            where: { householdId: { in: existingHouseholdIds } }
        });
        await prisma.household.deleteMany({
            where: { id: { in: existingHouseholdIds } }
        });

        await prisma.toolStatus.deleteMany({
            where: { tool: { name: { contains: 'Shop Test Tool' } } }
        });
        await prisma.tool.deleteMany({
            where: { name: { contains: 'Shop Test Tool' } }
        });

        // Create Admin
        const admin = await prisma.person.create({
            data: { email: 'admin-shop-api-test@example.com', name: 'Admin', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        adminId = admin.id;

        // Create Board Member
        const board = await prisma.person.create({
            data: { email: 'board-shop-api-test@example.com', name: 'Board', isBoardMember: true, household: { create: { name: "Test HH" } } }
        });
        boardId = board.id;

        // Create Common User
        const commonUser = await prisma.person.create({
            data: {
                email: 'common-shop-api-test@example.com',
                name: 'Common',
                // Volunteer member: the household holds an ACTIVE, isVolunteerFamily membership.
                household: { create: { name: 'Test HH', orgMembership: { create: { status: 'ACTIVE', isVolunteerFamily: true } } } }
            }
        });
        commonId = commonUser.id;

        const tool = await prisma.tool.create({
            data: { name: 'Shop Test Tool Alpha' }
        });
        mockToolId = tool.id;

        // Create Certifier (A user who has MAY_CERTIFY_OTHERS on a tool)
        const certifier = await prisma.person.create({
            data: {
                email: 'certifier-shop-api-test@example.com',
                name: 'Certifier',
                household: { create: { name: "Test HH", orgMembership: { create: { status: 'ACTIVE' } } } },
                toolStatuses: {
                    create: { toolId: mockToolId, level: 'MAY_CERTIFY_OTHERS' }
                }
            }
        });
        certifierId = certifier.id;
    });

    afterAll(async () => {
        const existingUserIds = [adminId, boardId, certifierId, commonId].filter(id => id !== undefined);

        if (existingUserIds.length > 0) {
            const participants = await prisma.person.findMany({
                where: { id: { in: existingUserIds } },
                select: { householdId: true }
            });
            const householdIds = participants.map(p => p.householdId).filter((id): id is number => id !== null);

            await prisma.auditLog.deleteMany({
                where: { actorId: { in: existingUserIds } }
            });
            await prisma.toolStatus.deleteMany({
                where: { personId: { in: existingUserIds } }
            });
            await prisma.visit.deleteMany({
                where: { personId: { in: existingUserIds } }
            });
            // RESTRICT: delete participants before their households
            await prisma.person.deleteMany({
                where: { id: { in: existingUserIds } }
            });
            if (householdIds.length > 0) {
                // Memberships belong to the household; remove them before deleting households.
                await prisma.orgMembership.deleteMany({
                    where: { householdId: { in: householdIds } }
                });
                await prisma.household.deleteMany({
                    where: { id: { in: householdIds } }
                });
            }
        }
        await prisma.toolStatus.deleteMany({
            where: { tool: { name: { contains: 'Shop Test Tool' } } }
        });
        await prisma.tool.deleteMany({
            where: { name: { contains: 'Shop Test Tool' } }
        });
    });

    const createReq = (method: string, queryAndBody?: { searchParams?: string, body?: Record<string, unknown> }) => {
        let url = `http://localhost:4000/api/shop/route`;
        if (queryAndBody?.searchParams) url += `?${queryAndBody.searchParams}`;

        return {
            url,
            method,
            // authenticateRequest probes kiosk headers before the session path;
            // return null so it falls through to the mocked getServerSession.
            headers: { get: () => null },
            json: queryAndBody?.body ? jest.fn().mockResolvedValue(queryAndBody.body) : undefined
        } as unknown as never;
    };

    describe('/api/shop/org-members', () => {
        it('should return 403 for common users', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const res = await getMembers(createReq('GET')) as Response;
             expect(res.status).toBe(403);
        });

        it('should return 200 and members for an admin', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const res = await getMembers(createReq('GET')) as Response;
             expect(res.status).toBe(200);
             const data = await res.json();
             
             // Our common user has an active membership so they should appear
             const memberEmails = data.orgMembers.map((m: { email: string }) => m.email);
             expect(memberEmails).toContain('common-shop-api-test@example.com');
        });

        it('certifier sees member names but NOT emails (pii stripped)', async () => {
             // Certifier auth comes from a MAY_CERTIFY_OTHERS toolStatus on the
             // session — not a role boolean. The view grants member+public only,
             // so email (pii) is stripped while name (public) survives.
             (getServerSession as jest.Mock).mockResolvedValue({
                 user: { id: commonId, toolStatuses: [{ toolId: 1, level: 'MAY_CERTIFY_OTHERS' }] },
             });

             const res = await getMembers(createReq('GET')) as Response;
             expect(res.status).toBe(200);
             const data = await res.json();
             expect(data.orgMembers.length).toBeGreaterThan(0);
             expect(data.orgMembers.every((m: { name?: string }) => typeof m.name === 'string')).toBe(true);
             expect(data.orgMembers.every((m: { email?: string }) => m.email === undefined)).toBe(true);
        });
    });

    describe('/api/shop/tools', () => {
        it('should allow anyone authenticated to GET tool list', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const res = await getTools(createReq('GET')) as Response;
             expect(res.status).toBe(200);
             const data = await res.json();
             expect(Array.isArray(data)).toBe(true);
             expect(data.some((t: { name: string }) => t.name === 'Shop Test Tool Alpha')).toBe(true);
        });

        it('should return 403 for common users attempting a POST', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = createReq('POST', { body: { name: 'Shop Test Tool Beta' } });
             const res = await postTools(req) as Response;
             expect(res.status).toBe(403);
        });

        it('should allow admins to create a new tool', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = createReq('POST', { body: { name: 'Shop Test Tool Admin' } });
             const res = await postTools(req) as Response;
             expect(res.status).toBe(200);
             
             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.tool.name).toBe('Shop Test Tool Admin');
        });

        it('should allow board members to create a new tool', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

             const req = createReq('POST', { body: { name: 'Shop Test Tool Board' } });
             const res = await postTools(req) as Response;
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.tool.name).toBe('Shop Test Tool Board');
        });
    });

    describe('/api/shop/certifications', () => {
        it('should allow anyone to GET certifications', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = createReq('GET', { searchParams: `toolId=${mockToolId}` });
             const res = await getCerts(req) as Response;
             expect(res.status).toBe(200);
             
             const data = await res.json();
             expect(Array.isArray(data)).toBe(true);

             // The Certifier automatically has one on the mockToolId
             expect(data.length).toBeGreaterThanOrEqual(1);
        });

        it('should return 403 for common users attempting a certification grant', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });

             const req = createReq('POST', { body: { personId: commonId, toolId: mockToolId, level: 'BASIC' } });
             const res = await postCerts(req) as Response;
             expect(res.status).toBe(403);
        });

        it('should allow Certifiers to update a status for someone else on their specific tool', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: certifierId } });

             const req = createReq('POST', { body: { personId: commonId, toolId: mockToolId, level: 'BASIC' } });
             const res = await postCerts(req) as Response;
             expect(res.status).toBe(200);
             
             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.certification.level).toBe('BASIC');
             expect(data.certification.personId).toBe(commonId);

             // Audit: first grant on this participant+tool → CREATE, no prior data.
             const auditRows = await prisma.auditLog.findMany({
                 where: { tableName: 'ToolStatus', actorId: certifierId, affectedEntityId: commonId, secondaryAffectedEntity: mockToolId }
             });
             expect(auditRows.length).toBe(1);
             expect(auditRows[0].action).toBe('CREATE');
             expect(auditRows[0].oldData).toBeNull();
        });

        // Denied-household lockout. Certifier
        // status is re-queried from the DB, bypassing the denial-stripped session,
        // so a denied certifier would still pass the MAY_CERTIFY_OTHERS gate. The
        // denied check must reject before the lookup. No certification row is written.
        it('blocks a denied certifier from granting a certification (401, no write)', async () => {
             const tool = await prisma.tool.create({ data: { name: 'Shop Test Tool Denied' } });
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: certifierId, denied: true } });

             const req = createReq('POST', { body: { personId: commonId, toolId: tool.id, level: 'BASIC' } });
             const res = await postCerts(req) as Response;
             expect(res.status).toBe(401);

             // No toolStatus row was written for this fresh (participant, tool) pair.
             const written = await prisma.toolStatus.findUnique({
                 where: { personId_toolId: { personId: commonId, toolId: tool.id } }
             });
             expect(written).toBeNull();
        });

        it('should forbid a Certifier from promoting someone to MAY_CERTIFY_OTHERS', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: certifierId } });

             const req = createReq('POST', { body: { personId: commonId, toolId: mockToolId, level: 'MAY_CERTIFY_OTHERS' } });
             const res = await postCerts(req) as Response;
             // Only admins/board may grant the Certifier level.
             expect(res.status).toBe(403);
        });

        it('should allow an admin to grant MAY_CERTIFY_OTHERS', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

             const req = createReq('POST', { body: { personId: commonId, toolId: mockToolId, level: 'MAY_CERTIFY_OTHERS' } });
             const res = await postCerts(req) as Response;
             expect(res.status).toBe(200);

             const data = await res.json();
             expect(data.success).toBe(true);
             expect(data.certification.level).toBe('MAY_CERTIFY_OTHERS');

             // Audit: a prior status (BASIC) now exists → EDIT, with old data captured.
             const auditRows = await prisma.auditLog.findMany({
                 where: { tableName: 'ToolStatus', actorId: adminId, affectedEntityId: commonId, secondaryAffectedEntity: mockToolId }
             });
             expect(auditRows.length).toBe(1);
             expect(auditRows[0].action).toBe('EDIT');
             expect(auditRows[0].oldData).not.toBeNull();
             expect((normalizeAuditData(auditRows[0].oldData) as Record<string, unknown>).level).toBe('BASIC');
        });

        it('blocks a non-member certifier from granting a certification', async () => {
            const tool = await prisma.tool.create({ data: { name: 'Shop Test Tool NonMemberCert' } });
            const nonMemberCertifier = await prisma.person.create({
                data: {
                    email: 'nonmember-certifier-shop-api-test@example.com',
                    name: 'Non-Member Certifier',
                    household: { create: { name: "Test HH" } },
                    toolStatuses: { create: { toolId: tool.id, level: 'MAY_CERTIFY_OTHERS' } },
                },
            });

            try {
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: nonMemberCertifier.id } });

                const req = createReq('POST', { body: { personId: commonId, toolId: tool.id, level: 'BASIC' } });
                const res = await postCerts(req) as Response;
                expect(res.status).toBe(403);

                const written = await prisma.toolStatus.findUnique({
                    where: { personId_toolId: { personId: commonId, toolId: tool.id } }
                });
                expect(written).toBeNull();
            } finally {
                await prisma.toolStatus.deleteMany({ where: { toolId: tool.id } });
                await prisma.tool.deleteMany({ where: { id: tool.id } });
                const hhIds = [nonMemberCertifier.householdId].filter((id): id is number => id !== null);
                await prisma.person.deleteMany({ where: { id: nonMemberCertifier.id } });
                await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
            }
        });

        it('blocks certifying a non-member target', async () => {
            const tool = await prisma.tool.create({ data: { name: 'Shop Test Tool NonMemberTarget' } });
            const nonMemberTarget = await prisma.person.create({
                data: { email: 'nonmember-target-shop-api-test@example.com', name: 'Non-Member Target', household: { create: { name: "Test HH" } } },
            });
            const memberCertifier = await prisma.person.create({
                data: {
                    email: 'member-certifier-shop-api-test@example.com',
                    name: 'Member Certifier',
                    household: { create: { name: "Test HH", orgMembership: { create: { status: 'ACTIVE' } } } },
                    toolStatuses: { create: { toolId: tool.id, level: 'MAY_CERTIFY_OTHERS' } },
                },
            });

            try {
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: memberCertifier.id } });

                const req = createReq('POST', { body: { personId: nonMemberTarget.id, toolId: tool.id, level: 'BASIC' } });
                const res = await postCerts(req) as Response;
                expect(res.status).toBe(403);

                const written = await prisma.toolStatus.findUnique({
                    where: { personId_toolId: { personId: nonMemberTarget.id, toolId: tool.id } }
                });
                expect(written).toBeNull();
            } finally {
                await prisma.toolStatus.deleteMany({ where: { toolId: tool.id } });
                await prisma.tool.deleteMany({ where: { id: tool.id } });
                const hhIds = [nonMemberTarget.householdId, memberCertifier.householdId].filter((id): id is number => id !== null);
                await prisma.person.deleteMany({ where: { id: { in: [nonMemberTarget.id, memberCertifier.id] } } });
                await prisma.orgMembership.deleteMany({ where: { householdId: { in: hhIds } } });
                await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
            }
        });

        it('allows sysadmin to certify even without own membership', async () => {
            const tool = await prisma.tool.create({ data: { name: 'Shop Test Tool Sysadmin' } });
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });

            const req = createReq('POST', { body: { personId: commonId, toolId: tool.id, level: 'CERTIFIED' } });
            const res = await postCerts(req) as Response;
            expect(res.status).toBe(200);
        });

        it('re-cert by a certifier writes an EDIT audit row with the prior level in oldData and the acting certifier as actor', async () => {
            // Self-contained: a fresh tool the certifier may certify on, a fresh target.
            const tool = await prisma.tool.create({ data: { name: 'Shop Test Tool Recert' } });
            const reCertifier = await prisma.person.create({
                data: {
                    email: 'recert-certifier-shop-api-test@example.com',
                    name: 'Recert Certifier',
                    household: { create: { name: "Test HH", orgMembership: { create: { status: 'ACTIVE' } } } },
                    toolStatuses: { create: { toolId: tool.id, level: 'MAY_CERTIFY_OTHERS' } },
                },
            });
            const target = await prisma.person.create({
                data: { email: 'recert-target-shop-api-test@example.com', name: 'Recert Target', household: { create: { name: "Test HH", orgMembership: { create: { status: 'ACTIVE' } } } } },
            });

            try {
                (getServerSession as jest.Mock).mockResolvedValue({ user: { id: reCertifier.id } });

                // First grant: BASIC → CREATE (no prior status).
                const createRes = await postCerts(
                    createReq('POST', { body: { personId: target.id, toolId: tool.id, level: 'BASIC' } }),
                ) as Response;
                expect(createRes.status).toBe(200);

                // Re-cert: BASIC → CERTIFIED → EDIT with the prior status snapshotted.
                const editRes = await postCerts(
                    createReq('POST', { body: { personId: target.id, toolId: tool.id, level: 'CERTIFIED' } }),
                ) as Response;
                expect(editRes.status).toBe(200);
                expect((await editRes.json()).certification.level).toBe('CERTIFIED');

                const rows = await prisma.auditLog.findMany({
                    where: { tableName: 'ToolStatus', affectedEntityId: target.id, secondaryAffectedEntity: tool.id },
                    orderBy: { id: 'asc' },
                });
                expect(rows.length).toBe(2);
                expect(rows[0].action).toBe('CREATE');

                const editRow = rows[1];
                expect(editRow.action).toBe('EDIT');
                expect(editRow.actorId).toBe(reCertifier.id); // the acting certifier, not an admin
                expect(editRow.oldData).not.toBeNull();
                expect((normalizeAuditData(editRow.oldData) as Record<string, unknown>).level).toBe('BASIC'); // prior level snapshot
            } finally {
                await prisma.auditLog.deleteMany({ where: { affectedEntityId: target.id, tableName: 'ToolStatus' } });
                await prisma.toolStatus.deleteMany({ where: { toolId: tool.id } });
                await prisma.tool.deleteMany({ where: { id: tool.id } });
                const hhIds = [reCertifier.householdId, target.householdId].filter((id): id is number => id !== null);
                await prisma.person.deleteMany({ where: { id: { in: [reCertifier.id, target.id] } } });
                await prisma.orgMembership.deleteMany({ where: { householdId: { in: hhIds } } });
                await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
            }
        });
    });

    describe('/api/shop/certifications — certifier targets and own household', () => {
        let tool: { id: number };
        type Fixture = { id: number; householdId: number };
        let certA: Fixture;
        let certB: Fixture;
        let child: Fixture;
        let outsider: Fixture;
        let boardMember: Fixture;

        const levelOf = async (personId: number) =>
            (await prisma.toolStatus.findUnique({ where: { personId_toolId: { personId, toolId: tool.id } } }))?.level;
        const post = (actor: Record<string, unknown>, personId: number, level: string) => {
            (getServerSession as jest.Mock).mockResolvedValue({ user: actor });
            return postCerts(createReq('POST', { body: { personId, toolId: tool.id, level } })) as Promise<Response>;
        };
        const refusals = (actorId: number, tableName: string) =>
            prisma.auditLog.findMany({ where: { actorId, tableName } });

        beforeAll(async () => {
            tool = await prisma.tool.create({ data: { name: 'Shop Test Tool Guards' } });
            const member = { orgMembership: { create: { status: 'ACTIVE' as const } } };
            certA = await prisma.person.create({
                data: { email: 'guard-cert-a-shop-api-test@example.com', name: 'Cert A', household: { create: { name: 'Test HH', ...member } }, toolStatuses: { create: { toolId: tool.id, level: 'MAY_CERTIFY_OTHERS' } } },
            });
            certB = await prisma.person.create({
                data: { email: 'guard-cert-b-shop-api-test@example.com', name: 'Cert B', household: { create: { name: 'Test HH', ...member } }, toolStatuses: { create: { toolId: tool.id, level: 'MAY_CERTIFY_OTHERS' } } },
            });
            child = await prisma.person.create({
                data: { email: 'guard-child-shop-api-test@example.com', name: 'Cert A Child', householdId: certA.householdId },
            });
            outsider = await prisma.person.create({
                data: { email: 'guard-outsider-shop-api-test@example.com', name: 'Outsider', household: { create: { name: 'Test HH', ...member } } },
            });
            boardMember = await prisma.person.create({
                data: { email: 'guard-board-shop-api-test@example.com', name: 'Guard Board', isBoardMember: true, household: { create: { name: 'Test HH', ...member } } },
            });
        });

        afterAll(async () => {
            const people = [certA, certB, child, outsider, boardMember].filter(Boolean);
            const ids = people.map(p => p.id);
            const hhIds = [...new Set(people.map(p => p.householdId))];
            await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
            await prisma.toolStatus.deleteMany({ where: { toolId: tool.id } });
            await prisma.tool.deleteMany({ where: { id: tool.id } });
            await prisma.person.deleteMany({ where: { id: { in: ids } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: hhIds } } });
            await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
        });

        it('refuses a certifier demoting another certifier (403, audited, level kept)', async () => {
            const res = await post({ id: certA.id }, certB.id, 'BASIC');
            expect(res.status).toBe(403);
            expect(await levelOf(certB.id)).toBe('MAY_CERTIFY_OTHERS');

            const rows = await refusals(certA.id, 'CertifierChangeRefusal');
            expect(rows).toHaveLength(1);
            expect(rows[0].affectedEntityId).toBe(certB.id);
            expect(rows[0].secondaryAffectedEntity).toBe(tool.id);
            expect(normalizeAuditData(rows[0].newData)).toEqual({ reason: 'target_is_certifier', attempted: { level: 'BASIC' } });
            expect(await refusals(certA.id, 'ToolStatus')).toHaveLength(0);
        });

        it('lets a certifier change a non-certifier in another household', async () => {
            expect((await post({ id: certA.id }, outsider.id, 'CERTIFIED')).status).toBe(200);
            expect((await post({ id: certA.id }, outsider.id, 'BASIC')).status).toBe(200);
            expect(await levelOf(outsider.id)).toBe('BASIC');
        });

        it('lets the Board demote a certifier', async () => {
            const res = await post({ id: boardMember.id, isBoardMember: true }, certB.id, 'CERTIFIED');
            expect(res.status).toBe(200);
            expect(await levelOf(certB.id)).toBe('CERTIFIED');
        });

        it('refuses a certifier certifying themself (403, audited)', async () => {
            const res = await post({ id: certA.id }, certA.id, 'INSTRUCTOR');
            expect(res.status).toBe(403);
            expect(await levelOf(certA.id)).toBe('MAY_CERTIFY_OTHERS');
            const rows = await refusals(certA.id, SELF_GRANT_REFUSAL_TABLE);
            expect(rows.some(r => r.affectedEntityId === certA.id)).toBe(true);
        });

        it('refuses a certifier certifying their own child (403, audited)', async () => {
            const res = await post({ id: certA.id }, child.id, 'BASIC');
            expect(res.status).toBe(403);
            expect(await levelOf(child.id)).toBeUndefined();
            const rows = await refusals(certA.id, SELF_GRANT_REFUSAL_TABLE);
            expect(rows.some(r => r.affectedEntityId === child.id)).toBe(true);
        });

        it('refuses a Board member granting themself the certifier level (403, audited)', async () => {
            const res = await post({ id: boardMember.id, isBoardMember: true }, boardMember.id, 'MAY_CERTIFY_OTHERS');
            expect(res.status).toBe(403);
            expect(await levelOf(boardMember.id)).toBeUndefined();
            // Scoped to this grant: an earlier suite's refusal row can carry an actor id that minting has since reissued.
            const rows = await prisma.auditLog.findMany({
                where: { actorId: boardMember.id, tableName: SELF_GRANT_REFUSAL_TABLE, newData: { path: ['table'], equals: 'ToolStatus' } },
            });
            expect(rows.map(r => r.affectedEntityId)).toEqual([boardMember.id]);
            expect(normalizeAuditData(rows[0].newData)).toMatchObject({ reason: 'own_household', table: 'ToolStatus' });
        });
    });
});
