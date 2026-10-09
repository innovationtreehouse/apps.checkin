import type { Person } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { applyPresenceIntent } from "@/lib/presence/project";
import { PresenceClass } from "@/lib/presence/events";

// Conflict parks never toggle, so the review queue (RawBadgeLog.reviewReason)
// is the only place a human can see and fix them.
function fakeDb(openVisit: { id: number } | null, badgeRow: { id: number } | null) {
    const db = {
        presenceEvent: {
            create: jest.fn().mockResolvedValue({ id: 77 }),
            update: jest.fn().mockResolvedValue({}),
        },
        visit: { findFirst: jest.fn().mockResolvedValue(openVisit) },
        rawBadgeLog: {
            findFirst: jest.fn().mockResolvedValue(badgeRow),
            update: jest.fn().mockResolvedValue({}),
        },
    };
    return { db, client: db as unknown as DbClient };
}

const participant = { id: 5, isKeyholder: false } as Person;
const base = { participant, occurredAt: new Date(), authType: "kiosk", source: "SCANNER" as const };

describe("applyPresenceIntent conflict parks", () => {
    it("puts a double IN on the review queue by its clientEventId", async () => {
        const { db, client } = fakeDb({ id: 1 }, { id: 42 });
        const res = await applyPresenceIntent(client, { ...base, direction: "IN", clientEventId: "evt-1" });

        expect((await res.json()).type).toBe("parked");
        expect(db.presenceEvent.update).toHaveBeenCalledWith({
            where: { id: 77 },
            data: { classification: PresenceClass.CONFLICT_DOUBLE_IN },
        });
        expect(db.rawBadgeLog.findFirst.mock.calls[0][0].where).toEqual({ clientEventId: "evt-1", reviewReason: null });
        expect(db.rawBadgeLog.update).toHaveBeenCalledWith({ where: { id: 42 }, data: { reviewReason: "conflict_double_in" } });
    });

    it("puts an OUT with no open visit on the review queue, by person when there is no clientEventId", async () => {
        const { db, client } = fakeDb(null, { id: 43 });
        const res = await applyPresenceIntent(client, { ...base, direction: "OUT" });

        expect((await res.json()).type).toBe("parked");
        expect(db.rawBadgeLog.findFirst.mock.calls[0][0].where).toEqual({ personId: 5, reviewReason: null });
        expect(db.rawBadgeLog.update).toHaveBeenCalledWith({ where: { id: 43 }, data: { reviewReason: "conflict_out_no_in" } });
    });

    it("still parks when no badge row is found", async () => {
        const { db, client } = fakeDb(null, null);
        const res = await applyPresenceIntent(client, { ...base, direction: "OUT", clientEventId: "evt-2" });

        expect((await res.json()).type).toBe("parked");
        expect(db.rawBadgeLog.update).not.toHaveBeenCalled();
    });
});
