/**
 * @jest-environment node
 */
/**
 * Flow test for applicant-self-attested background-check consent.
 *
 * The applicant self-attests ("I submitted my consent on Averity") through
 * POST /api/membership/bg-consent, and — once the contract is signed — advances to
 * PENDING_PAYMENT with no board action in the middle of the sitting. The board's
 * mark-bg-consent is a backstop; the two-reviewer check runs in parallel with payment.
 *
 * Assumes a freshly-seeded DB (parent.family is a non-member household lead; the
 * bg-nonblocking flow test uses the separate parent.family2 household).
 */

import { loginAs, api } from "./helpers";

type State = {
    process: { id: number; status: string } | null;
    external: { bgConsented: boolean; contractSigned: boolean } | null;
};

describe("flow: applicant self-attests background-check consent (#875)", () => {
    it("intake → self-attest + contract → PENDING_PAYMENT with no board consent-mark", async () => {
        const applicant = await loginAs("parent.family@example.com"); // non-member household lead
        const board = await loginAs("boardmember@example.com");       // sysadmin + board

        // Start the application (201 new, or 200 if one is already in flight).
        const start = await api(applicant, "/api/membership", { method: "POST" });
        expect([200, 201]).toContain(start.status);

        // Fill the minimum required intake, then submit → PENDING_EXTERNAL_ACTION.
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

        // The applicant self-attests consent. Contract still unsigned → consent is
        // recorded but the application does not advance yet.
        const attest = await api(applicant, "/api/membership/bg-consent", { method: "POST" });
        expect(attest.status).toBe(200);

        const midway = await api<State>(applicant, "/api/membership");
        expect(midway.json.process?.status).toBe("PENDING_EXTERNAL_ACTION");
        expect(midway.json.external?.bgConsented).toBe(true);

        // The contract lands (board manual mark stands in for the Zoho webhook) →
        // both external actions are done and the application advances on its own.
        const mark = await api(board, "/api/membership-ops/applications/external", {
            method: "POST",
            body: JSON.stringify({ processId, action: "mark-contract" }),
        });
        expect(mark.status).toBe(200);

        const afterExternal = await api<State>(applicant, "/api/membership");
        expect(afterExternal.json.process?.status).toBe("PENDING_PAYMENT"); // ← no board consent-mark needed
    });

    it("409s a self-attest when no application is awaiting external action", async () => {
        const board = await loginAs("boardmember@example.com"); // no in-flight application
        const res = await api(board, "/api/membership/bg-consent", { method: "POST" });
        expect(res.status).toBe(409);
    });
});
