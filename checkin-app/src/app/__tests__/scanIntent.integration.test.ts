/**
 * @jest-environment node
 */
/**
 * Stage-2 substrate: displayed intent is applied, not re-toggled from live
 * Visit state. Conflicts park. A non-keyholder IN with no keyholder present
 * checks in all the same.
 */
import { POST } from "@/app/api/scan/route";
import prisma from "@/lib/prisma";
import { authenticateRequest } from "@/lib/auth";
import { PresenceClass } from "@/lib/presence/events";
import type { Person } from "@/generated/prisma/client";

jest.mock("@/lib/auth", () => ({ authenticateRequest: jest.fn() }));
jest.mock("@/lib/notifications", () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/logger", () => ({
    logBackendError: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TAG = "scan-intent-test";

function scanReq(body: Record<string, unknown>) {
    return new Request("http://localhost/api/scan", {
        method: "POST",
        body: JSON.stringify(body),
    }) as unknown as import("next/server").NextRequest;
}

describe("Scan intent — Stage-2 projection (real DB)", () => {
    let keyholder: Person;
    let member: Person;
    const householdIds: number[] = [];

    beforeAll(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: "kiosk" });
        keyholder = await prisma.person.create({
            data: { name: "Intent Key", email: `key-${TAG}@example.com`, isKeyholder: true, household: { create: { name: "Test HH" } } },
        });
        householdIds.push(keyholder.householdId);
        member = await prisma.person.create({
            data: { name: "Intent Member", email: `member-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        householdIds.push(member.householdId);
    });

    afterEach(async () => {
        await prisma.presenceEvent.deleteMany({ where: { personId: { in: [keyholder.id, member.id] } } });
        await prisma.visit.deleteMany({ where: { personId: { in: [keyholder.id, member.id] } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: [keyholder.id, member.id] } } });
    });

    afterAll(async () => {
        await prisma.presenceEvent.deleteMany({ where: { personId: { in: [keyholder.id, member.id] } } });
        await prisma.visit.deleteMany({ where: { personId: { in: [keyholder.id, member.id] } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: [keyholder.id, member.id] } } });
        await prisma.person.deleteMany({ where: { id: { in: [keyholder.id, member.id] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it("intent IN with no open visit creates a visit", async () => {
        await prisma.visit.create({ data: { personId: keyholder.id, arrivedAt: new Date(0), arrivedVia: "SCANNER" } });
        const res = await POST(scanReq({ participantId: member.id, clientEventId: "evt-in", intent: "IN" }));
        expect((await res.json()).type).toBe("checkin");
        const visits = await prisma.visit.findMany({ where: { personId: member.id, departedAt: null } });
        expect(visits).toHaveLength(1);
        const ev = await prisma.presenceEvent.findUnique({ where: { clientEventId: "evt-in" } });
        expect(ev?.direction).toBe("IN");
        expect(ev?.classification).toBe(PresenceClass.PROJECTED);
    });

    it("intent IN while a visit is already open parks as ConflictDoubleIn and does not toggle", async () => {
        await prisma.visit.create({ data: { personId: keyholder.id, arrivedAt: new Date(0), arrivedVia: "SCANNER" } });
        await prisma.visit.create({ data: { personId: member.id, arrivedAt: new Date(), arrivedVia: "SCANNER" } });
        const res = await POST(scanReq({ participantId: member.id, clientEventId: "evt-double-in", intent: "IN" }));
        expect((await res.json()).type).toBe("parked");
        const open = await prisma.visit.findMany({ where: { personId: member.id, departedAt: null } });
        expect(open).toHaveLength(1);
        const ev = await prisma.presenceEvent.findUnique({ where: { clientEventId: "evt-double-in" } });
        expect(ev?.classification).toBe(PresenceClass.CONFLICT_DOUBLE_IN);
        const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: "evt-double-in" } });
        expect(log?.reviewReason).toBe("conflict_double_in");
    });

    it("intent OUT with no open visit parks as ConflictOutNoIn", async () => {
        await prisma.visit.create({ data: { personId: keyholder.id, arrivedAt: new Date(0), arrivedVia: "SCANNER" } });
        const res = await POST(scanReq({ participantId: member.id, clientEventId: "evt-out-no-in", intent: "OUT" }));
        expect((await res.json()).type).toBe("parked");
        expect(await prisma.visit.findFirst({ where: { personId: member.id } })).toBeNull();
        const ev = await prisma.presenceEvent.findUnique({ where: { clientEventId: "evt-out-no-in" } });
        expect(ev?.classification).toBe(PresenceClass.CONFLICT_OUT_NO_IN);
        const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: "evt-out-no-in" } });
        expect(log?.reviewReason).toBe("conflict_out_no_in");
    });

    it("clockSuspect parks for review and does not toggle", async () => {
        await prisma.visit.create({ data: { personId: keyholder.id, arrivedAt: new Date(0), arrivedVia: "SCANNER" } });
        const res = await POST(scanReq({ participantId: member.id, clientEventId: "evt-clock", intent: "IN", clockSuspect: true }));
        expect((await res.json()).type).toBe("parked");
        expect(await prisma.visit.findFirst({ where: { personId: member.id } })).toBeNull();
        const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: "evt-clock" } });
        expect(log?.reviewReason).toBe("clock_suspect");
        const ev = await prisma.presenceEvent.findUnique({ where: { clientEventId: "evt-clock" } });
        expect(ev?.clockSuspect).toBe(true);
        expect(ev?.classification).toBe(PresenceClass.PARKED_CLOCK);
    });

    it("a non-keyholder IN with no keyholder present checks in, and its OUT is an ordinary checkout", async () => {
        const res = await POST(scanReq({ participantId: member.id, clientEventId: "evt-nokh-in", intent: "IN" }));
        expect((await res.json()).type).toBe("checkin");
        const visit = await prisma.visit.findFirst({ where: { personId: member.id, departedAt: null } });
        expect(visit).not.toBeNull();
        const ev = await prisma.presenceEvent.findUnique({ where: { clientEventId: "evt-nokh-in" } });
        expect(ev?.classification).toBe(PresenceClass.PROJECTED);
        expect(ev?.visitId).toBe(visit!.id);
        const log = await prisma.rawBadgeLog.findUnique({ where: { clientEventId: "evt-nokh-in" } });
        expect(log?.reviewReason).toBeNull();

        // Step past the scan debounce: the OUT is a later, separate badge.
        await prisma.rawBadgeLog.updateMany({ where: { personId: member.id }, data: { timestamp: new Date(Date.now() - 60_000) } });
        const out = await POST(scanReq({ participantId: member.id, clientEventId: "evt-nokh-out", intent: "OUT" }));
        expect((await out.json()).type).toBe("checkout");
        const closed = await prisma.visit.findUnique({ where: { id: visit!.id } });
        expect(closed?.departedAt).toBeInstanceOf(Date);
    });
});
