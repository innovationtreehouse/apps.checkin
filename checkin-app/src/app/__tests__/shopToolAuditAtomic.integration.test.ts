/**
 * @jest-environment node
 */
/**
 * A tool change and its audit row commit together (docs/rules/principles.md, Accountability).
 * A trigger makes Postgres refuse the refused actor's audit rows, whichever client
 * writes them, so that actor's tool change must roll back with the refused row.
 */
import { POST as createTool } from '@/app/api/shop/tools/route';
import { PATCH as editTool } from '@/app/api/shop/tools/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import type { NextRequest } from 'next/server';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'shop-tool-audit-atomic-test';
const TOOL_NAME = `Tool ${TAG}`;

const req = (method: string, body: unknown) =>
    new Request('http://localhost:4000/api/shop/tools', { method, body: JSON.stringify(body) }) as unknown as NextRequest;
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

describe('tool writes commit with their audit row', () => {
    let refusedId: number;
    let actorId: number;
    let toolId: number;

    const signInAs = (id: number) =>
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: true, isBoardMember: true } });

    const board = (who: string) => prisma.person.create({
        data: {
            email: `${who}-${TAG}@example.com`,
            name: who,
            isSysadmin: true,
            isBoardMember: true,
            household: { create: { name: 'Test HH' } },
        },
    });

    beforeAll(async () => {
        refusedId = (await board('refused')).id;
        actorId = (await board('actor')).id;
        toolId = (await prisma.tool.create({ data: { name: TOOL_NAME } })).id;

        await prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION shop_tool_audit_atomic_refuse() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'audit write refused'; END
            $$ LANGUAGE plpgsql`);
        await prisma.$executeRawUnsafe(`
            CREATE TRIGGER shop_tool_audit_atomic_refuse BEFORE INSERT ON "AuditLog"
            FOR EACH ROW WHEN (NEW."actorId" = ${refusedId})
            EXECUTE FUNCTION shop_tool_audit_atomic_refuse()`);
    });

    beforeEach(() => {
        // The routes log the refused write; that error is this suite's premise.
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => jest.restoreAllMocks());

    afterAll(async () => {
        await prisma.$executeRawUnsafe('DROP TRIGGER shop_tool_audit_atomic_refuse ON "AuditLog"');
        await prisma.$executeRawUnsafe('DROP FUNCTION shop_tool_audit_atomic_refuse()');
        const people = await prisma.person.findMany({ where: { id: { in: [refusedId, actorId] } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: [refusedId, actorId] } } });
        await prisma.tool.deleteMany({ where: { name: { startsWith: TOOL_NAME } } });
        await prisma.person.deleteMany({ where: { id: { in: [refusedId, actorId] } } });
        await prisma.household.deleteMany({ where: { id: { in: people.map((p) => p.householdId) } } });
    });

    it('PATCH /api/shop/tools/[id] keeps the old tool when its audit row is refused', async () => {
        signInAs(refusedId);
        const res = await editTool(req('PATCH', { name: `${TOOL_NAME} refused` }), ctx(toolId));
        expect(res.status).toBe(500);
        expect(await prisma.tool.findUnique({ where: { id: toolId } })).toMatchObject({ name: TOOL_NAME });
    });

    it('POST /api/shop/tools creates no tool when its audit row is refused', async () => {
        signInAs(refusedId);
        const res = await createTool(req('POST', { name: `${TOOL_NAME} created` }));
        expect(res.status).toBe(500);
        expect(await prisma.tool.count({ where: { name: `${TOOL_NAME} created` } })).toBe(0);
    });

    it('PATCH /api/shop/tools/[id] writes the edit and its audit row', async () => {
        signInAs(actorId);
        const res = await editTool(req('PATCH', { name: `${TOOL_NAME} edited` }), ctx(toolId));
        expect(res.status).toBe(200);
        expect(await prisma.tool.findUnique({ where: { id: toolId } })).toMatchObject({ name: `${TOOL_NAME} edited` });
        const rows = await prisma.auditLog.findMany({ where: { tableName: 'Tool', affectedEntityId: toolId } });
        expect(rows).toEqual([
            expect.objectContaining({
                actorId,
                actorSystem: null,
                action: 'EDIT',
                newData: { id: toolId, name: `${TOOL_NAME} edited`, safetyGuide: null },
            }),
        ]);
    });
});
