/**
 * @jest-environment node
 */
/**
 * Flow test for annual membership renewal (CUJS A2), driven over HTTP against a running
 * dev server with a fresh seed.
 *
 * Journey: the board moves the membership-year boundary so today sits inside the renewal
 * window and opens renewals → the lead sees the renew-by banner and confirms → a fresh
 * agreement and background check are required (the lead has no check on file to count as
 * fresh) → the board's manual marks stand in for Zoho/Averity →
 * two reviewers clear the check → payment through the dev Shopify orders/paid stand-in
 * completes the renewal. The membership stays ACTIVE throughout, and a second "open
 * renewals" skips the household that just renewed.
 *
 * Not driven: the reminder email (the sweep never sends one; outreach is a separate
 * surface) and nonpayment grace/lapse (not built — CUJS A2 step 6).
 *
 * Personas: renewal.lead@example.com (lead of the seeded ACTIVE "Renewal Family"),
 * renewal.partner@example.com (non-lead adult in the same household),
 * boardmember@example.com and bg.reviewer@example.com (the two reviewers).
 *
 * Opening renewals is a global sweep: it also opens a renewal for every other ACTIVE
 * seeded household, and leaves those at PENDING_RENEWAL. The boundary is put back in
 * afterAll so the next file sees the seed's membership year.
 */

import { loginAs, api, type Session } from "./helpers";

type State = {
    membershipStatus: string | null;
    process: { id: number; kind: string; status: string } | null;
    external: { bgCleared: boolean } | null;
};
type RenewalStatus = { renewalDue: boolean; dueDate?: string | null };
type Settings = { settings: { BoardSettings: { orgMembershipYearBoundary: string | null } } };
type Sweep = { opened: number; skipped: number };
type ReviewQueue = {
    queue: { id: number; orgMembership: { household: { householdMembers: { id: number }[] } | null } | null }[];
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

describe("flow: annual membership renewal (CUJS A2)", () => {
    let board: Session;
    let originalBoundary: string | null = null;

    beforeAll(async () => {
        board = await loginAs("boardmember@example.com");
        const before = await api<Settings>(board, "/api/settings/membership");
        expect(before.status).toBe(200);
        originalBoundary = before.json.settings.BoardSettings.orgMembershipYearBoundary;
    });

    afterAll(async () => {
        await api(board, "/api/settings/membership", {
            method: "PUT",
            body: JSON.stringify({ orgMembershipYearBoundary: originalBoundary }),
        });
    });

    it("board opens renewals → lead confirms → agreement + BG review + payment → still ACTIVE, not reopened", async () => {
        const lead = await loginAs("renewal.lead@example.com");
        const partner = await loginAs("renewal.partner@example.com");
        const reviewer2 = await loginAs("bg.reviewer@example.com");

        const start = await api<State>(lead, "/api/membership");
        expect(start.json.membershipStatus).toBe("ACTIVE");
        expect(start.json.process).toBeNull();

        // Nothing to confirm before renewals open.
        expect((await api<RenewalStatus>(lead, "/api/membership/renewal-status")).json.renewalDue).toBe(false);
        expect((await api(lead, "/api/membership/renew", { method: "POST" })).status).toBe(409);

        // A boundary a month out puts today inside the two-month renewal window.
        const boundary = isoDay(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
        const put = await api(board, "/api/settings/membership", {
            method: "PUT",
            body: JSON.stringify({ orgMembershipYearBoundary: boundary }),
        });
        expect(put.status).toBe(200);

        const sweep = await api<Sweep>(board, "/api/settings/membership/bulk-open-renewals", { method: "POST" });
        expect(sweep.status).toBe(200);
        expect(sweep.json.opened).toBeGreaterThanOrEqual(1);

        // The lead sees the renew-by banner, due at the boundary; the non-lead does not.
        const banner = await api<RenewalStatus>(lead, "/api/membership/renewal-status");
        expect(banner.json).toEqual({ renewalDue: true, dueDate: boundary });
        expect((await api<RenewalStatus>(partner, "/api/membership/renewal-status")).json.renewalDue).toBe(false);

        const opened = await api<State>(lead, "/api/membership");
        expect(opened.json.membershipStatus).toBe("ACTIVE");
        expect(opened.json.process).toMatchObject({ kind: "RENEWAL", status: "PENDING_RENEWAL" });
        const processId = opened.json.process!.id;

        // Confirming is the lead's call.
        const refused = await api<{ code: string }>(partner, "/api/membership/renew", { method: "POST" });
        expect(refused.status).toBe(403);
        expect(refused.json.code).toBe("not_lead");

        // Confirming opens the same external step a new applicant gets: a fresh agreement,
        // and a new background check because the lead has no still-valid one.
        const renew = await api<{ process: { id: number; kind: string; status: string } }>(lead, "/api/membership/renew", { method: "POST" });
        expect(renew.status).toBe(200);
        expect(renew.json.process).toEqual({ id: processId, kind: "RENEWAL", status: "PENDING_EXTERNAL_ACTION" });

        const confirmed = await api<State>(lead, "/api/membership");
        expect(confirmed.json.membershipStatus).toBe("ACTIVE"); // stays active while renewing
        expect(confirmed.json.external?.bgCleared).toBe(false);

        // A second confirm finds nothing awaiting confirmation.
        expect((await api(lead, "/api/membership/renew", { method: "POST" })).status).toBe(409);

        // Board manual marks stand in for the Zoho signature and the Averity consent.
        for (const action of ["mark-contract", "mark-bg-consent"]) {
            const mark = await api(board, "/api/membership-ops/applications/external", {
                method: "POST",
                body: JSON.stringify({ processId, action }),
            });
            expect(mark.status).toBe(200);
        }
        expect((await api<State>(lead, "/api/membership")).json.process?.status).toBe("PENDING_PAYMENT");

        // Two distinct reviewers approve the check, both naming the same lead.
        const queue = await api<ReviewQueue>(board, "/api/membership/reviews");
        expect(queue.status).toBe(200);
        const queued = queue.json.queue.find((q) => q.id === processId);
        expect(queued).toBeDefined();
        const subjectPersonIds = [queued!.orgMembership!.household!.householdMembers[0].id];
        for (const reviewer of [board, reviewer2]) {
            const approve = await api(reviewer, "/api/membership/reviews", {
                method: "POST",
                body: JSON.stringify({ processId, result: "APPROVE", subjectPersonIds }),
            });
            expect(approve.status).toBe(200);
        }

        // Pay through the real orders/paid webhook (dev stand-in) → renewal completes.
        const pay = await api<{ status: string | null }>(lead, "/api/dev/shopify/orders-paid", {
            method: "POST",
            body: JSON.stringify({ processId }),
        });
        expect(pay.status).toBe(200);
        expect(pay.json.status).toBe("ACTIVE");

        const done = await api<State>(lead, "/api/membership");
        expect(done.json.membershipStatus).toBe("ACTIVE");
        expect(done.json.process).toBeNull();
        expect((await api<RenewalStatus>(lead, "/api/membership/renewal-status")).json.renewalDue).toBe(false);

        // Opening renewals again skips every household handled this cycle — no second bill.
        const again = await api<Sweep>(board, "/api/settings/membership/bulk-open-renewals", { method: "POST" });
        expect(again.status).toBe(200);
        expect(again.json.opened).toBe(0);
    });
});
