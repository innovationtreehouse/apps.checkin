/**
 * @jest-environment node
 *
 * Self-correction of own visits (AT5, #1256) and a household lead's correction
 * of a member's (AT3, #1254): PATCH edits times, DELETE tombstones. The
 * invariants under test: scope is the only gate (404 on out-of-scope/tombstoned
 * — no existence oracle), validity checks reject bad times, the write is
 * audited with type "self_correction" + significance, a significant change
 * emails the board, a delete never removes the row, closing an open visit
 * routes through processVisitCheckout, and every lock/where keys on the visit's
 * PERSON (not the actor) so a lead's write serializes against the member's kiosk.
 *
 * Both verbs go through @/security/handler, so the registered policy is what
 * shapes the response: PATCH returns the `visit` envelope stripped to the
 * registry's their_own/led_households:personal grant, DELETE ships no model
 * data at all.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { processVisitCheckout } from "@/lib/attendanceTransitions";
import { emailBoardMembers } from "@/lib/emailRecipients";
import { visitSubject } from "@/lib/visit/scope";
import { PATCH, DELETE } from "@/app/api/attendance/manual/[id]/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/verify-kiosk", () => ({
    getKioskPublicKeys: jest.fn().mockReturnValue([]),
    verifyKioskSignature: jest.fn().mockReturnValue({ ok: false }),
}));
jest.mock("@/lib/attendanceTransitions", () => ({ processVisitCheckout: jest.fn().mockResolvedValue([]) }));
jest.mock("@/lib/emailRecipients", () => ({ emailBoardMembers: jest.fn().mockResolvedValue(undefined) }));
// Scope resolution is exercised in lib/visit/__tests__/scope.test.ts; here the
// default stands in for "self only", and the household-lead cases override it.
jest.mock("@/lib/visit/scope", () => ({ visitSubject: jest.fn() }));

const tx = {
    $executeRaw: jest.fn(),
    visit: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        visit: { findUnique: jest.fn(), update: jest.fn() },
        auditLog: { create: jest.fn() },
        // buildCallerContext reads the led-household roster (the route's only
        // ctxNeeds prefetch) to resolve led_households.
        person: { findUnique: jest.fn(), findMany: jest.fn() },
        $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    },
}));

const mockSession = getServerSession as jest.Mock;
const visitFindUnique = prisma.visit.findUnique as jest.Mock;
const auditCreate = prisma.auditLog.create as jest.Mock;
const personFindUnique = prisma.person.findUnique as jest.Mock;
const personFindMany = prisma.person.findMany as jest.Mock;

const OWN_ID = 7;
const MEMBER_ID = 8; // a household member the actor leads
const HOUSEHOLD_ID = 2;
// Every column a real `visit.update` returns, tombstone fields included — the
// stripper only drops fields the row actually carries.
const baseVisit = {
    id: 42, personId: OWN_ID, deletedAt: null, deletedById: null, associatedEventId: null,
    arrivedAt: new Date("2026-07-20T14:00:00Z"), departedAt: new Date("2026-07-20T16:00:00Z"),
    arrivedVia: "WEB", departedVia: "WEB", forceCloseWarnedAt: null, forceCloseToken: null,
};

function req(method: string, body?: unknown): NextRequest {
    return new Request("http://localhost/api/attendance/manual/42", {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: "42" }) };

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: OWN_ID } });
    (visitSubject as jest.Mock).mockImplementation(async (actorId: number, subjectId: number) =>
        actorId === subjectId ? { id: subjectId, isKeyholder: false } : null);
    tx.visit.findFirst.mockResolvedValue({ id: 42 });
    tx.visit.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ ...baseVisit, ...args.data }));
    tx.visit.updateMany.mockResolvedValue({ count: 1 });
    (processVisitCheckout as jest.Mock).mockResolvedValue([{ ...baseVisit }]);
    auditCreate.mockResolvedValue({});
    personFindUnique.mockResolvedValue({ isKeyholder: false });
    personFindMany.mockResolvedValue([]); // not a household lead unless a test says so
});

describe("PATCH /api/attendance/manual/[id]", () => {
    it("401s an unauthenticated caller", async () => {
        mockSession.mockResolvedValue(null);
        const res = await PATCH(req("PATCH", { arrivedAt: new Date().toISOString() }), ctx as never);
        expect(res.status).toBe(401);
    });

    it("404s someone else's visit and a tombstoned visit alike", async () => {
        visitFindUnique.mockResolvedValueOnce({ ...baseVisit, personId: 99 });
        expect((await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:05:00Z" }), ctx as never)).status).toBe(404);

        visitFindUnique.mockResolvedValueOnce({ ...baseVisit, deletedAt: new Date() });
        expect((await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:05:00Z" }), ctx as never)).status).toBe(404);
        expect(tx.visit.update).not.toHaveBeenCalled();
    });

    it("400s a malformed JSON body instead of 500ing", async () => {
        const bad = new Request("http://localhost/api/attendance/manual/42", {
            method: "PATCH", headers: { "content-type": "application/json" }, body: "{oops",
        }) as unknown as NextRequest;
        expect((await PATCH(bad, ctx as never)).status).toBe(400);
    });

    it("404s when the visit is tombstoned between the pre-check and the lock", async () => {
        visitFindUnique.mockResolvedValue(baseVisit);
        tx.visit.findFirst.mockResolvedValue(null); // a DELETE won the race
        const res = await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:05:00Z" }), ctx as never);
        expect(res.status).toBe(404);
        expect(tx.visit.update).not.toHaveBeenCalled();
        expect(auditCreate).not.toHaveBeenCalled();
    });

    it("rejects a departure before the arrival", async () => {
        visitFindUnique.mockResolvedValue(baseVisit);
        const res = await PATCH(req("PATCH", { departedAt: "2026-07-20T13:00:00Z" }), ctx as never);
        expect(res.status).toBe(400);
    });

    it("applies a small edit unflagged: WEB sources, audit row, no board email", async () => {
        visitFindUnique.mockResolvedValue(baseVisit);
        const res = await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:05:00Z" }), ctx as never);

        expect(res.status).toBe(200);
        // A corrected arrival becomes a typed clock (arrivedVia TYPED). The
        // edit's own significance already read the pre-edit source, so this only
        // sets what the NEXT correction overwrites.
        expect(tx.visit.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { arrivedAt: new Date("2026-07-20T14:05:00Z"), arrivedVia: "TYPED" },
        }));
        const audit = auditCreate.mock.calls[0][0].data;
        expect(audit).toMatchObject({
            action: "EDIT", tableName: "Visit", affectedEntityId: 42,
            actorId: OWN_ID, secondaryAffectedEntity: OWN_ID,
        });
        expect(audit.newData.type).toBe("self_correction");
        expect(audit.newData.significance.flagged).toBe(false);
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });

    // The bug this fixes: a corrected arrival must be restamped to the current
    // typed-form source (TYPED), so a SECOND correction of the same time is
    // weighed as overwriting a self-report, not the original measurement
    // (docs/rules/attendance-checkin.md, visit-record). The edit's own
    // significance was already computed from the pre-edit source above the update.
    it("restamps a corrected arrival's source to TYPED", async () => {
        const leadMarked = { ...baseVisit, arrivedVia: "LEAD_MARKED", departedVia: "LEAD_MARKED" };
        visitFindUnique.mockResolvedValue(leadMarked);
        // A real update returns the row's untouched columns as-is, not a static
        // fixture's default — the mock has to reflect that to catch this bug.
        tx.visit.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ ...leadMarked, ...args.data }));
        const res = await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:05:00Z" }), ctx as never);

        expect(res.status).toBe(200);
        expect(tx.visit.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { arrivedAt: new Date("2026-07-20T14:05:00Z"), arrivedVia: "TYPED" },
        }));
        const { visit } = await res.json();
        expect(visit.arrivedVia).toBe("TYPED");
    });

    it("still restamps departedVia to TYPED on a departure correction (an edited departure is a self-report)", async () => {
        visitFindUnique.mockResolvedValue({ ...baseVisit, arrivedVia: "LEAD_MARKED", departedVia: "LEAD_MARKED" });
        const res = await PATCH(req("PATCH", { departedAt: "2026-07-20T16:30:00Z" }), ctx as never);

        expect(res.status).toBe(200);
        expect(tx.visit.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { departedAt: new Date("2026-07-20T16:30:00Z"), departedVia: "TYPED" },
        }));
    });

    it("flags a big move of a measured (SCANNER) arrival to the board", async () => {
        visitFindUnique.mockResolvedValue({ ...baseVisit, arrivedVia: "SCANNER", departedVia: "SCANNER" });
        const res = await PATCH(req("PATCH", { arrivedAt: "2026-07-20T12:00:00Z" }), ctx as never);

        expect(res.status).toBe(200);
        expect(emailBoardMembers).toHaveBeenCalledTimes(1);
    });

    it("escapes the actor's self-editable name in the board email", async () => {
        mockSession.mockResolvedValue({ user: { id: OWN_ID, name: '<a href="http://evil">Pay dues here</a>' } });
        visitFindUnique.mockResolvedValue({ ...baseVisit, arrivedVia: "SCANNER", departedVia: "SCANNER" });
        await PATCH(req("PATCH", { arrivedAt: "2026-07-20T12:00:00Z" }), ctx as never);

        const html = (emailBoardMembers as jest.Mock).mock.calls[0][1];
        expect(html).not.toContain("<a href");
        expect(html).toContain("&lt;a href=&quot;http://evil&quot;&gt;");
    });

    it("never reopens a closed visit", async () => {
        visitFindUnique.mockResolvedValue(baseVisit);
        const res = await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:05:00Z", departedAt: "" }), ctx as never);
        expect(res.status).toBe(200); // absent departedAt = keep the existing one
        expect(tx.visit.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.not.objectContaining({ departedAt: expect.anything() }),
        }));
    });

    it("closing an open visit goes through processVisitCheckout, not a bare update", async () => {
        visitFindUnique.mockResolvedValue({ ...baseVisit, departedAt: null, departedVia: null });
        const res = await PATCH(req("PATCH", { departedAt: "2026-07-20T17:00:00Z" }), ctx as never);

        expect(res.status).toBe(200);
        expect(processVisitCheckout).toHaveBeenCalledWith(42, new Date("2026-07-20T17:00:00Z"), undefined, "TYPED");
        // The lock-scoped update must not have closed it first.
        expect(tx.visit.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.not.objectContaining({ departedAt: expect.anything() }),
        }));
        // Routine close of one's own open visit is not board-worthy.
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });

    // Chunking hard-deletes the original row and recreates per-event segments,
    // so an audit row naming the original id would point at nothing.
    it("audits and returns a surviving chunk when the close splits the visit", async () => {
        visitFindUnique.mockResolvedValue({ ...baseVisit, departedAt: null, departedVia: null });
        (processVisitCheckout as jest.Mock).mockResolvedValue([
            { ...baseVisit, id: 101 },
            { ...baseVisit, id: 102 },
        ]);

        const res = await PATCH(req("PATCH", { departedAt: "2026-07-20T17:00:00Z" }), ctx as never);

        expect((await res.json()).visit.id).toBe(102);
        const audit = auditCreate.mock.calls[0][0].data;
        expect(audit.affectedEntityId).toBe(102);
        expect(audit.oldData.id).toBe(42); // the replaced row stays traceable
    });

    it("404s a close that lost the race (checkout applied nothing)", async () => {
        visitFindUnique.mockResolvedValue({ ...baseVisit, departedAt: null, departedVia: null });
        (processVisitCheckout as jest.Mock).mockResolvedValue([]);

        const res = await PATCH(req("PATCH", { departedAt: "2026-07-20T17:00:00Z" }), ctx as never);
        expect(res.status).toBe(404);
        expect(auditCreate).not.toHaveBeenCalled();
    });
});

describe("DELETE /api/attendance/manual/[id]", () => {
    it("tombstones (update, never delete) and always flags to the board", async () => {
        visitFindUnique.mockResolvedValue(baseVisit);
        const res = await DELETE(req("DELETE"), ctx as never);

        expect(res.status).toBe(200);
        // No bag: a tombstone ships no model data (registry `envelope: null`).
        expect(await res.json()).toEqual({});
        // Ownership + liveness are re-asserted inside the lock, not just before it.
        expect(tx.visit.updateMany).toHaveBeenCalledWith({
            where: { id: 42, personId: OWN_ID, deletedAt: null },
            data: expect.objectContaining({ deletedAt: expect.any(Date), deletedById: OWN_ID }),
        });
        expect(tx.visit.update).not.toHaveBeenCalled(); // never a row removal
        const audit = auditCreate.mock.calls[0][0].data;
        expect(audit).toMatchObject({ action: "DELETE", tableName: "Visit", affectedEntityId: 42 });
        expect(audit.newData.significance.flagged).toBe(true);
        expect(emailBoardMembers).toHaveBeenCalledTimes(1);
    });

    it("404s a double delete (already tombstoned)", async () => {
        visitFindUnique.mockResolvedValue({ ...baseVisit, deletedAt: new Date() });
        const res = await DELETE(req("DELETE"), ctx as never);
        expect(res.status).toBe(404);
        expect(tx.visit.updateMany).not.toHaveBeenCalled();
    });

    it("404s a delete that races another delete (nothing matched under the lock)", async () => {
        visitFindUnique.mockResolvedValue(baseVisit);
        tx.visit.updateMany.mockResolvedValue({ count: 0 });
        const res = await DELETE(req("DELETE"), ctx as never);
        expect(res.status).toBe(404);
        expect(auditCreate).not.toHaveBeenCalled();
        expect(emailBoardMembers).not.toHaveBeenCalled();
    });
});

// AT3 §3: a household lead corrects a member's visit on the same terms as their
// own — the lead is the responsible adult, and a minor cannot self-serve at all.
describe("household-lead correction of a member's visit", () => {
    const memberVisit = { ...baseVisit, personId: MEMBER_ID };

    // The lead leads MEMBER_ID's household; anyone else is still out of scope.
    const leadScope = async (actorId: number, subjectId: number) =>
        actorId === subjectId || (actorId === OWN_ID && subjectId === MEMBER_ID)
            ? { id: subjectId, isKeyholder: false } : null;

    beforeEach(() => {
        (visitSubject as jest.Mock).mockImplementation(leadScope);
        // buildCallerContext resolves the led_households roster from the DB via
        // householdLeadship (person.findUnique) — the SAME predicate the write
        // authz uses — so the default actor here is a genuine lead. Individual
        // tests override this to model a sysadmin, a non-lead, etc.
        personFindUnique.mockResolvedValue({ isKeyholder: false, householdId: HOUSEHOLD_ID, isHouseholdLead: true, isSysadmin: false });
        visitFindUnique.mockResolvedValue(memberVisit);
        tx.visit.findFirst.mockResolvedValue({ id: 42 });
        // The row written back is the MEMBER's. Leaving the default (personId =
        // OWN_ID) let their_own resolve on it, which masks what led_households
        // does or doesn't grant — the whole point of this block.
        tx.visit.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ ...memberVisit, ...args.data }));
        (processVisitCheckout as jest.Mock).mockResolvedValue([{ ...memberVisit }]);
    });

    it("edits a member's visit, locking and matching on the MEMBER, auditing the actor", async () => {
        const res = await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:05:00Z" }), ctx as never);

        expect(res.status).toBe(200);
        // The one-open-visit invariant is per person, so the lock and the
        // under-lock re-check key on the visit's person, not the lead.
        expect(tx.$executeRaw).toHaveBeenCalledWith(expect.anything(), MEMBER_ID);
        expect(tx.visit.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 42, personId: MEMBER_ID, deletedAt: null },
        }));
        const audit = auditCreate.mock.calls[0][0].data;
        expect(audit).toMatchObject({ actorId: OWN_ID, secondaryAffectedEntity: MEMBER_ID });
    });

    it("weights a proxy edit double — a nudge that is noise on your own record flags here", async () => {
        // 50 min on a WEB (weight 1) arrival: 50 alone is under the 90 threshold,
        // 100 by proxy is over it.
        const res = await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:50:00Z" }), ctx as never);
        expect(res.status).toBe(200);
        expect((emailBoardMembers as jest.Mock).mock.calls[0][0]).toContain("household-edit");
    });

    it("tombstones a member's visit, stamping the LEAD as the deleter", async () => {
        const res = await DELETE(req("DELETE"), ctx as never);

        expect(res.status).toBe(200);
        expect(tx.visit.updateMany).toHaveBeenCalledWith({
            where: { id: 42, personId: MEMBER_ID, deletedAt: null },
            data: expect.objectContaining({ deletedById: OWN_ID }),
        });
        expect(auditCreate.mock.calls[0][0].data).toMatchObject({
            actorId: OWN_ID, secondaryAffectedEntity: MEMBER_ID,
        });
    });

    // THE regression pin for the registry↔route seam. Both edges matter: the
    // times must SURVIVE (led_households:personal is granted and resolving) and
    // the 'internal' tombstone columns must be GONE. The session carries no
    // householdLead claim — the roster resolves from the DB (householdLeadship),
    // which is the whole point: the view no longer depends on the session claim.
    it("strips the internal tombstone columns while keeping the times the lead may see", async () => {
        personFindMany.mockResolvedValue([{ id: OWN_ID }, { id: MEMBER_ID }]);

        const res = await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:05:00Z" }), ctx as never);
        expect(res.status).toBe(200);
        const { visit } = await res.json();

        expect(visit.arrivedAt).toBe("2026-07-20T14:05:00.000Z");
        expect(visit.departedAt).toBe(baseVisit.departedAt.toISOString());
        for (const internal of ["deletedAt", "deletedById", "forceCloseWarnedAt", "forceCloseToken"]) {
            expect(visit).not.toHaveProperty(internal);
        }
    });

    // #1614 case (a): a sysadmin who is NOT a household lead, correcting a visit
    // in their own household. canManage is true via the sysadmin override in
    // householdLeadship, so led_households resolves and the times ship — even
    // though no householdLead claim rides the session. This is the divergence
    // the roster used to have with the write authz, now closed.
    it("keeps the times for a sysadmin who is not a household lead", async () => {
        personFindUnique.mockResolvedValue({ isKeyholder: false, householdId: HOUSEHOLD_ID, isHouseholdLead: false, isSysadmin: true });
        personFindMany.mockResolvedValue([{ id: OWN_ID }, { id: MEMBER_ID }]);

        const res = await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:05:00Z" }), ctx as never);
        expect(res.status).toBe(200);
        const { visit } = await res.json();
        expect(visit.arrivedAt).toBe("2026-07-20T14:05:00.000Z");
    });

    // The empty-set invariant: led_households is gated on the DB leadership
    // predicate (householdLeadship → canManage), so a caller the DB credits as
    // neither a lead nor a sysadmin gets the empty roster and the times must NOT
    // ship — even where some other signal let the write through.
    it("strips the times when the DB credits the caller as neither lead nor sysadmin", async () => {
        personFindUnique.mockResolvedValue({ isKeyholder: false, householdId: HOUSEHOLD_ID, isHouseholdLead: false, isSysadmin: false });

        const res = await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:05:00Z" }), ctx as never);
        expect(res.status).toBe(200);
        const { visit } = await res.json();

        expect(visit).not.toHaveProperty("arrivedAt");
        expect(visit).not.toHaveProperty("departedAt");
        expect(visit.personId).toBe(MEMBER_ID); // public tier still rides through
    });

    it("404s a visit belonging to someone outside the lead's household", async () => {
        visitFindUnique.mockResolvedValue({ ...baseVisit, personId: 99 });
        expect((await PATCH(req("PATCH", { arrivedAt: "2026-07-20T14:05:00Z" }), ctx as never)).status).toBe(404);
        expect((await DELETE(req("DELETE"), ctx as never)).status).toBe(404);
        expect(tx.visit.update).not.toHaveBeenCalled();
        expect(tx.visit.updateMany).not.toHaveBeenCalled();
    });
});
