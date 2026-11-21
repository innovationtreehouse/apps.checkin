/**
 * @jest-environment node
 *
 * Node, not jsdom: execute.ts reaches @aws-sdk/client-s3 (via keyVolunteer.ts ->
 * agreementDocument), whose browser build jest cannot transform.
 */
import prisma from "@/lib/prisma";
import { notifyBoardOfYouthLeads } from "@/lib/membership/boardAlerts";
import type { AuthenticatedUser } from "@/types/auth";
import { executeMerge, type MergePlan } from "../execute";
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

/** A transaction client whose every relation is empty, serving the given Person rows. */
function emptyTx(people: Map<number, ReturnType<typeof subject>>) {
    const model = (name: string) => new Proxy({}, {
        get: (_t, method: string) => jest.fn(async (args?: { where?: { id?: number } }) => {
            if (name === "person" && method === "findUnique") return people.get(args?.where?.id ?? -1) ?? null;
            if (method === "findMany") return [];
            if (method === "findFirst" || method === "findUnique") return null;
            if (method === "count") return 0;
            if (method.endsWith("Many")) return { count: 0 };
            return { id: 1 };
        }),
    });
    return new Proxy({}, {
        get: (_t, key: string) => {
            if (key === "$queryRaw") return jest.fn(async () => [{ id: KEEP_ID }, { id: MERGE_ID }]);
            if (key === "$executeRaw") return jest.fn(async () => 0);
            return model(key);
        },
    });
}

describe("executeMerge youth-lead notice", () => {
    it("passes the keeper's date of birth as read under the merge lock", async () => {
        const underEighteen = new Date(Date.now() - 10 * 365 * 24 * 3600 * 1000);
        const planned = subject(KEEP_ID);
        const locked = subject(KEEP_ID, { dateOfBirth: underEighteen });
        const merge = subject(MERGE_ID);
        const tx = emptyTx(new Map([[KEEP_ID, locked], [MERGE_ID, merge], [ACTOR_ID, subject(ACTOR_ID, { householdId: ACTOR_HOUSEHOLD_ID })]]));
        jest.mocked(prisma.$transaction).mockImplementation(((fn: (client: unknown) => Promise<unknown>) => fn(tx)) as unknown as typeof prisma.$transaction);
        const plan: MergePlan = {
            keep: planned as unknown as KeepSubject,
            merge: merge as unknown as MergeSubject,
            choices: {},
            emailChangeReason: "",
        };
        const actor = { id: ACTOR_ID, isBoardMember: true, isSysadmin: true } as unknown as AuthenticatedUser;

        await executeMerge(plan, actor);

        expect(notifyBoardOfYouthLeads).toHaveBeenCalledWith([expect.objectContaining({ id: KEEP_ID, dateOfBirth: underEighteen })]);
    });
});
