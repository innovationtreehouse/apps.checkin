import { visitSubject } from "../scope";
import prisma from "@/lib/prisma";
import { householdLeadship } from "@/lib/household/leads";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { person: { findFirst: jest.fn() } },
}));
jest.mock("@/lib/household/leads", () => ({ householdLeadship: jest.fn() }));

const personFindFirst = prisma.person.findFirst as jest.Mock;
const leadship = householdLeadship as jest.Mock;

const ACTOR = 7;
const MEMBER = 8;

beforeEach(() => {
    jest.clearAllMocks();
    leadship.mockResolvedValue(null);
});

/**
 * The scope behind every self-service visit write
 * (docs/rules/attendance-checkin.md): yourself always, your household
 * members if you lead the household, nobody else — and the household comes from
 * the actor's own row, never from the request.
 */
describe("visitSubject", () => {
    it("resolves the actor themselves without consulting leadership", async () => {
        personFindFirst.mockResolvedValue({ id: ACTOR, isKeyholder: true, householdId: 3 });
        expect(await visitSubject(ACTOR, ACTOR)).toMatchObject({ id: ACTOR, isKeyholder: true });
        expect(leadship).not.toHaveBeenCalled();
    });

    it("resolves a member of the household the actor leads", async () => {
        personFindFirst.mockResolvedValue({ id: MEMBER, isKeyholder: false, householdId: 3 });
        leadship.mockResolvedValue({ householdId: 3, canManage: true });
        expect(await visitSubject(ACTOR, MEMBER)).toMatchObject({ id: MEMBER });
    });

    it("refuses a member of a DIFFERENT household — the scope is the actor's own", async () => {
        personFindFirst.mockResolvedValue({ id: MEMBER, isKeyholder: false, householdId: 99 });
        leadship.mockResolvedValue({ householdId: 3, canManage: true });
        expect(await visitSubject(ACTOR, MEMBER)).toBeNull();
    });

    it("refuses a non-lead acting for their own household peer", async () => {
        personFindFirst.mockResolvedValue({ id: MEMBER, isKeyholder: false, householdId: 3 });
        leadship.mockResolvedValue({ householdId: 3, canManage: false });
        expect(await visitSubject(ACTOR, MEMBER)).toBeNull();
    });

    it("refuses an actor with no household at all", async () => {
        personFindFirst.mockResolvedValue({ id: MEMBER, isKeyholder: false, householdId: 3 });
        leadship.mockResolvedValue(null);
        expect(await visitSubject(ACTOR, MEMBER)).toBeNull();
    });

    // An unknown id resolves to nobody, including when the actor names themselves.
    it("refuses an unknown subject", async () => {
        personFindFirst.mockResolvedValue(null);
        expect(await visitSubject(ACTOR, MEMBER)).toBeNull();
        expect(await visitSubject(ACTOR, ACTOR)).toBeNull();
    });
});
