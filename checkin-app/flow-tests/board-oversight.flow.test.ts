/**
 * @jest-environment node
 */
/**
 * Flow test for Board oversight, driven over HTTP against a running dev server with a fresh seed:
 * the Board reads its oversight views (compliance dashboard, households with no lead, lifecycle
 * drift, the open-applications queue), finds a family's unpaid application waiting there, and
 * closes it. The application then leaves the open queue and shows on the closed list; closing it
 * again changes nothing. A non-Board member is refused every view and the close, and their refused
 * close leaves the application open.
 *
 * Personas: boardmember@example.com (sysadmin + board), parent.family3@example.com (lead of the
 * non-member Family3 household, the applicant) and keyholder1@example.com (no Board role). The
 * compliance check reads the seeded Tool Certifier Household, an ACTIVE member whose lead has no check.
 */

import { loginAs, api, setBgRecheckMonths, type Session } from "./helpers";

type Application = {
    id: number;
    status: string;
    orgMembership: { household: { householdMembers: { id: number; isHouseholdLead: boolean }[] } } | null;
};

const OVERSIGHT_VIEWS = [
    "/api/membership-audit/compliance",
    "/api/admin/broken-households",
    "/api/system-status/lifecycle",
    "/api/membership-ops/applications",
    "/api/membership-ops/applications?archived=1",
];

describe("flow: Board oversight", () => {
    // First hit of each route compiles it under `next dev`, so the test outlasts the 20 s default.
    it("the Board reads its oversight views and closes an unpaid application; a non-Board member is refused", async () => {
        const board = await loginAs("boardmember@example.com");
        const applicant = await loginAs("parent.family3@example.com");
        const member = await loginAs("keyholder1@example.com");

        // The family starts and submits an application, which then waits on its external steps.
        const start = await api(applicant, "/api/membership", { method: "POST" });
        expect([200, 201]).toContain(start.status);
        const save = await api(applicant, "/api/membership/intake", {
            method: "PATCH",
            body: JSON.stringify({
                household: { line1: "789 Volunteer Way", city: "Austin", state: "TX", postalCode: "78701", emergencyContactName: "Pat Outside", emergencyContactPhone: "555-987-6543" },
                primaryParent: { name: "Parent Family3" },
            }),
        });
        expect(save.status).toBe(200);
        expect((await api(applicant, "/api/membership/intake/submit", { method: "POST" })).status).toBe(200);
        const own = await api<{ process: { id: number; status: string } | null }>(applicant, "/api/membership");
        expect(own.json.process?.status).toBe("PENDING_EXTERNAL_ACTION");
        const processId = own.json.process!.id;

        // The compliance dashboard answers with its household and person lists. With a check
        // window set, the seeded member household whose lead was never checked shows as stale.
        const restoreRecheck = await setBgRecheckMonths(board, 29);
        const compliance = await api<Record<string, unknown>>(board, "/api/membership-audit/compliance").finally(restoreRecheck);
        expect(compliance.status).toBe(200);
        for (const list of ["households", "peopleNeedingBgCheck", "peopleMissingDob", "peopleWithDisputedCheck", "positionHolders", "peopleAwaitingAgreement", "peopleFreeTimeWithoutAgreement"]) {
            expect(Array.isArray(compliance.json[list])).toBe(true);
        }
        expect(compliance.json.households).toContainEqual(expect.objectContaining({
            name: "Tool Certifier Household",
            reasons: expect.arrayContaining(["STALE_BG"]),
            leads: [expect.objectContaining({ name: "Tool Certifier" })],
        }));

        const broken = await api<{ households: unknown[] }>(board, "/api/admin/broken-households");
        expect(broken.status).toBe(200);
        expect(Array.isArray(broken.json.households)).toBe(true);

        const drift = await api<{ violations: unknown[]; scanned: number }>(board, "/api/system-status/lifecycle");
        expect(drift.status).toBe(200);
        expect(Array.isArray(drift.json.violations)).toBe(true);
        expect(drift.json.scanned).toBeGreaterThan(0);

        const applications = async (s: Session, archived = false) => {
            const res = await api<{ processes: Application[] }>(s, `/api/membership-ops/applications${archived ? "?archived=1" : ""}`);
            expect(res.status).toBe(200);
            return res.json.processes;
        };
        const inList = (list: Application[]) => list.find((p) => p.id === processId);

        // The family's application waits in the Board's open queue, with its household's leads.
        const queued = inList(await applications(board));
        expect(queued?.status).toBe("PENDING_EXTERNAL_ACTION");
        expect(queued?.orgMembership?.household.householdMembers).toContainEqual(expect.objectContaining({ id: applicant.personaId, isHouseholdLead: true }));
        expect(inList(await applications(board, true))).toBeUndefined();

        // A non-Board member is refused every oversight view.
        for (const path of OVERSIGHT_VIEWS) {
            expect({ path, status: (await api(member, path)).status }).toEqual({ path, status: 403 });
        }

        const close = (s: Session, id: number) =>
            api<{ outcome?: { status: string }; error?: string }>(s, "/api/membership-ops/applications/archive", { method: "POST", body: JSON.stringify({ processId: id }) });

        // A non-Board member cannot close it, and the application stays open.
        expect((await close(member, processId)).status).toBe(403);
        expect(inList(await applications(board))?.status).toBe("PENDING_EXTERNAL_ACTION");

        // Closing an application that does not exist is refused.
        expect((await close(board, 2_000_000_000)).status).toBe(404);

        // The Board closes the application.
        const closed = await close(board, processId);
        expect(closed.status).toBe(200);
        expect(closed.json.outcome).toEqual({ status: "ARCHIVED" });

        // It leaves the open queue and shows on the closed list.
        expect(inList(await applications(board))).toBeUndefined();
        expect(inList(await applications(board, true))?.status).toBe("ARCHIVED");

        // Closing it again changes nothing.
        const again = await close(board, processId);
        expect(again.status).toBe(200);
        expect(again.json.outcome).toEqual({ status: "ARCHIVED" });
        expect(inList(await applications(board, true))?.status).toBe("ARCHIVED");
    }, 60_000);
});
