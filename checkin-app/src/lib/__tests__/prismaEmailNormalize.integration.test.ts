/**
 * @jest-environment node
 */
/**
 * Integration tests for the Person.email write-time normalization extension
 * (src/lib/prismaEmailNormalize.ts). Uses the real extended client against the
 * test DB — this is what actually proves the $extends wiring intercepts writes.
 */

import prisma from '@/lib/prisma';

// All fixtures carry this marker so cleanup is scoped (this file shares one DB
// with ~285 other integration files per jest worker — an unscoped wipe corrupts
// their fixtures).
const MARK = 'email-normalize-test';

describe('Person.email write-time normalization', () => {
    let householdId: number;

    beforeAll(async () => {
        const hh = await prisma.household.create({ data: { name: `${MARK}-hh` } });
        householdId = hh.id;
    });

    afterEach(async () => {
        await prisma.person.deleteMany({ where: { householdId } });
    });

    afterAll(async () => {
        await prisma.person.deleteMany({ where: { householdId } });
        await prisma.household.delete({ where: { id: householdId } });
    });

    it('create lowercases a mixed-case email', async () => {
        const p = await prisma.person.create({
            data: { householdId, name: 'A', email: `Foo.${MARK}@X.com` },
        });
        expect(p.email).toBe(`foo.${MARK}@x.com`);
    });

    it('update lowercases a mixed-case email (plain form)', async () => {
        const p = await prisma.person.create({
            data: { householdId, name: 'B', email: `b.${MARK}@x.com` },
        });
        const u = await prisma.person.update({
            where: { id: p.id },
            data: { email: `B.${MARK}@Y.COM` },
        });
        expect(u.email).toBe(`b.${MARK}@y.com`);
    });

    it('update lowercases the wrapped { set } form', async () => {
        const p = await prisma.person.create({
            data: { householdId, name: 'C', email: `c.${MARK}@x.com` },
        });
        const u = await prisma.person.update({
            where: { id: p.id },
            data: { email: { set: `C.${MARK}@Y.COM` } },
        });
        expect(u.email).toBe(`c.${MARK}@y.com`);
    });

    it('upsert lowercases on the create branch', async () => {
        const email = `Up.${MARK}@X.com`;
        const p = await prisma.person.upsert({
            where: { email: email.toLowerCase() },
            create: { householdId, name: 'D', email },
            update: { name: 'D2' },
        });
        expect(p.email).toBe(`up.${MARK}@x.com`);
    });

    it('upsert lowercases on the update branch', async () => {
        const lower = `up2.${MARK}@x.com`;
        await prisma.person.create({ data: { householdId, name: 'E', email: lower } });
        const p = await prisma.person.upsert({
            where: { email: lower },
            create: { householdId, name: 'E', email: lower },
            update: { email: `UP2.${MARK}@X.com` },
        });
        expect(p.email).toBe(lower);
    });

    it('createMany lowercases each row', async () => {
        await prisma.person.createMany({
            data: [
                { householdId, name: 'F', email: `F1.${MARK}@X.com` },
                { householdId, name: 'G', email: `G1.${MARK}@X.com` },
            ],
        });
        const rows = await prisma.person.findMany({
            where: { householdId },
            select: { email: true },
            orderBy: { email: 'asc' },
        });
        expect(rows.map((r) => r.email)).toEqual([`f1.${MARK}@x.com`, `g1.${MARK}@x.com`]);
    });

    it('leaves a create with no email / null email untouched', async () => {
        const none = await prisma.person.create({ data: { householdId, name: 'H' } });
        expect(none.email).toBeNull();
        const nul = await prisma.person.create({ data: { householdId, name: 'I', email: null } });
        expect(nul.email).toBeNull();
    });

    it('leaves an already-lowercase email unchanged', async () => {
        const email = `already.${MARK}@x.com`;
        const p = await prisma.person.create({ data: { householdId, name: 'J', email } });
        expect(p.email).toBe(email);
    });

    // normalizeEmail's contract is trim-then-lowercase, but every case above only
    // exercises the lowercase half. Pin the trim at the actual choke
    // point, so a future change to normalizeEmail can't drop the trim unnoticed.
    it('create trims a whitespace-padded email', async () => {
        const p = await prisma.person.create({
            data: { householdId, name: 'K', email: `  Pad.${MARK}@X.com  ` },
        });
        expect(p.email).toBe(`pad.${MARK}@x.com`);
    });
});
