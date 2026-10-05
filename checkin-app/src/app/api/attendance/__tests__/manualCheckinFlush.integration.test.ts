/**
 * @jest-environment node
 */
/**
 * A keyholder's dashboard MANUAL_CHECKIN opens the facility, so it must release
 * the PARKED_CLOSED backlog like every other keyholder-IN surface
 * (docs/rules/attendance-checkin.md: held scans project once a keyholder visit
 * exists).
 */
import { getServerSession } from "next-auth/next";
import { POST } from "@/app/api/attendance/route";
import prisma from "@/lib/prisma";
import { appendPresenceEvent, PresenceClass } from "@/lib/presence/events";
import type { Person } from "@/generated/prisma/client";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/notifications", () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/logger", () => ({
    logBackendError: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TAG = "manual-checkin-flush-test";
const mockSession = getServerSession as jest.Mock;

function checkinReq(participantId: number) {
    return new Request("http://localhost/api/attendance", {
        method: "POST",
        body: JSON.stringify({ type: "MANUAL_CHECKIN", participantId }),
    });
}

describe("MANUAL_CHECKIN releases the PARKED_CLOSED backlog (real DB)", () => {
    let keyholder: Person;
    let member: Person;
    const ids = () => [keyholder.id, member.id];

    async function holdClosedScan(clientEventId: string) {
        const occurredAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
        await prisma.rawBadgeLog.create({
            data: { personId: member.id, location: "Main Entrance", clientEventId, timestamp: occurredAt, reviewReason: "facility_closed" },
        });
        await appendPresenceEvent(prisma, {
            personId: member.id,
            occurredAt,
            direction: "IN",
            source: "SCANNER",
            clientEventId,
            classification: PresenceClass.PARKED_CLOSED,
        });
    }

    async function cleanup() {
        await prisma.presenceEvent.deleteMany({ where: { personId: { in: ids() } } });
        await prisma.visit.deleteMany({ where: { personId: { in: ids() } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids() } } });
    }

    beforeAll(async () => {
        keyholder = await prisma.person.create({
            data: { name: "Flush Key", email: `key-${TAG}@example.com`, isKeyholder: true, household: { create: { name: "Test HH" } } },
        });
        member = await prisma.person.create({
            data: { name: "Flush Member", email: `member-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        mockSession.mockResolvedValue({
            user: { id: keyholder.id, email: keyholder.email, isKeyholder: true, isSysadmin: false, isBoardMember: false },
        });
    });

    afterEach(cleanup);

    afterAll(async () => {
        await cleanup();
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids() } } });
        await prisma.person.deleteMany({ where: { id: { in: ids() } } });
        await prisma.household.deleteMany({ where: { id: { in: [keyholder.householdId, member.householdId] } } });
    });

    it("projects a held scan when the keyholder checks in from the dashboard", async () => {
        await holdClosedScan("evt-manual-held");

        const res = await POST(checkinReq(keyholder.id));
        expect(res.status).toBe(200);

        const ev = await prisma.presenceEvent.findUnique({ where: { clientEventId: "evt-manual-held" } });
        expect(ev?.classification).toBe(PresenceClass.PROJECTED);
        const visit = await prisma.visit.findFirst({ where: { personId: member.id, departedAt: null } });
        expect(visit?.arrivedAt.getTime()).toBe(ev?.occurredAt.getTime());
    });
});
