/**
 * @jest-environment node
 */
/**
 * Flow test for PR #428 — the background check is non-blocking.
 *
 * Drives the real user journey over HTTP against a running dev server with a
 * fresh seed: a non-member applicant fills intake, the board records the two
 * external actions, and the applicant pays before the check has cleared.
 *
 * Asserts the two behaviours the PR introduced end-to-end:
 *   1. After the external step the application is at PENDING_PAYMENT — payment is
 *      unblocked (pre-PR it parked at PENDING_BG_REVIEW until reviewers cleared it).
 *   2. Paying before the check clears holds at PENDING_BG_CLEARANCE with the
 *      membership still inactive (never ACTIVE without a valid check).
 *
 * Assumes a freshly-seeded DB (parent.family2 is a non-member household lead).
 */

import { loginAs, api } from "./helpers";

type State = { process: { id: number; status: string } | null; membershipStatus: string | null };

describe("flow: membership background check is non-blocking (PR #428)", () => {
    it("intake → external → PENDING_PAYMENT, and paying before BG clears holds inactive", async () => {
        const applicant = await loginAs("parent.family2@example.com"); // non-member household lead
        const board = await loginAs("boardmember@example.com");        // sysadmin + board

        // Start the application (201 new, or 200 if one is already in flight).
        const start = await api(applicant, "/api/membership", { method: "POST" });
        expect([200, 201]).toContain(start.status);

        // Fill the minimum required intake, then submit → PENDING_EXTERNAL_ACTION.
        const save = await api(applicant, "/api/membership/intake", {
            method: "PATCH",
            body: JSON.stringify({
                household: { line1: "456 Workshop Drive", city: "Austin", state: "TX", postalCode: "78701", emergencyContactName: "Pat Outside", emergencyContactPhone: "555-987-6543" },
                primaryParent: { name: "Parent Family2" },
            }),
        });
        expect(save.status).toBe(200);

        const submit = await api(applicant, "/api/membership/intake/submit", { method: "POST" });
        expect(submit.status).toBe(200);

        const afterSubmit = await api<State>(applicant, "/api/membership");
        expect(afterSubmit.json.process?.status).toBe("PENDING_EXTERNAL_ACTION");
        const processId = afterSubmit.json.process!.id;

        // Board records the contract + background-check consent (manual fallbacks,
        // no Zoho/Averity needed). Pre-#428 this advanced to PENDING_BG_REVIEW.
        const c1 = await api(board, "/api/membership-ops/applications/external", { method: "POST", body: JSON.stringify({ processId, action: "mark-contract" }) });
        expect(c1.status).toBe(200);
        const c2 = await api(board, "/api/membership-ops/applications/external", { method: "POST", body: JSON.stringify({ processId, action: "mark-bg-consent" }) });
        expect(c2.status).toBe(200);

        const afterExternal = await api<State>(applicant, "/api/membership");
        expect(afterExternal.json.process?.status).toBe("PENDING_PAYMENT");

        // Pay before the check clears (board certify stands in for the Shopify webhook).
        const certify = await api(board, "/api/membership-ops/applications/certify-payment", { method: "POST", body: JSON.stringify({ processId, reason: "flow test: payment plan certified" }) });
        expect(certify.status).toBe(200);

        const afterPay = await api<State>(applicant, "/api/membership");
        expect(afterPay.json.process?.status).toBe("PENDING_BG_CLEARANCE");
        expect(afterPay.json.membershipStatus).not.toBe("ACTIVE");
    });
});
