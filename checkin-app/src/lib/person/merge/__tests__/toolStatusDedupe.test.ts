/**
 * @jest-environment node
 *
 * Node, not jsdom: execute.ts reaches @aws-sdk/client-s3 (via keyVolunteer.ts ->
 * agreementDocument), whose browser build jest cannot transform.
 */
import prisma from "@/lib/prisma";
import type { AuthenticatedUser } from "@/types/auth";
import { executeMerge, MergeRefusedError, type MergePlan } from "../execute";
import type { KeepSubject, MergeSubject } from "../plan";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { $transaction: jest.fn() } }));
jest.mock("@/lib/membership/boardAlerts", () => ({ notifyBoardOfYouthLeads: jest.fn() }));
jest.mock("@/lib/membership/settleHouseholdBg", () => ({ settleAfterEvent: jest.fn() }));
jest.mock("@/lib/membership/householdStatus", () => ({ lockAndFindDeniedHousehold: jest.fn() }));
jest.mock("@/lib/household/archiveGuard", () => ({ ...jest.requireActual("@/lib/household/archiveGuard"), lockLiveHouseholds: jest.fn() }));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock("@/lib/roles", () => ({ ...jest.requireActual("@/lib/roles"), lockBoardRoles: jest.fn(), trustStatus: jest.fn(async () => ({ isTrusted: false })) }));

const KEEP_ID = 1;
const MERGE_ID = 2;
const HOUSEHOLD_ID = 10;
const ACTOR_ID = 99;
const ACTOR_HOUSEHOLD_ID = 20;
const TOOL_ID = 7;

function subject(id: number, overrides: Record<string, unknown> = {}) {
    return {
        id,
        name: "Sam Rivera",
        email: null,
        googleId: null,
        emailVerified: null,
        phone: null,
        image: null,
        dateOfBirth: null,
        lastBackgroundCheck: null,
        lastWaiverSign: null,
        householdId: HOUSEHOLD_ID,
        isHouseholdLead: id === KEEP_ID,
        household: { id: HOUSEHOLD_ID, orgMembership: null, householdMembers: [] },
        programParticipants: [],
        programVolunteers: [],
        rsvps: [],
        toolStatuses: [],
        bgAttestations: [],
        bgAttestationsAsSubject: [],
        corporationLeads: [],
        corporationMembers: [],
        roles: [],
        ...overrides,
    };
}

function certified(personId: number) {
    return { toolStatuses: [{ personId, toolId: TOOL_ID, level: "CERTIFIED", tool: { name: "Lathe" } }] };
}

/** A transaction client whose every relation is empty except the given Person rows and ToolStatus delete count. */
function tx(people: Map<number, ReturnType<typeof subject>>, toolStatusDeleted: number, deleteMany: jest.Mock) {
    const model = (name: string) => new Proxy({}, {
        get: (_t, method: string) => {
            if (name === "toolStatus" && method === "deleteMany") return deleteMany.mockResolvedValue({ count: toolStatusDeleted });
            return jest.fn(async (args?: { where?: { id?: number } }) => {
                if (name === "person" && method === "findUnique") return people.get(args?.where?.id ?? -1) ?? null;
                if (method === "findMany") return [];
                if (method === "findFirst" || method === "findUnique") return null;
                if (method === "count") return 0;
                if (method.endsWith("Many")) return { count: 0 };
                return { id: 1 };
            });
        },
    });
    return new Proxy({}, {
        get: (_t, key: string) => {
            if (key === "$queryRaw") return jest.fn(async () => [{ id: KEEP_ID }, { id: MERGE_ID }]);
            if (key === "$executeRaw") return jest.fn(async () => 0);
            return model(key);
        },
    });
}

async function runMerge(toolStatusDeleted: number, deleteMany: jest.Mock): Promise<void> {
    const keep = subject(KEEP_ID, certified(KEEP_ID));
    const merge = subject(MERGE_ID, certified(MERGE_ID));
    const client = tx(new Map([[KEEP_ID, keep], [MERGE_ID, merge], [ACTOR_ID, subject(ACTOR_ID, { householdId: ACTOR_HOUSEHOLD_ID })]]), toolStatusDeleted, deleteMany);
    jest.mocked(prisma.$transaction).mockImplementation(((fn: (c: unknown) => Promise<unknown>) => fn(client)) as unknown as typeof prisma.$transaction);
    const plan: MergePlan = {
        keep: keep as unknown as KeepSubject,
        merge: merge as unknown as MergeSubject,
        choices: {},
        emailChangeReason: "",
    };
    const actor = { id: ACTOR_ID, isBoardMember: true, isSysadmin: true } as unknown as AuthenticatedUser;
    await executeMerge(plan, actor);
}

describe("executeMerge same-level tool certification", () => {
    it("deletes the merged-away row only at the level read under the lock", async () => {
        const deleteMany = jest.fn();
        await runMerge(1, deleteMany);
        expect(deleteMany).toHaveBeenCalledWith({ where: { toolId: TOOL_ID, personId: MERGE_ID, level: "CERTIFIED" } });
    });

    it("refuses the merge when the level changed after the read", async () => {
        await expect(runMerge(0, jest.fn())).rejects.toBeInstanceOf(MergeRefusedError);
    });
});
