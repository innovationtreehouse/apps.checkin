/**
 * @jest-environment node
 */
/**
 * A PARKED_CLOSED flush runs under the facility lock only, so it can project
 * an open visit for a person whose own scan already read "no open visit" and
 * is waiting on that lock. The scan must then park as a double IN — never hit
 * the one-open-visit index and be acked as a duplicate with its rows rolled
 * back (docs/rules/attendance-checkin.md: a touch is never lost).
 *
 * The race is made deterministic by inserting the open visit (as the flush
 * would) the moment the scan first acquires the facility lock.
 */
import { POST } from "@/app/api/scan/route";
import prisma from "@/lib/prisma";
import { authenticateRequest } from "@/lib/auth";
import { PresenceClass } from "@/lib/presence/events";
import { uniqueViolationFields } from "@/lib/prismaUniqueViolation";
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

let onFirstFacilityLock: (() => Promise<void>) | null = null;
jest.mock("@/lib/facilityLock", () => {
    const actual = jest.requireActual("@/lib/facilityLock");
    return {
        ...actual,
        withFacilityLock: (db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
            actual.withFacilityLock(db, async (tx: unknown) => {
                const hook = onFirstFacilityLock;
                onFirstFacilityLock = null;
                if (hook) await hook();
                return fn(tx);
            }),
    };
});

const TAG = "scan-flush-race-test";

function scanReq(body: Record<string, unknown>) {
    return new Request("http://localhost/api/scan", {
        method: "POST",
        body: JSON.stringify(body),
    }) as unknown as import("next/server").NextRequest;
}

describe("Scan racing a PARKED_CLOSED flush (real DB)", () => {
    let keyholder: Person;
    let member: Person;
    const householdIds: number[] = [];

    beforeAll(async () => {
        (authenticateRequest as jest.Mock).mockResolvedValue({ type: "kiosk" });
        keyholder = await prisma.person.create({
            data: { name: "Race Key", email: `key-${TAG}@example.com`, isKeyholder: true, household: { create: { name: "Test HH" } } },
        });
        householdIds.push(keyholder.householdId);
        member = await prisma.person.create({
            data: { name: "Race Member", email: `member-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        householdIds.push(member.householdId);
    });

    beforeEach(async () => {
        await prisma.visit.create({ data: { personId: keyholder.id, arrivedAt: new Date(0), arrivedVia: "SCANNER" } });
        // What the flush projects for the member while their scan waits on the lock.
        onFirstFacilityLock = async () => {
            await prisma.visit.create({ data: { personId: member.id, arrivedAt: new Date(), arrivedVia: "SCANNER" } });
        };
    });

    afterEach(async () => {
        onFirstFacilityLock = null;
        await prisma.presenceEvent.deleteMany({ where: { personId: { in: [keyholder.id, member.id] } } });
        await prisma.visit.deleteMany({ where: { personId: { in: [keyholder.id, member.id] } } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: [keyholder.id, member.id] } } });
    });

    afterAll(async () => {
        await prisma.person.deleteMany({ where: { id: { in: [keyholder.id, member.id] } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    it.each([
        ["intent IN", { intent: "IN" }],
        ["legacy toggle", {}],
    ])("%s parks as a double IN and keeps the touch", async (_label, extra) => {
        const clientEventId = `evt-race-${_label.replace(/\s/g, "-")}`;
        const res = await POST(scanReq({ participantId: member.id, clientEventId, ...extra }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ type: "parked", reason: "double_in" });
        expect(onFirstFacilityLock).toBeNull();

        const open = await prisma.visit.findMany({ where: { personId: member.id, departedAt: null } });
        expect(open).toHaveLength(1);
        expect(await prisma.rawBadgeLog.findUnique({ where: { clientEventId } })).not.toBeNull();
        const ev = await prisma.presenceEvent.findUnique({ where: { clientEventId } });
        expect(ev?.classification).toBe(PresenceClass.CONFLICT_DOUBLE_IN);
    });
});

describe("uniqueViolationFields against the driver adapter's P2002 shape", () => {
    let person: Person;

    beforeAll(async () => {
        person = await prisma.person.create({
            data: { name: "P2002 Shape", email: `shape-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
    });

    afterAll(async () => {
        await prisma.presenceEvent.deleteMany({ where: { personId: person.id } });
        await prisma.visit.deleteMany({ where: { personId: person.id } });
        await prisma.person.delete({ where: { id: person.id } });
        await prisma.household.delete({ where: { id: person.householdId } });
    });

    it("names clientEventId on a duplicate event id", async () => {
        const data = { personId: person.id, occurredAt: new Date(), direction: "IN" as const, source: "SCANNER" as const, clientEventId: `dup-${TAG}` };
        await prisma.presenceEvent.create({ data });
        const err = await prisma.presenceEvent.create({ data }).catch((e: unknown) => e);
        expect(uniqueViolationFields(err)).toEqual(["clientEventId"]);
    });

    it("names personId on a second open visit", async () => {
        const data = { personId: person.id, arrivedAt: new Date(), arrivedVia: "SCANNER" as const };
        await prisma.visit.create({ data });
        const err = await prisma.visit.create({ data }).catch((e: unknown) => e);
        expect(uniqueViolationFields(err)).toEqual(["personId"]);
    });

    it("is undefined for anything that is not a P2002", () => {
        expect(uniqueViolationFields(new Error("boom"))).toBeUndefined();
    });
});
