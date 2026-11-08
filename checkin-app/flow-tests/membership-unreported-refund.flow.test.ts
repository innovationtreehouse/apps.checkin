/**
 * @jest-environment node
 */
/**
 * A refund Shopify has made but not reported never activates a membership. The
 * orders/paid payload still says "paid" and the refund webhook has not arrived, so
 * only Shopify's own state can stop the activation. The local mock stands in for that
 * state (refundedInShopify on /api/dev/shopify/orders-paid).
 *
 * Reads PaymentException and resets its household over raw `pg`, as
 * membership-activation-fanout does, because the Board's item has no applicant-visible
 * trace. Needs DATABASE_URL.
 */

import { Pool } from "pg";
import { loginAs, api } from "./helpers";

type State = { process: { id: number; status: string } | null; membershipStatus: string | null };
type ReviewQueue = {
    queue: { id: number; orgMembership: { household: { householdMembers: { id: number }[] } | null } | null }[];
};

const APPLICANT_EMAIL = "parent.family@example.com";

const HOUSEHOLD_PROCESSES = `SELECT p.id FROM "OrgMembershipProcess" p
    JOIN "OrgMembership" m ON p."orgMembershipId" = m.id
    JOIN "Person" per ON per."householdId" = m."householdId" WHERE per.email = $1`;

async function resetApplicantHousehold(pool: Pool): Promise<void> {
    await pool.query(`DELETE FROM "PaymentException" WHERE "processId" IN (${HOUSEHOLD_PROCESSES})`, [APPLICANT_EMAIL]);
    await pool.query(`DELETE FROM "BackgroundCheckAttestation" WHERE "processId" IN (${HOUSEHOLD_PROCESSES})`, [APPLICANT_EMAIL]);
    await pool.query(`DELETE FROM "OrgMembershipProcess" WHERE id IN (${HOUSEHOLD_PROCESSES})`, [APPLICANT_EMAIL]);
    await pool.query(
        `DELETE FROM "OrgMembership" m USING "Person" per WHERE m."householdId" = per."householdId" AND per.email = $1`,
        [APPLICANT_EMAIL],
    );
    await pool.query(
        `UPDATE "Person" SET "lastBackgroundCheck" = NULL WHERE "householdId" = (SELECT "householdId" FROM "Person" WHERE email = $1)`,
        [APPLICANT_EMAIL],
    );
}

describe("flow: refund Shopify has not reported", () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    afterAll(async () => {
        await resetApplicantHousehold(pool);
        await pool.end();
    });

    it("the paid webhook after the refund and before the refund webhook does not activate, and the Board hears", async () => {
        await resetApplicantHousehold(pool);

        const applicant = await loginAs(APPLICANT_EMAIL);
        const board = await loginAs("boardmember@example.com");
        const reviewer2 = await loginAs("bg.reviewer@example.com");

        expect([200, 201]).toContain((await api(applicant, "/api/membership", { method: "POST" })).status);
        const save = await api(applicant, "/api/membership/intake", {
            method: "PATCH",
            body: JSON.stringify({
                household: { line1: "123 Maker Lane", city: "Austin", state: "TX", postalCode: "78701", emergencyContactName: "Pat Outside", emergencyContactPhone: "555-987-6543" },
                primaryParent: { name: "Parent Family" },
            }),
        });
        expect(save.status).toBe(200);
        expect((await api(applicant, "/api/membership/intake/submit", { method: "POST" })).status).toBe(200);

        const processId = (await api<State>(applicant, "/api/membership")).json.process!.id;
        for (const action of ["mark-contract", "mark-bg-consent"]) {
            const res = await api(board, "/api/membership-ops/applications/external", { method: "POST", body: JSON.stringify({ processId, action }) });
            expect(res.status).toBe(200);
        }

        const queue = await api<ReviewQueue>(board, "/api/membership/reviews");
        const leadIds = (queue.json.queue.find((q) => q.id === processId)?.orgMembership?.household?.householdMembers ?? []).map((p) => p.id);
        expect(leadIds.length).toBeGreaterThan(0);
        const review = { processId, result: "APPROVE", subjectPersonIds: [leadIds[0]] };
        expect((await api(board, "/api/membership/reviews", { method: "POST", body: JSON.stringify(review) })).status).toBe(200);
        expect((await api(reviewer2, "/api/membership/reviews", { method: "POST", body: JSON.stringify(review) })).status).toBe(200);

        const pay = await api<{ ok: boolean; status: string | null }>(applicant, "/api/dev/shopify/orders-paid", {
            method: "POST",
            body: JSON.stringify({ processId, refundedInShopify: true }),
        });
        expect(pay.status).toBe(200);
        expect(pay.json.status).toBe("PENDING_PAYMENT");

        const after = await api<State>(applicant, "/api/membership");
        expect(after.json.membershipStatus).not.toBe("ACTIVE");

        const { rows } = await pool.query(
            `SELECT severity FROM "PaymentException" WHERE "processId" = $1 AND kind = 'REVERSED_BEFORE_ACTIVATION'`,
            [processId],
        );
        expect(rows).toEqual([{ severity: "CRITICAL" }]);
    });
});
