import { parkReasonToClass, PresenceClass } from "@/lib/presence/events";

describe("parkReasonToClass", () => {
    it("maps known park reasons onto M2 classifications", () => {
        expect(parkReasonToClass("stale_replay")).toBe(PresenceClass.PARKED_STALE);
        expect(parkReasonToClass("out_of_order")).toBe(PresenceClass.PARKED_OUT_OF_ORDER);
        expect(parkReasonToClass("clock_suspect")).toBe(PresenceClass.PARKED_CLOCK);
        expect(parkReasonToClass("facility_closed")).toBe(PresenceClass.PARKED_CLOSED);
        expect(parkReasonToClass("double_in")).toBe(PresenceClass.CONFLICT_DOUBLE_IN);
        expect(parkReasonToClass("client_dead:404")).toBe(PresenceClass.PARKED_DEAD);
    });
});
