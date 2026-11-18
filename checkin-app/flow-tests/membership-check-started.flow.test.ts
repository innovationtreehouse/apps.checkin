/**
 * @jest-environment node
 */
/**
 * Flow test for marking a background check started from /membership.
 *
 * A household lead marks their own check started through
 * POST /api/membership/check-started while the agreement is still unsigned, and —
 * once the contract is signed — the application advances to PENDING_PAYMENT with
 * no board action on the check. The two-reviewer check runs in parallel with payment.
 *
 * Assumes a freshly-seeded DB (parent.family is a non-member household lead; the
 * bg-nonblocking flow test uses the separate parent.family2 household).
 */

import { loginAs, api } from "./helpers";

type State = {
    process: { id: number; status: string } | null;
    external: { checkStarted: boolean; contractSigned: boolean } | null;
};
type Rows = { rows: { personId: number; name: string | null; state: string }[] };

describe("flow: a lead marks their check started", () => {
    it("intake → own check marked + contract → PENDING_PAYMENT with no board check-mark", async () => {
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

        // The lead's own row needs marking, and carries nothing but personId, name and state.
        const before = await api<Rows>(applicant, "/api/membership/check-started");
        expect(before.status).toBe(200);
        const own = before.json.rows.find((r) => r.personId === applicant.personaId);
        expect(own?.state).toBe("NEEDS_MARKING");
        for (const row of before.json.rows) expect(Object.keys(row).sort()).toEqual(["name", "personId", "state"]);

        // The lead marks their check started. Contract still unsigned → the check is
        // started but the application does not advance yet.
        const mark = await api<Rows>(applicant, "/api/membership/check-started", { method: "POST", body: JSON.stringify({ personId: applicant.personaId }) });
        expect(mark.status).toBe(200);
        expect(mark.json.rows.find((r) => r.personId === applicant.personaId)?.state).toBe("NOTHING_TO_DO");

        const midway = await api<State>(applicant, "/api/membership");
        expect(midway.json.process?.status).toBe("PENDING_EXTERNAL_ACTION");
        expect(midway.json.external?.checkStarted).toBe(true);

        // The contract lands (board manual mark stands in for the Zoho webhook) →
        // both external actions are done and the application advances on its own.
        const signed = await api(board, "/api/membership-ops/applications/external", {
            method: "POST",
            body: JSON.stringify({ processId, action: "mark-contract" }),
        });
        expect(signed.status).toBe(200);

        const afterExternal = await api<State>(applicant, "/api/membership");
        expect(afterExternal.json.process?.status).toBe("PENDING_PAYMENT"); // ← no board check-mark needed
    });

    it("refuses to mark someone outside the caller's household", async () => {
        const applicant = await loginAs("parent.family@example.com");
        const board = await loginAs("boardmember@example.com");
        const res = await api(applicant, "/api/membership/check-started", { method: "POST", body: JSON.stringify({ personId: board.personaId }) });
        expect(res.status).toBe(403);
    });

    it("the household self-report route is gone", async () => {
        const board = await loginAs("boardmember@example.com");
        const res = await api(board, "/api/membership/bg-consent", { method: "POST" });
        expect(res.status).toBe(404);
    });
});
