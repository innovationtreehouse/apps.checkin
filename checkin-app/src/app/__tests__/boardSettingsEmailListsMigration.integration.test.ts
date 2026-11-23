/**
 * @jest-environment node
 */
/**
 * Runs the committed email-lists migration against a settings row whose new columns
 * are dropped first: it adds them and copies the alert address into the finance
 * alert address. Everything runs in one transaction that is rolled back.
 */
import { readFileSync } from "fs";
import { join } from "path";
import prisma from "@/lib/prisma";

const MIGRATION = join(__dirname, "../../../prisma/migrations/20261122140000_board_settings_email_lists/migration.sql");
const NEW_COLUMNS = ["financeAlertEmailAddress", "sysadminEmailAddress", "bgReviewerEmailAddress"];

class Rollback extends Error {}

afterAll(() => prisma.$disconnect());

function migrationStatements(): string[] {
    return readFileSync(MIGRATION, "utf8")
        .replace(/^--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s && s !== "BEGIN" && s !== "COMMIT");
}

test("adds the list columns and copies the alert address into the finance alert address", async () => {
    await expect(
        prisma.$transaction(
            async (tx) => {
                await tx.boardSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
                for (const column of NEW_COLUMNS) await tx.$executeRawUnsafe(`ALTER TABLE "BoardSettings" DROP COLUMN "${column}"`);
                await tx.$executeRawUnsafe(`UPDATE "BoardSettings" SET "alertEmailAddress" = 'alerts-mig@example.com' WHERE id = 1`);

                for (const stmt of migrationStatements()) await tx.$executeRawUnsafe(stmt);

                const rows = await tx.$queryRaw<Array<Record<string, string | null>>>`
                    SELECT "alertEmailAddress", "financeAlertEmailAddress", "sysadminEmailAddress", "bgReviewerEmailAddress"
                    FROM "BoardSettings" WHERE id = 1`;
                expect(rows).toEqual([{
                    alertEmailAddress: "alerts-mig@example.com",
                    financeAlertEmailAddress: "alerts-mig@example.com",
                    sysadminEmailAddress: null,
                    bgReviewerEmailAddress: null,
                }]);

                throw new Rollback();
            },
            { timeout: 20_000 },
        ),
    ).rejects.toBeInstanceOf(Rollback);
});
