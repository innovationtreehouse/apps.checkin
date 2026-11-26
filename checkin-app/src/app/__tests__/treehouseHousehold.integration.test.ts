/**
 * @jest-environment node
 *
 * A Treehouse account's household holds only that account, and no family household
 * holds a Treehouse account: the Board and sysadmins cannot add, move or merge anyone
 * into it, nor give someone in a family's household a Treehouse sign-in, while the
 * same actions on an ordinary household still go through.
 */
import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { POST as addParticipant } from "@/app/api/membership-ops/participants/route";
import { POST as moveParticipant } from "@/app/api/membership-ops/participants/[id]/household/route";
import { POST as mergeParticipants } from "@/app/api/membership-ops/participants/merge/route";
import { GET as analyzeMerge } from "@/app/api/membership-ops/participants/merge/analyze/route";
import { PATCH as addHouseholdMember } from "@/app/api/household/route";
import { PUT as editParticipant } from "@/app/api/membership-ops/participants/[id]/route";
import { TREEHOUSE_HOUSEHOLD_REFUSAL, TREEHOUSE_SIGN_IN_REFUSAL } from "@/lib/household/treehouseAccount";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/email", () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = "treehouse-hh-it";
const session = getServerSession as jest.Mock;

let boardId: number;
let staffId: number;
let staffHouseholdId: number;
let familyLeadId: number;
let familyHouseholdId: number;
let loneId: number;

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
    return new Request(`http://localhost${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body) }) }) as unknown as NextRequest;
}

async function cleanup() {
    const households = await prisma.household.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const householdIds = households.map((h) => h.id);
    await prisma.personMerge.deleteMany({ where: { to: { householdId: { in: householdIds } } } });
    if (boardId) await prisma.auditLog.deleteMany({ where: { actorId: boardId } });
    await prisma.person.deleteMany({ where: { householdId: { in: householdIds } } });
    await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
}

beforeEach(async () => {
    await cleanup();
    const board = await prisma.person.create({
        data: { email: `board-${TAG}@example.com`, name: `${TAG} Board`, isDeclaredAdult: true, isBoardMember: true, household: { create: { name: `${TAG} board` } } },
    });
    boardId = board.id;
    const staff = await prisma.person.create({
        data: { email: `front-desk-${TAG}@innovationtreehouse.org`, name: `${TAG} Staff`, isDeclaredAdult: true, isHouseholdLead: true, household: { create: { name: `${TAG} staff` } } },
    });
    staffId = staff.id;
    staffHouseholdId = staff.householdId;
    const lead = await prisma.person.create({
        data: { email: `lead-${TAG}@example.com`, name: `${TAG} Lead`, isDeclaredAdult: true, isHouseholdLead: true, household: { create: { name: `${TAG} family` } } },
    });
    familyLeadId = lead.id;
    familyHouseholdId = lead.householdId;
    const lone = await prisma.person.create({
        data: { name: `${TAG} Lone`, isDeclaredAdult: true, household: { create: { name: `${TAG} lone` } } },
    });
    loneId = lone.id;
    session.mockResolvedValue({ user: { id: boardId, isBoardMember: true, isSysadmin: false } });
});

afterAll(cleanup);

describe("Board participant add", () => {
    const add = (body: Record<string, unknown>) => addParticipant(jsonReq("/api/membership-ops/participants", "POST", body));

    it("refuses adding a person to a Treehouse account's household, creating nobody", async () => {
        const res = await add({ name: `${TAG} Kid`, over25: true, householdId: staffHouseholdId });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe(TREEHOUSE_HOUSEHOLD_REFUSAL);
        expect(await prisma.person.count({ where: { householdId: staffHouseholdId } })).toBe(1);
    });

    it("refuses a Treehouse account as the parent", async () => {
        const res = await add({ name: `${TAG} Kid`, dob: "2015-01-01", parentEmail: `front-desk-${TAG}@innovationtreehouse.org` });
        expect(res.status).toBe(409);
        expect(await prisma.person.count({ where: { householdId: staffHouseholdId } })).toBe(1);
    });

    it("still adds a person to an ordinary household", async () => {
        const res = await add({ name: `${TAG} Kid`, over25: true, householdId: familyHouseholdId });
        expect(res.status).toBe(200);
        expect(await prisma.person.count({ where: { householdId: familyHouseholdId } })).toBe(2);
    });
});

describe("Board household move", () => {
    const move = (personId: number, householdId: number) =>
        moveParticipant(jsonReq(`/api/membership-ops/participants/${personId}/household`, "POST", { householdId }), { params: Promise.resolve({ id: String(personId) }) });

    it("refuses moving a person into a Treehouse account's household, leaving them where they were", async () => {
        const res = await move(loneId, staffHouseholdId);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe(TREEHOUSE_HOUSEHOLD_REFUSAL);
        const after = await prisma.person.findUniqueOrThrow({ where: { id: loneId }, select: { householdId: true } });
        expect(after.householdId).not.toBe(staffHouseholdId);
    });

    it("still moves a person into an ordinary household", async () => {
        const res = await move(loneId, familyHouseholdId);
        expect(res.status).toBe(200);
        const after = await prisma.person.findUniqueOrThrow({ where: { id: loneId }, select: { householdId: true } });
        expect(after.householdId).toBe(familyHouseholdId);
    });
});

describe("Board person merge", () => {
    const merge = (keepId: number, mergeId: number, fieldChoices: Record<string, string> = { name: "keep" }) =>
        mergeParticipants(jsonReq("/api/membership-ops/participants/merge", "POST", { keepId, mergeId, fieldChoices }));
    const analyze = (a: number, b: number) => analyzeMerge(jsonReq(`/api/membership-ops/participants/merge/analyze?a=${a}&b=${b}`, "GET"));

    it("refuses merging a record that shares a household with others into a Treehouse account, and analyze reports it", async () => {
        const kin = await prisma.person.create({ data: { name: `${TAG} Kin`, isDeclaredAdult: true, householdId: familyHouseholdId } });
        const preview = await (await analyze(staffId, kin.id)).json();
        expect(preview.membershipBlock.aAsKeeper).toMatch(/Treehouse account's household/);

        const res = await merge(staffId, kin.id);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/Treehouse account's household/);
        expect(await prisma.person.findUnique({ where: { id: kin.id }, select: { id: true } })).not.toBeNull();
    });

    it("merges the Treehouse account's own duplicate, alone in its household, into the account", async () => {
        const preview = await (await analyze(staffId, loneId)).json();
        expect(preview.membershipBlock.aAsKeeper).toBeNull();

        const res = await merge(staffId, loneId);
        expect(res.status).toBe(200);
        expect(await prisma.person.findUnique({ where: { id: loneId }, select: { id: true } })).toBeNull();
        expect(await prisma.person.count({ where: { householdId: staffHouseholdId } })).toBe(1);
    });

    it("refuses a merge that hands a family-household record with no sign-in the Treehouse account's, and analyze reports it", async () => {
        const preview = await (await analyze(loneId, staffId)).json();
        expect(preview.membershipBlock.aAsKeeper).toMatch(/Treehouse account's sign-in/);

        const res = await merge(loneId, staffId);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/Treehouse account's sign-in/);
        expect(await prisma.person.findUnique({ where: { id: staffId }, select: { id: true } })).not.toBeNull();
    });

    it("refuses a merge where a family-household keeper chooses the Treehouse account's sign-in", async () => {
        const res = await merge(familyLeadId, staffId, { name: "keep", identity: "merge" });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/Treehouse account's sign-in/);
        const lead = await prisma.person.findUniqueOrThrow({ where: { id: familyLeadId }, select: { email: true } });
        expect(lead.email).toBe(`lead-${TAG}@example.com`);
    });

    it("still merges a record from another household into an ordinary household", async () => {
        const preview = await (await analyze(familyLeadId, loneId)).json();
        expect(preview.membershipBlock.aAsKeeper).toBeNull();

        const res = await merge(familyLeadId, loneId);
        expect(res.status).toBe(200);
        expect(await prisma.person.findUnique({ where: { id: loneId }, select: { id: true } })).toBeNull();
    });
});

describe("Board email edit", () => {
    const edit = (personId: number, email: string) =>
        editParticipant(jsonReq(`/api/membership-ops/participants/${personId}`, "PUT", { email, emailChangeReason: "Address changed" }), { params: Promise.resolve({ id: String(personId) }) });

    it("refuses giving someone in a family's household a Treehouse address", async () => {
        const res = await edit(familyLeadId, `lead-${TAG}@innovationtreehouse.org`);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe(TREEHOUSE_SIGN_IN_REFUSAL);
        const lead = await prisma.person.findUniqueOrThrow({ where: { id: familyLeadId }, select: { email: true } });
        expect(lead.email).toBe(`lead-${TAG}@example.com`);
    });

    it("still changes a family member's email to an ordinary address", async () => {
        const res = await edit(familyLeadId, `lead-new-${TAG}@example.com`);
        expect(res.status).toBe(200);
        const lead = await prisma.person.findUniqueOrThrow({ where: { id: familyLeadId }, select: { email: true } });
        expect(lead.email).toBe(`lead-new-${TAG}@example.com`);
    });

    it("still changes the Treehouse account's own address", async () => {
        const res = await edit(staffId, `desk-${TAG}@innovationtreehouse.org`);
        expect(res.status).toBe(200);
    });
});

describe("self-service add", () => {
    it("still refuses a Treehouse account adding a household member", async () => {
        session.mockResolvedValue({ user: { id: staffId, email: `front-desk-${TAG}@innovationtreehouse.org` } });
        const res = await addHouseholdMember(jsonReq("/api/household", "PATCH", { memberName: `${TAG} Kid`, memberOver25: true }));
        expect(res.status).toBe(403);
        expect(await prisma.person.count({ where: { householdId: staffHouseholdId } })).toBe(1);
    });
});
