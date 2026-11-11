/**
 * @jest-environment node
 *
 * Races from the programs TLA+ model (spec/ProgImpl_v2.tla), replayed on an
 * in-memory database that keeps a transaction's writes private until it
 * commits, as Postgres does under Read Committed. A hook runs after every
 * commit, standing in for a concurrent actor that sees only committed rows.
 *   F3: a Board approval between the request flag and the hold stamp.
 *   F6: a committed seat change whose stock delta is not yet owed, which the
 *       re-arm recount would count and then see added again.
 */
import { POST as RequestPost } from "@/app/api/programs/[id]/request-payment-plan/route";
import { POST as ApprovePost } from "@/app/api/finance-ops/payment-plans/route";

type Rec = Record<string, unknown>;
const mockDb: { pp: Rec; program: Rec; onCommit: (db: { pp: Rec; program: Rec }) => Promise<void> } = {
    pp: {},
    program: {},
    onCommit: async () => {},
};

jest.mock("@/lib/prisma", () => {
    const matches = (row: Rec, where: Rec): boolean => Object.entries(where).every(([k, cond]) => {
        if (k === "OR" || k === "person" || k === "programId_personId") return true;
        const v = row[k];
        if (cond === null) return v === null;
        if (cond !== null && typeof cond === "object") {
            const c = cond as Rec;
            if ("not" in c) return v !== null;
            if ("in" in c) return (c.in as unknown[]).includes(v);
            return true;
        }
        return v === cond;
    });
    const apply = (row: Rec, data: Rec) => {
        for (const [k, v] of Object.entries(data)) {
            row[k] = v !== null && typeof v === "object" && !(v instanceof Date) && "increment" in (v as Rec)
                ? (row[k] as number) + ((v as { increment: number }).increment)
                : v;
        }
    };
    // `state` is the committed db, or a transaction's private copy; `commit` runs after an autocommit write.
    const client = (state: { pp: Rec; program: Rec }, commit: () => Promise<void>): Rec => ({
        programParticipant: {
            findUnique: async () => ({ ...state.pp, person: { id: state.pp.personId, householdId: null, name: "Kid", dateOfBirth: null, isDeclaredAdult: false }, program: { ...state.program } }),
            updateMany: async ({ where, data }: { where: Rec; data: Rec }) => {
                if (!matches(state.pp, where)) return { count: 0 };
                apply(state.pp, data);
                await commit();
                return { count: 1 };
            },
        },
        program: {
            findUnique: async () => ({ ...state.program }),
            update: async ({ data }: { data: Rec }) => { apply(state.program, data); await commit(); return { ...state.program }; },
            updateMany: async ({ where, data }: { where: Rec; data: Rec }) => {
                if (!matches(state.program, where)) return { count: 0 };
                apply(state.program, data);
                await commit();
                return { count: 1 };
            },
        },
        person: { findUnique: async () => ({ householdId: null }), findFirst: async () => null, findMany: async () => [] },
        auditLog: { create: async () => ({}) },
        boardSettings: { findUnique: async () => null },
        $queryRaw: async () => [],
    });
    const committed = () => mockDb;
    const root = client(new Proxy({} as { pp: Rec; program: Rec }, { get: (_t, k: "pp" | "program") => committed()[k] }), () => mockDb.onCommit(mockDb));
    root.$transaction = async (fn: (tx: Rec) => Promise<unknown>) => {
        const staged = { pp: { ...mockDb.pp }, program: { ...mockDb.program } };
        const result = await fn(client(staged, async () => {}));
        mockDb.pp = staged.pp;
        mockDb.program = staged.program;
        await mockDb.onCommit(mockDb);
        return result;
    };
    return { __esModule: true, default: root };
});

const mockUser = { id: 99, isBoardMember: true, isSysadmin: false };
jest.mock("@/lib/auth", () => ({
    withAuth: (_o: unknown, h: (req: unknown, auth: unknown, ctx: unknown) => unknown) =>
        (req: unknown, ctx: unknown) => h(req, { type: "session", user: mockUser }, ctx),
}));
jest.mock("@/security/handler", () => ({ handler: jest.fn() }));
jest.mock("@/lib/orgMembership", () => ({ isActiveOrgMember: jest.fn().mockResolvedValue(false) }));
jest.mock("@/lib/conflictOfInterest", () => ({ hasHouseholdConflict: jest.fn().mockResolvedValue(false) }));
jest.mock("@/lib/scholarshipEmails", () => ({
    resolveScholarshipRecipients: jest.fn().mockResolvedValue([]),
    notifyReviewTeam: jest.fn(),
    sendScholarshipAck: jest.fn(),
    resolveAckCopy: jest.fn(() => ({ subject: "s", body: "b" })),
}));
jest.mock("@/lib/email", () => ({ sendEmail: jest.fn() }));
jest.mock("@/lib/logger", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    logIntegrationError: jest.fn(),
}));
// No store credentials: the push records what it owes and stops, so the carry stays inspectable.
jest.mock("@/lib/config", () => {
    const actual = jest.requireActual("@/lib/config");
    return { config: { ...actual.config, shopifyMockActive: () => false, shopifyStoreDomain: () => null } };
});

const PROGRAM = 1;
const KID = 5;

function seed() {
    mockDb.program = { id: PROGRAM, name: "Robotics", shopifyVariantId: "pub", maxParticipants: 2, shopifyStockCarry: 0, shopifyStockPushNeededAt: null };
    mockDb.pp = { programId: PROGRAM, personId: KID, status: "PENDING", isPaymentPlanRequested: false, inventoryHeldAt: null, paymentPlanDeniedAt: null, seatTakenWithoutSaleAt: null, pendingSince: new Date() };
}

const requestHold = () => RequestPost(
    new Request("http://x/api/programs/1/request-payment-plan", { method: "POST", body: JSON.stringify({ participantId: KID, kind: "SCHOLARSHIP" }) }),
    { params: Promise.resolve({ id: String(PROGRAM) }) },
);
const approve = () => ApprovePost(
    new Request("http://x/api/finance-ops/payment-plans", { method: "POST", body: JSON.stringify({ programId: PROGRAM, participantId: KID }) }),
);

/** Seats the store must not sell: ACTIVE, or PENDING with a hold. */
const taken = (pp: Rec) => (pp.status === "ACTIVE" || pp.inventoryHeldAt !== null ? 1 : 0);

describe("scholarship hold vs concurrent readers (programs TLA+ model)", () => {
    beforeEach(seed);

    it("a Board approval right after the request flag still finds the hold, so the place keeps its store unit", async () => {
        let approved = false;
        mockDb.onCommit = async (db) => {
            if (approved || db.pp.isPaymentPlanRequested !== true) return;
            approved = true;
            await approve();
        };
        expect((await requestHold()).status).toBe(200);
        expect(approved).toBe(true);
        expect(mockDb.pp.status).toBe("ACTIVE");
        // The approved place records the -1 the hold took, so a withdrawal returns it.
        expect(mockDb.pp.seatTakenWithoutSaleAt).not.toBeNull();
        expect(mockDb.program.shopifyStockCarry).toBe(-1);
    });

    it("no committed state shows a held seat whose -1 is not yet owed", async () => {
        const seen: { taken: number; carry: number }[] = [];
        mockDb.onCommit = async (db) => { seen.push({ taken: taken(db.pp), carry: db.program.shopifyStockCarry as number }); };
        expect((await requestHold()).status).toBe(200);
        expect(seen.length).toBeGreaterThan(0);
        for (const s of seen) expect(s.carry).toBe(-s.taken);
        expect(mockDb.pp.inventoryHeldAt).not.toBeNull();
    });
});
