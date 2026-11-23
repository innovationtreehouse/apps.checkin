/**
 * @jest-environment node
 */
/**
 * Runs the committed emergency-contact trim migration against seeded untrimmed
 * rows: it trims them, leaves trimmed rows alone, and the CHECK constraints it
 * adds then hold. Everything runs in one transaction that is rolled back.
 */
import { readFileSync } from "fs";
import { join } from "path";
import prisma from "@/lib/prisma";

const MIGRATION = join(__dirname, "../../../prisma/migrations/20261120120000_emergency_contact_trimmed/migration.sql");
const TAG = "ec-trim-mig";

class Rollback extends Error {}

afterAll(() => prisma.$disconnect());

function migrationStatements(): string[] {
    return readFileSync(MIGRATION, "utf8")
        .replace(/^--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s && s !== "BEGIN" && s !== "COMMIT");
}

test("trims legacy name and phone before adding the CHECK constraints", async () => {
    const legacy: Array<[string, string, string, string]> = [
        // [stored name, stored phone, expected name, expected phone]
        ["  Sam Outside", "555-555-2000\t", "Sam Outside", "555-555-2000"],
        ["Aunt\tMay \r\n", "\n555 555 2001 ", "Aunt\tMay", "555 555 2001"],
        ["   ", " \t ", "", ""],
    ];
    const clean: [string, string] = ["Pat Clean", "555-555-2002"];

    await expect(
        prisma.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(`ALTER TABLE "EmergencyContact" DROP CONSTRAINT "EmergencyContact_name_trimmed"`);
                await tx.$executeRawUnsafe(`ALTER TABLE "EmergencyContact" DROP CONSTRAINT "EmergencyContact_phone_trimmed"`);

                const hh = await tx.household.create({ data: { name: `hh-${TAG}` } });
                const legacyIds: number[] = [];
                for (const [name, phone] of legacy) {
                    const row = await tx.emergencyContact.create({ data: { householdId: hh.id, name, phone, phoneDigits: "5555552000" } });
                    legacyIds.push(row.id);
                }
                const cleanRow = await tx.emergencyContact.create({
                    data: { householdId: hh.id, name: clean[0], phone: clean[1], phoneDigits: "5555552002" },
                });

                let changed = 0;
                for (const stmt of migrationStatements()) changed += await tx.$executeRawUnsafe(stmt);
                expect(changed).toBe(legacy.length);

                const rows = await tx.emergencyContact.findMany({ where: { householdId: hh.id }, select: { id: true, name: true, phone: true } });
                const byId = new Map(rows.map((r) => [r.id, r]));
                legacy.forEach(([, , name, phone], i) => expect(byId.get(legacyIds[i])).toMatchObject({ name, phone }));
                expect(byId.get(cleanRow.id)).toMatchObject({ name: clean[0], phone: clean[1] });

                const constraints = await tx.$queryRaw<Array<{ conname: string }>>`
                    SELECT conname FROM pg_constraint
                    WHERE conrelid = '"EmergencyContact"'::regclass AND conname LIKE 'EmergencyContact_%_trimmed'`;
                expect(constraints.map((c) => c.conname).sort()).toEqual(["EmergencyContact_name_trimmed", "EmergencyContact_phone_trimmed"]);

                throw new Rollback();
            },
            { timeout: 20_000 },
        ),
    ).rejects.toBeInstanceOf(Rollback);
});
