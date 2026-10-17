import { SYSTEM_ACTOR, SYSTEM_ACTORS, personActor, personOrSystemActor, systemActor } from "@/lib/auditActor";

describe("auditActor", () => {
    it("names the automated path alongside the sentinel id", () => {
        expect(systemActor("cron:nightly")).toEqual({ actorId: SYSTEM_ACTOR, actorSystem: "cron:nightly" });
        expect(systemActor("webhook:shopify-order").actorSystem).not.toBe(systemActor("cron:nightly").actorSystem);
    });

    it("leaves actorSystem null for a person, so a row is one or the other", () => {
        expect(personActor(7)).toEqual({ actorId: 7, actorSystem: null });
    });

    it.each([0, -1, NaN, 1.5])("refuses %p rather than filing a person's action as System", (bad) => {
        expect(() => personActor(bad)).toThrow(/cannot be filed as System/);
    });

    it("falls back to the named system actor only when no person is supplied", () => {
        expect(personOrSystemActor(7, "webhook:shopify-order")).toEqual({ actorId: 7, actorSystem: null });
        expect(personOrSystemActor(undefined, "webhook:shopify-order")).toEqual({ actorId: SYSTEM_ACTOR, actorSystem: "webhook:shopify-order" });
        expect(personOrSystemActor(null, "webhook:shopify-order")).toEqual({ actorId: SYSTEM_ACTOR, actorSystem: "webhook:shopify-order" });
    });

    it("keeps every system actor name distinct and surface-prefixed", () => {
        expect(new Set(SYSTEM_ACTORS).size).toBe(SYSTEM_ACTORS.length);
        for (const name of SYSTEM_ACTORS) expect(name).toMatch(/^(cron|system|webhook|kiosk):[a-z0-9-]+$/);
    });
});
