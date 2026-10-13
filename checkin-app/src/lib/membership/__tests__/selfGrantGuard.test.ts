import fs from "fs";
import path from "path";
import type { DbClient } from "@/lib/db-client";
import { refuseSelfGrant, SELF_GRANT_REFUSAL_TABLE } from "../selfGrantGuard";

type PersonRow = { id: number; householdId: number | null; email: string | null };

/** A db double holding only what the guard reads and writes. */
function fakeDb(people: PersonRow[]) {
    const audit = jest.fn(async () => ({}));
    const db = {
        person: {
            findUnique: async ({ where }: { where: { id: number } }) => people.find((p) => p.id === where.id) ?? null,
            findMany: async ({ where }: { where: { householdId: number } }) => people.filter((p) => p.householdId === where.householdId),
        },
        auditLog: { create: audit },
    } as unknown as DbClient;
    return { db, audit };
}

const people: PersonRow[] = [
    { id: 1, householdId: 10, email: "actor@gmail.com" },
    { id: 2, householdId: 10, email: "spouse@gmail.com" },
    { id: 3, householdId: 20, email: "outsider@example.com" },
    { id: 4, householdId: null, email: "homeless@example.com" },
];
const attempt = { table: "Person" as const, attempted: { lastBackgroundCheck: "2026-01-15" } };

describe("refuseSelfGrant", () => {
    it.each([
        ["the actor", { personId: 1, householdId: 10 }],
        ["a household member", { personId: 2, householdId: 10 }],
        ["the actor's household", { householdId: 10 }],
        ["an inbox variant of a household member's email", { email: "Spouse+vol@googlemail.com" }],
    ])("refuses %s and audits the refusal", async (_label, subject) => {
        const { db, audit } = fakeDb(people);
        expect(await refuseSelfGrant(db, 1, subject, attempt)).toBe(true);
        expect(audit).toHaveBeenCalledWith({
            data: expect.objectContaining({ actorId: 1, tableName: SELF_GRANT_REFUSAL_TABLE, newData: expect.objectContaining({ reason: "own_household", table: "Person" }) }),
        });
    });

    it("refuses an actor with no household (fail closed)", async () => {
        const { db, audit } = fakeDb(people);
        expect(await refuseSelfGrant(db, 4, { personId: 3, householdId: 20 }, attempt)).toBe(true);
        expect(audit).toHaveBeenCalledWith({ data: expect.objectContaining({ newData: expect.objectContaining({ reason: "actor_household_unresolved" }) }) });
    });

    it("refuses an actor who resolves to nobody", async () => {
        const { db } = fakeDb(people);
        expect(await refuseSelfGrant(db, 999, { personId: 3, householdId: 20 }, attempt)).toBe(true);
    });

    it.each([
        ["someone in another household", { personId: 3, householdId: 20 }],
        ["another household", { householdId: 20 }],
        ["an email outside the household", { email: "outsider@example.com" }],
        ["a person with no household", { personId: 4, householdId: null }],
    ])("allows %s without an audit row", async (_label, subject) => {
        const { db, audit } = fakeDb(people);
        expect(await refuseSelfGrant(db, 1, subject, attempt)).toBe(false);
        expect(audit).not.toHaveBeenCalled();
    });
});

/**
 * Every API route that writes a dues-discount or background-check grant must call
 * refuseSelfGrant, so a new writer cannot skip the own-household rule unnoticed.
 */
describe("self-grant writers", () => {
    const apiRoot = path.join(__dirname, "../../../app/api");
    const WRITES_GRANT = [
        /volunteerDesignation\.(create|createMany|upsert|update|updateMany)\(/,
        /data:\s*\{[^}]*\bisVolunteer\s*:/,
        /\bupdateData\.lastBackgroundCheck\s*=|data:\s*\{[^}]*\blastBackgroundCheck\s*:/,
    ];

    function routeFiles(dir: string): string[] {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) return e.name === "__tests__" ? [] : routeFiles(full);
            return e.name === "route.ts" ? [full] : [];
        });
    }

    const writers = routeFiles(apiRoot)
        .map((f) => ({ rel: path.relative(apiRoot, f), src: fs.readFileSync(f, "utf8") }))
        .filter(({ src }) => WRITES_GRANT.some((re) => re.test(src)));

    it("finds the known writers", () => {
        expect(writers.map((w) => w.rel).sort()).toEqual([
            "membership-ops/households/[id]/route.ts",
            "membership-ops/participants/[id]/route.ts",
            "settings/membership/volunteer-designations/route.ts",
        ]);
    });

    it.each(writers.map((w) => [w.rel, w.src]))("%s calls refuseSelfGrant", (_rel, src) => {
        expect(src).toMatch(/\brefuseSelfGrant\(/);
    });
});
