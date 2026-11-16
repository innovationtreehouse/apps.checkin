import { SYSTEM_ACTOR, SYSTEM_ACTORS, personActor, personOrSystemActor, recordAudit, systemActor } from "@/lib/auditActor";
import type { TxClient } from "@/lib/db-client";

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
        for (const name of SYSTEM_ACTORS) expect(name).toMatch(/^(cron|system|webhook|kiosk|migration):[a-z0-9-]+$/);
    });
});

describe("recordAudit", () => {
    it("writes the actor and entry through the client it is given", async () => {
        const create = jest.fn().mockResolvedValue({ id: 1 });
        const tx = { auditLog: { create } } as unknown as TxClient;

        await recordAudit(tx, personActor(7), { action: "EDIT", tableName: "Tool", affectedEntityId: 3, newData: { name: "Saw" } });

        expect(create).toHaveBeenCalledWith({
            data: { actorId: 7, actorSystem: null, action: "EDIT", tableName: "Tool", affectedEntityId: 3, newData: { name: "Saw" } },
        });
    });

    it("opens no transaction of its own", async () => {
        const $transaction = jest.fn();
        const tx = { $transaction, auditLog: { create: jest.fn() } } as unknown as TxClient;

        await recordAudit(tx, systemActor("cron:nightly"), { action: "DELETE", tableName: "Person", affectedEntityId: 1 });

        expect($transaction).not.toHaveBeenCalled();
    });
});
