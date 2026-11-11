/**
 * @jest-environment node
 */
/**
 * Flow test: the intake "Anything else we should know?" note reaches the
 * background-check reviewer's queue.
 *
 * This is the whole point of the field — a would-be volunteer-only household
 * types the note during intake, and the reviewer (who also sets the volunteer
 * bit) must actually see it. Drives the real journey over HTTP against a running
 * seeded dev server: applicant fills intake WITH the note, board records the two
 * external actions (whose consent opens a check review for the household), then
 * GET /api/membership/reviews returns the note on that review.
 *
 * Assumes a freshly-seeded DB. Uses parent.family3 (household3), a non-member
 * household seeded specifically so this suite's applicant is disjoint from the
 * other membership flow tests (parent.family / parent.family2) on the shared
 * serial DB. boardmember is a sysadmin+board account: it both records the
 * external actions and, as an implicit reviewer of another household, reads the
 * queue.
 */

import { loginAs, api, queuedReviewFor } from "./helpers";

const NOTE = "MAGIC: we're a volunteer-only household, no students enrolled — please mark us volunteer.";

type State = { process: { id: number; status: string } | null };

describe("flow: intake notes surface to the BG-review queue", () => {
    it("applicant's intake note comes back in GET /api/membership/reviews", async () => {
        const applicant = await loginAs("parent.family3@example.com"); // dedicated non-member household3 lead
        const reviewer = await loginAs("boardmember@example.com");      // sysadmin + board = implicit reviewer

        const start = await api(applicant, "/api/membership", { method: "POST" });
        expect([200, 201]).toContain(start.status);

        // Fill the minimum required intake PLUS the freeform note, then submit.
        const save = await api(applicant, "/api/membership/intake", {
            method: "PATCH",
            body: JSON.stringify({
                household: { line1: "789 Volunteer Way", city: "Austin", state: "TX", postalCode: "78701", emergencyContactName: "Pat Outside", emergencyContactPhone: "555-987-6543", notes: NOTE },
                primaryParent: { name: "Parent Family3" },
            }),
        });
        expect(save.status).toBe(200);

        const submit = await api(applicant, "/api/membership/intake/submit", { method: "POST" });
        expect(submit.status).toBe(200);

        const afterSubmit = await api<State>(applicant, "/api/membership");
        const processId = afterSubmit.json.process!.id;

        // Board records contract + BG consent → a check review opens for the household.
        await api(reviewer, "/api/membership-ops/applications/external", { method: "POST", body: JSON.stringify({ processId, action: "mark-contract" }) });
        await api(reviewer, "/api/membership-ops/applications/external", { method: "POST", body: JSON.stringify({ processId, action: "mark-bg-consent" }) });

        // The reviewer's queue must carry the applicant's note, unhidden.
        const row = await queuedReviewFor(reviewer, applicant.personaId);
        expect(row).toBeDefined();
        expect(row!.requestedForHousehold?.intakeNotes).toBe(NOTE);
    });
});
