import { holdsTreehouseAccount, isTreehouseHousehold, putsTreehouseSignInInFamily } from "@/lib/household/treehouseAccount";
import type { DbClient } from "@/lib/db-client";

function dbWith(emails: (string | null)[]): DbClient {
    return { person: { findMany: jest.fn().mockResolvedValue(emails.map((email) => ({ email }))) } } as unknown as DbClient;
}

describe("holdsTreehouseAccount", () => {
    it("is true when anyone in the household has an org-domain email, in any case", () => {
        expect(holdsTreehouseAccount([{ email: "kid@example.com" }, { email: "Front-Desk@InnovationTreehouse.org" }])).toBe(true);
    });

    it("is false for a household of other addresses or none", () => {
        expect(holdsTreehouseAccount([{ email: "lead@example.com" }, { email: null }])).toBe(false);
        expect(holdsTreehouseAccount([])).toBe(false);
    });

    it("does not count a lookalike domain", () => {
        expect(holdsTreehouseAccount([{ email: "someone@notinnovationtreehouse.org" }])).toBe(false);
    });
});

describe("isTreehouseHousehold", () => {
    it("reads the household's people and applies the org-account check", async () => {
        await expect(isTreehouseHousehold(dbWith(["staff@innovationtreehouse.org"]), 5)).resolves.toBe(true);
        await expect(isTreehouseHousehold(dbWith(["lead@example.com"]), 5)).resolves.toBe(false);
    });
});

describe("putsTreehouseSignInInFamily", () => {
    it("is true for a Treehouse address given to someone in a family's household", async () => {
        await expect(putsTreehouseSignInInFamily(dbWith(["lead@example.com"]), 5, "staff@innovationtreehouse.org")).resolves.toBe(true);
    });

    it("is false inside the Treehouse account's own household", async () => {
        await expect(putsTreehouseSignInInFamily(dbWith(["staff@innovationtreehouse.org"]), 5, "desk@innovationtreehouse.org")).resolves.toBe(false);
    });

    it("is false for an ordinary address or none, without reading the household", async () => {
        const db = dbWith(["lead@example.com"]);
        await expect(putsTreehouseSignInInFamily(db, 5, "new@example.com")).resolves.toBe(false);
        await expect(putsTreehouseSignInInFamily(db, 5, null)).resolves.toBe(false);
        expect(db.person.findMany).not.toHaveBeenCalled();
    });
});
