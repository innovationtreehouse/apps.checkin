/**
 * The kiosk is an unattended device that re-broadcasts this payload into an iframe
 * with a wildcard postMessage origin (client/client.py), so its roster must carry no
 * `personal`/`pii` field. The privileged (keyholder/board/sysadmin) roster keeps them
 * — that grant is deliberate (registry.ts `keyholders:personal`, pickup/emergency).
 */
const findMany = jest.fn();
const heldFindMany = jest.fn();
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {
    visit: { findMany: (...a: unknown[]) => findMany(...a) },
    presenceEvent: { findMany: (...a: unknown[]) => heldFindMany(...a) },
} }));

// Who counts as a supervising adult is lib/supervision's rule and is tested there
// (#1436/#1550). Pinned at 1 — short of two-deep — so what this file asserts is its
// OWN half: whether a youth is accompanied by an adult of their household.
const supervisingAdultVisits = jest.fn().mockResolvedValue(new Map());
jest.mock("@/lib/supervision", () => ({
    __esModule: true,
    MIN_SUPERVISING_ADULTS: 2,
    supervisingAdultVisits: (...a: unknown[]) => supervisingAdultVisits(...a),
    supervisingAdultCount: () => 1,
}));

import { getFullAttendance } from "@/lib/getFullAttendance";

// Age fixtures are relative to now so they never age past the youth boundary the
// way a hardcoded year would; the day step keeps the age unambiguous mid-year.
const yearsAgo = (n: number) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - n);
    d.setDate(d.getDate() - 1);
    return d;
};

const rows = [
    {
        id: 201, arrivedAt: new Date("2026-07-01T14:00:00Z"), departedAt: null, personId: 50,
        person: {
            id: 50, email: "karen@example.com", name: "Karen Keyholder", nickname: "Kay", isKeyholder: true,
            dateOfBirth: new Date("1985-01-01"), householdId: 6, phone: "5551234567",
            household: { id: 6, emergencyContacts: [{ id: 1, name: "Con One", phone: "5559990001", relationship: "Aunt" }] },
        },
        event: { id: 9, program: { id: 3, name: "Robotics", price: 100 } },
    },
    {
        id: 203, arrivedAt: new Date("2026-07-01T14:10:00Z"), departedAt: null, personId: 70,
        person: {
            id: 70, email: "stu@example.com", name: null, isKeyholder: false,
            dateOfBirth: yearsAgo(10), householdId: 8, phone: "5557654321",
            household: { id: 8, emergencyContacts: [{ id: 2, name: "Con Two", phone: "5559990002", relationship: null }] },
        },
        event: null,
    },
];

beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue(rows);
    heldFindMany.mockReset();
    heldFindMany.mockResolvedValue([]);
    supervisingAdultVisits.mockClear();
});

describe("getFullAttendance({ kiosk: true })", () => {
    it("ships no dateOfBirth, phone, householdId or emergency contacts", async () => {
        const { attendance } = await getFullAttendance({ kiosk: true });

        const wire = JSON.stringify(attendance);
        expect(wire).not.toMatch(/dateOfBirth|phone|emergencyContacts|householdId/);
        // The contact values themselves, not just the keys.
        expect(wire).not.toContain("5551234567");
        expect(wire).not.toContain("Con One");

        expect(attendance[0]).toEqual({
            id: 201,
            arrivedAt: rows[0].arrivedAt,
            participant: { id: 50, name: "Karen Keyholder", nickname: "Kay", isKeyholder: true, isYouth: false },
            event: { program: { id: 3, name: "Robotics" } },
        });
    });

    it("still gives the display what it renders: name fallback, youth split, program badge", async () => {
        const { attendance, counts, safety } = await getFullAttendance({ kiosk: true });

        // name-or-email-prefix resolved server-side; raw address never ships
        expect(attendance[1].participant.name).toBe("stu");
        // the kiosk renders the nickname over the first name, so it has to ship
        expect(attendance[0].participant.nickname).toBe("Kay");
        expect(JSON.stringify(attendance)).not.toContain("@example.com");
        // youth column still populates without dateOfBirth
        expect(attendance[1].participant.isYouth).toBe(true);
        expect(attendance[0].event).toEqual({ program: { id: 3, name: "Robotics" } });
        expect(attendance[1].event).toBeNull();
        // aggregates are identical either way
        expect(counts).toEqual({ keyholders: 1, volunteers: 0, youth: 1, total: 2 });
        expect(safety).toEqual({ isLastKeyholder: true, isTwoDeepViolation: true });
    });

    it("does not even fetch the emergency contacts", async () => {
        await getFullAttendance({ kiosk: true });
        expect(findMany.mock.calls[0][0].include.person.select.household).toBe(false);
    });
});

describe("getFullAttendance() — privileged caller (unchanged)", () => {
    it("keeps dateOfBirth, phone and the household emergency contacts", async () => {
        const { attendance } = await getFullAttendance();

        expect(attendance[0].participant).toMatchObject({
            id: 50,
            name: "Karen Keyholder",
            nickname: "Kay",
            isKeyholder: true,
            dateOfBirth: rows[0].person.dateOfBirth,
            householdId: 6,
            phone: "5551234567",
            household: { id: 6, emergencyContacts: [{ id: 1, name: "Con One", phone: "5559990001", relationship: "Aunt" }] },
        });
        expect(findMany.mock.calls[0][0].include.person.select.household).toMatchObject({ select: { id: true } });
    });

    it("never ships the raw email on either path", async () => {
        const { attendance } = await getFullAttendance();
        expect(JSON.stringify(attendance)).not.toContain("@example.com");
    });
});

describe("held PARKED_CLOSED scans (#1782)", () => {
    const heldRows = [
        { id: 900, occurredAt: new Date("2026-07-01T09:00:00Z"), person: { name: "Held Person", nickname: "Hp", email: "held@example.com" } },
        { id: 901, occurredAt: new Date("2026-07-01T09:05:00Z"), person: { name: null, nickname: null, email: "noname@example.com" } },
    ];

    it("queries only unprojected closed-facility IN scans, oldest first, LIVE persons", async () => {
        heldFindMany.mockResolvedValue(heldRows);
        await getFullAttendance();
        expect(heldFindMany.mock.calls[0][0]).toMatchObject({
            where: { classification: "PARKED_CLOSED", direction: "IN", person: { mergedIntoId: null } },
            orderBy: { occurredAt: "asc" },
        });
    });

    it("ships id/name/nickname/time only — no email — on both the privileged and kiosk paths", async () => {
        heldFindMany.mockResolvedValue(heldRows);
        for (const kiosk of [false, true]) {
            const { held } = await getFullAttendance({ kiosk });
            expect(held).toEqual([
                { id: 900, occurredAt: heldRows[0].occurredAt, name: "Held Person", nickname: "Hp" },
                { id: 901, occurredAt: heldRows[1].occurredAt, name: "noname", nickname: null },
            ]);
            expect(JSON.stringify(held)).not.toContain("@example.com");
        }
    });

    it("never folds held scans into counts or safety", async () => {
        heldFindMany.mockResolvedValue(heldRows);
        const { counts, safety } = await getFullAttendance();
        // Identical to the no-held baseline: two visits, unchanged flags.
        expect(counts).toEqual({ keyholders: 1, volunteers: 0, youth: 1, total: 2 });
        expect(safety).toEqual({ isLastKeyholder: true, isTwoDeepViolation: true });
    });

    it("is an empty array when nothing is held", async () => {
        const { held } = await getFullAttendance();
        expect(held).toEqual([]);
    });
});

describe("two-deep calc fails closed on unknown DOB (#300)", () => {
    // Youth (hh 8) + real adult (hh 6) + null-DOB visitor in the youth's
    // household. Under the old null→adult default the null-DOB visitor
    // "accompanied" the youth, masking the violation. The supervising-adult
    // count is the other prong and lives in lib/supervision now.
    const nullDobRow = {
        id: 204, arrivedAt: new Date("2026-07-01T14:20:00Z"), departedAt: null, personId: 80,
        person: {
            id: 80, email: "nodob@example.com", name: "No Dob", isKeyholder: false,
            dateOfBirth: null, isDeclaredAdult: false, householdId: 8, phone: null,
            household: { id: 8, emergencyContacts: [] },
        },
        event: null,
    };

    it("unknown DOB is never a supervising adult and cannot mask a violation", async () => {
        findMany.mockResolvedValue([...rows, nullDobRow]);
        const { attendance, counts, safety } = await getFullAttendance({ kiosk: true });

        expect(safety.isTwoDeepViolation).toBe(true);
        // counted as youth, not volunteer, and flagged as youth on the wire
        expect(counts).toEqual({ keyholders: 1, volunteers: 0, youth: 2, total: 3 });
        expect(attendance[2].participant.isYouth).toBe(true);
        expect(supervisingAdultVisits).toHaveBeenCalled();
    });

    it("a DoB-stripped declared adult (#1165) still accompanies their own youth", async () => {
        // Same shape, but the null-DoB visitor is a 26+ member whose DoB was
        // deliberately deleted: isDeclaredAdult wins over the fail-closed default,
        // so the youth of household 8 is no longer unaccompanied.
        findMany.mockResolvedValue([...rows, {
            ...nullDobRow,
            person: { ...nullDobRow.person, isDeclaredAdult: true },
        }]);
        const { attendance, counts, safety } = await getFullAttendance({ kiosk: true });

        expect(safety.isTwoDeepViolation).toBe(false);
        expect(counts).toEqual({ keyholders: 1, volunteers: 1, youth: 1, total: 3 });
        expect(attendance[2].participant.isYouth).toBe(false);
        // No unaccompanied youth, so the flag is false either way — the poll must
        // not pay for the supervision queries to learn that.
        expect(supervisingAdultVisits).not.toHaveBeenCalled();
    });
});
