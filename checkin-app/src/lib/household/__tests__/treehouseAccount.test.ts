import { holdsTreehouseAccount, isTreehouseHousehold } from "@/lib/household/treehouseAccount";
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
