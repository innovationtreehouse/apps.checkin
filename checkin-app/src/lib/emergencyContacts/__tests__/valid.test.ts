import { isValidContact, VALID_CONTACT_WHERE } from "@/lib/emergencyContacts/valid";
import { createContact, updateContact, upsertPrimaryContact } from "@/lib/emergencyContacts/service";
import type { DbClient } from "@/lib/db-client";

jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));

type Contact = { name: string; phone: string; conflictParticipantId: number | null };

/** Evaluates the where-fragment the way Postgres would: `null` is IS NULL, `{ not: v }` is <> v. */
function matchesWhere(c: Contact): boolean {
    return Object.entries(VALID_CONTACT_WHERE).every(([field, cond]) => {
        const value = c[field as keyof Contact];
        return cond === null ? value === null : value !== cond.not;
    });
}

const base: Contact = { name: "Sam Outside", phone: "555-555-2000", conflictParticipantId: null };

describe("valid emergency contact: where-fragment and predicate agree", () => {
    it.each<[string, Contact, boolean]>([
        ["valid name and phone", base, true],
        ["empty name and phone", { ...base, name: "", phone: "" }, false],
        ["missing phone", { ...base, phone: "" }, false],
        ["missing name", { ...base, name: "" }, false],
        ["flagged as a household member", { ...base, conflictParticipantId: 4 }, false],
        // The database CHECK refuses untrimmed values, so this row cannot be stored; the two rules still agree on it.
        ["whitespace-only name and phone", { ...base, name: "  ", phone: "\t" }, true],
    ])("%s", (_label, contact, expected) => {
        expect(isValidContact(contact)).toBe(expected);
        expect(matchesWhere(contact)).toBe(expected);
    });
});

describe("write paths never store a whitespace-only name or phone", () => {
    function fakeDb() {
        const tx = {
            $queryRaw: jest.fn(async () => [{ archivedAt: null }]),
            emergencyContact: {
                findFirst: jest.fn(async () => null),
                create: jest.fn(async ({ data }: { data: Contact }) => ({ id: 1, ...data })),
                update: jest.fn(),
            },
        };
        const db = { $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
        return { db: db as unknown as DbClient, tx };
    }

    const whitespaceOnly = [
        ["name", { name: "   ", phone: "555-555-2000" }],
        ["phone", { name: "Sam Outside", phone: " \t " }],
    ] as const;

    it.each(whitespaceOnly)("createContact rejects a whitespace-only %s", async (_field, input) => {
        const { db, tx } = fakeDb();
        await expect(createContact(db, 7, input)).rejects.toMatchObject({ code: "incomplete" });
        expect(tx.emergencyContact.create).not.toHaveBeenCalled();
    });

    it.each(whitespaceOnly)("updateContact rejects a whitespace-only %s", async (_field, input) => {
        const { db, tx } = fakeDb();
        await expect(updateContact(db, 7, 1, input)).rejects.toMatchObject({ code: "incomplete" });
        expect(tx.emergencyContact.update).not.toHaveBeenCalled();
    });

    it.each(whitespaceOnly)("upsertPrimaryContact stores a whitespace-only %s as empty, an invalid contact", async (field, fields) => {
        const { db, tx } = fakeDb();
        const saved = await upsertPrimaryContact(db, 7, fields);
        expect(tx.emergencyContact.create).toHaveBeenCalledWith({ data: expect.objectContaining({ [field]: "" }) });
        expect(saved && isValidContact({ ...saved, conflictParticipantId: null })).toBe(false);
    });
});
