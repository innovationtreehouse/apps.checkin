/**
 * @jest-environment node
 */
/**
 * Flow test for the membership post-payment activation fan-out.
 *
 * Drives the full applicant journey over HTTP against a running dev server with a
 * fresh seed, all the way to an ACTIVE household membership, and proves the two
 * things activation must do end-to-end:
 *   1. The membership + its process both reach ACTIVE (not parked at
 *      PENDING_PAYMENT / PENDING_BG_CLEARANCE).
 *   2. Exactly ONE "congrats, your membership is active" email is sent to the
 *      household lead — never zero (activation silently stopped) and never two
 *      (double fan-out). payment.ts › activate() calls sendCongrats exactly once,
 *      on the single INACTIVE→ACTIVE transition.
 *
 * The pay step fires the REAL inbound Shopify orders/paid webhook via the local
 * dev stand-in (/api/dev/shopify/orders-paid → activateByProcessId, payment.ts:240),
 * so this exercises the exact production activation path, HMAC-verify included.
 *
 * To reach ACTIVE the moment payment lands, the background check must already be
 * cleared: intake → external actions → two distinct reviewers approve (clears BG,
 * holds at PENDING_PAYMENT) → pay → ACTIVE.
 *
 * Persona / isolation note: uses parent.family (household1) as the applicant. Only two
 * seeded personas are household leads (parent.family, parent.family2) and BOTH are already
 * claimed by sibling flow tests (membership-self-attest uses parent.family; membership-
 * bg-nonblocking uses parent.family2). Those siblings coexist only because neither drives
 * its household to a terminal ACTIVE membership — this test does, and an ACTIVE household
 * makes startIntake reject the next application with 409 already_member. So this test
 * resets its applicant's household back to the pristine no-membership state (see
 * resetApplicantHousehold) both before it runs (order-independence) and in afterAll (so a
 * sibling that runs next sees a clean household). The reset is scoped by lead email and
 * touches only that household; the flow runner is --runInBand, so each file's afterAll
 * completes before the next file starts.
 *
 * Emails are captured to the DevSentEmail table (no RESEND_API_KEY in the flow env,
 * so sendEmail records instead of delivering) and asserted straight off that table.
 * (Scraping the /dev/sent-mail HTML page is not a usable oracle: one email row renders
 * 2–3 times across the SSR DOM + the RSC Flight payload, so an occurrence count can't
 * tell one send from a double.) The table is cleared at the top so the count is
 * deterministic and re-run-safe.
 *
 * DB access note: flow tests normally talk HTTP only. This one reads the capture table
 * directly with a raw `pg` pool — NOT the prisma client, whose Prisma-7 WASM query
 * compiler is ESM the flow jest config can't load. It needs DATABASE_URL, which the
 * standalone runner (docker-compose.flow.yml) sets; against a hand-started server,
 * export the same DATABASE_URL in the shell running jest.
 *
 * The OTHER fan-out items an activation could eventually trigger — mailing-list add,
 * badge-print queue, and the 18+ background-check trigger — do NOT exist yet and are
 * deliberately NOT asserted here (tracked as Q4/Q6/Q7). Add assertions when they land.
 */

import { Pool } from "pg";
import { loginAs, api } from "./helpers";

type State = { process: { id: number; status: string } | null; membershipStatus: string | null };
// The reviewer queue, narrowed to what this test needs: the household leads a
// reviewer picks from when naming whose background check they reviewed.
type ReviewQueue = {
    queue: { id: number; orgMembership: { household: { householdMembers: { id: number }[] } | null } | null }[];
};

// payment.ts › sendCongrats — the one and only activation email, in its INITIAL
// wording (this journey activates a brand-new membership; a RENEWAL is thanked for
// renewing instead). Kept in sync by hand; if the copy changes, this literal must
// change with it (that's the point — it pins the send).
const CONGRATS_SUBJECT = "Welcome to the Treehouse — your membership is active!";
const APPLICANT_EMAIL = "parent.family@example.com";

/**
 * Restore the applicant's household to the pristine, no-membership state the seed leaves it
 * in (household1 has no OrgMembership row initially). Deletes child rows first (no FK cascade
 * on the membership graph) and clears the guardians' background-check stamp, all scoped to the
 * lead's household. Idempotent — safe to run when there is nothing to clean up.
 */
async function resetApplicantHousehold(pool: Pool): Promise<void> {
    await pool.query(
        `DELETE FROM "BackgroundCheckAttestation" a
         USING "OrgMembershipProcess" p, "OrgMembership" m, "Person" per
         WHERE a."processId" = p.id AND p."orgMembershipId" = m.id
           AND m."householdId" = per."householdId" AND per.email = $1`,
        [APPLICANT_EMAIL],
    );
    await pool.query(
        `DELETE FROM "OrgMembershipProcess" p
         USING "OrgMembership" m, "Person" per
         WHERE p."orgMembershipId" = m.id AND m."householdId" = per."householdId" AND per.email = $1`,
        [APPLICANT_EMAIL],
    );
    await pool.query(
        `DELETE FROM "OrgMembership" m
         USING "Person" per
         WHERE m."householdId" = per."householdId" AND per.email = $1`,
        [APPLICANT_EMAIL],
    );
    await pool.query(
        `UPDATE "Person" SET "lastBackgroundCheck" = NULL
         WHERE "householdId" = (SELECT "householdId" FROM "Person" WHERE email = $1)`,
        [APPLICANT_EMAIL],
    );
}

describe("flow: membership post-payment activation fan-out", () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    afterAll(async () => {
        // Leave a clean household so a sibling flow test that runs after this file sees a
        // non-member lead (this test activates it, which would 409 their startIntake).
        await resetApplicantHousehold(pool);
        await pool.end();
    });

    it("intake → external → BG cleared → pay reaches ACTIVE and sends exactly one congrats email", async () => {
        // Deterministic capture assertion: start from an empty inbox so a stray earlier
        // congrats (e.g. a prior run against a not-reseeded DB) can't mask a double-send.
        await pool.query('DELETE FROM "DevSentEmail"');
        // Order-independence: clear any membership a sibling left on this household before we drive it.
        await resetApplicantHousehold(pool);

        const applicant = await loginAs(APPLICANT_EMAIL);          // non-member household lead (household1)
        const board = await loginAs("boardmember@example.com");    // sysadmin + board (implicit BG reviewer)
        const reviewer2 = await loginAs("bg.reviewer@example.com"); // second, distinct-household BG reviewer

        // Start the application (201 new, or 200 if one is already in flight on a re-run).
        const start = await api(applicant, "/api/membership", { method: "POST" });
        expect([200, 201]).toContain(start.status);

        // Minimum required intake, then submit → PENDING_EXTERNAL_ACTION.
        const save = await api(applicant, "/api/membership/intake", {
            method: "PATCH",
            body: JSON.stringify({
                household: { line1: "123 Maker Lane", city: "Austin", state: "TX", postalCode: "78701", emergencyContactName: "Pat Outside", emergencyContactPhone: "555-987-6543" },
                primaryParent: { name: "Parent Family" },
            }),
        });
        expect(save.status).toBe(200);

        const submit = await api(applicant, "/api/membership/intake/submit", { method: "POST" });
        expect(submit.status).toBe(200);

        const afterSubmit = await api<State>(applicant, "/api/membership");
        expect(afterSubmit.json.process?.status).toBe("PENDING_EXTERNAL_ACTION");
        const processId = afterSubmit.json.process!.id;

        // Board records the contract + background-check consent (manual fallbacks) → PENDING_PAYMENT.
        const c1 = await api(board, "/api/membership-ops/applications/external", { method: "POST", body: JSON.stringify({ processId, action: "mark-contract" }) });
        expect(c1.status).toBe(200);
        const c2 = await api(board, "/api/membership-ops/applications/external", { method: "POST", body: JSON.stringify({ processId, action: "mark-bg-consent" }) });
        expect(c2.status).toBe(200);

        const afterExternal = await api<State>(applicant, "/api/membership");
        expect(afterExternal.json.process?.status).toBe("PENDING_PAYMENT");

        // A check is recorded against a NAMED adult, so a reviewer must say whose report
        // they read. The queue GET is where a real reviewer gets those ids, so read them
        // the same way rather than reaching into the DB.
        const queue = await api<ReviewQueue>(board, "/api/membership/reviews");
        expect(queue.status).toBe(200);
        const queued = queue.json.queue.find((q) => q.id === processId);
        expect(queued).toBeDefined();
        const leadIds = (queued!.orgMembership?.household?.householdMembers ?? []).map((p) => p.id);
        expect(leadIds.length).toBeGreaterThan(0);
        // A review covers ONE adult, and the first approval settles which — so both
        // reviewers name the same person.
        const subjectPersonIds = [leadIds[0]];

        // Two DISTINCT reviewers approve the background check, both naming the same adult.
        // The second approval on a named adult clears it; unpaid, so it stays at
        // PENDING_PAYMENT (bgClearedAt now set) — payment will activate.
        const a1 = await api(board, "/api/membership/reviews", { method: "POST", body: JSON.stringify({ processId, result: "APPROVE", subjectPersonIds }) });
        expect(a1.status).toBe(200);
        const a2 = await api(reviewer2, "/api/membership/reviews", { method: "POST", body: JSON.stringify({ processId, result: "APPROVE", subjectPersonIds }) });
        expect(a2.status).toBe(200);

        const afterBg = await api<State>(applicant, "/api/membership");
        expect(afterBg.json.process?.status).toBe("PENDING_PAYMENT"); // BG cleared, still awaiting payment

        // Pay: fire the real inbound Shopify orders/paid webhook (dev stand-in) →
        // activateByProcessId → activate() flips ACTIVE (BG already cleared) + sendCongrats.
        const pay = await api<{ ok: boolean; status: string | null }>(
            applicant,
            "/api/dev/shopify/orders-paid",
            { method: "POST", body: JSON.stringify({ processId }) },
        );
        expect(pay.status).toBe(200);
        // The process row itself resolved to ACTIVE (read straight from the process by the
        // webhook stand-in) — proves it is no longer parked at PENDING_PAYMENT / PENDING_BG_CLEARANCE.
        expect(pay.json.status).toBe("ACTIVE");

        // Membership is ACTIVE, and there is no longer an in-flight process (getIntakeState
        // surfaces only non-ACTIVE processes, so an activated application drops out → null).
        const afterPay = await api<State>(applicant, "/api/membership");
        expect(afterPay.json.membershipStatus).toBe("ACTIVE");
        expect(afterPay.json.process).toBeNull();

        // Exactly one congrats email was captured, addressed to the household lead.
        // Zero → activation stopped short of sendCongrats; two → double fan-out.
        const { rows: congrats } = await pool.query('SELECT "to" FROM "DevSentEmail" WHERE subject = $1', [CONGRATS_SUBJECT]);
        expect(congrats).toHaveLength(1);
        expect(congrats[0].to).toBe(APPLICANT_EMAIL);
    });
});
