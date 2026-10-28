/**
 * @jest-environment node
 */
/**
 * Flow test: the intake "Anything else we should know?" note reaches the
 * Board's review queue.
 *
 * A would-be volunteer-only household types the note during intake, and the
 * Board (the only role that reads it) must actually see it. Drives the real journey over HTTP against a running
 * seeded dev server: applicant fills intake WITH the note, board records the two
 * external actions (which puts the application into the parallel BG-review
 * track), then GET /api/membership/reviews returns the note on that row.
 *
 * Assumes a freshly-seeded DB. Uses parent.family3 (household3), a non-member
 * household seeded specifically so this suite's applicant is disjoint from the
 * other membership flow tests (parent.family / parent.family2) on the shared
 * serial DB. boardmember is a sysadmin+board account: it both records the
 * external actions and, as an implicit reviewer of another household, reads the
 * queue.
 */

import { loginAs, api } from "./helpers";

const NOTE = "MAGIC: we're a volunteer-only household, no students enrolled — please mark us volunteer.";

type State = { process: { id: number; status: string } | null };
type QueueRow = { id: number; orgMembership: { household: { name: string | null; intakeNotes: string | null } | null } | null };
type Reviews = { queue: QueueRow[] };

describe("flow: intake notes surface to the Board's review queue", () => {
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

        // Board records contract + BG consent → application enters the BG-review track.
        await api(reviewer, "/api/membership-ops/applications/external", { method: "POST", body: JSON.stringify({ processId, action: "mark-contract" }) });
        await api(reviewer, "/api/membership-ops/applications/external", { method: "POST", body: JSON.stringify({ processId, action: "mark-bg-consent" }) });

        // The Board's queue must carry the applicant's note, unhidden.
        const reviews = await api<Reviews>(reviewer, "/api/membership/reviews");
        expect(reviews.status).toBe(200);
        const row = reviews.json.queue.find((r) => r.id === processId);
        expect(row).toBeDefined();
        expect(row!.orgMembership?.household?.intakeNotes).toBe(NOTE);
    });
});
