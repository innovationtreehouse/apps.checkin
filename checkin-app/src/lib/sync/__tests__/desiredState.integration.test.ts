/** @jest-environment node */
import prisma from "@/lib/prisma";
import { computeDesiredState, type DesiredTarget } from "../desiredState";

const TAG = `ds${Date.now()}`;
const NOW = new Date(Date.UTC(2026, 11, 15));
const ADULT = new Date(Date.UTC(1985, 0, 1));
const TEEN = new Date(Date.UTC(2011, 0, 1)); // 15
const KID = new Date(Date.UTC(2018, 0, 1)); // 8
const addr = (n: string) => `${n}-${TAG}@lists.example.org`;

describe("computeDesiredState", () => {
    const id: Record<string, number> = {};
    const households: number[] = [];
    let programIds: number[] = [];
    let saved: { membersGoogleGroupEmail: string | null; newsletterGoogleGroupEmail: string | null; orgMembershipYearBoundary: Date | null } | null;

    async function household(name: string, o: { status?: "ACTIVE" | "NONE"; settled?: boolean; archived?: boolean } = {}) {
        const hh = await prisma.household.create({ data: { name: `${TAG} ${name}`, archivedAt: o.archived ? NOW : null } });
        households.push(hh.id);
        if (o.status) {
            const ms = await prisma.orgMembership.create({ data: { householdId: hh.id, status: o.status } });
            if (o.settled) await prisma.orgMembershipProcess.create({ data: { orgMembershipId: ms.id, kind: "RENEWAL", status: "ACTIVE", appliesToYear: 2026 } });
        }
        return hh.id;
    }
    async function person(key: string, householdId: number, data: { dob?: Date; lead?: boolean; email?: boolean } = {}) {
        const p = await prisma.person.create({
            data: {
                name: `${TAG} ${key}`, householdId, dateOfBirth: data.dob ?? ADULT, isHouseholdLead: data.lead ?? false,
                email: data.email === false ? null : `${key}-${TAG}@people.example.org`,
            },
        });
        id[key] = p.id;
    }
    const find = (all: DesiredTarget[], kind: string, ref: string) => all.find((t) => t.targetKind === kind && t.targetRef === ref);
    const has = (t: DesiredTarget | undefined, key: string) => !!t?.members.some((m) => m.personId === id[key]);

    beforeAll(async () => {
        saved = await prisma.boardSettings.findUnique({
            where: { id: 1 },
            select: { membersGoogleGroupEmail: true, newsletterGoogleGroupEmail: true, orgMembershipYearBoundary: true },
        });
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, orgMembershipYearBoundary: new Date(Date.UTC(2026, 7, 1)), membersGoogleGroupEmail: addr("members"), newsletterGoogleGroupEmail: addr("news") },
            update: { orgMembershipYearBoundary: new Date(Date.UTC(2026, 7, 1)), membersGoogleGroupEmail: addr("members"), newsletterGoogleGroupEmail: addr("news") },
        });
        const current = await household("current", { status: "ACTIVE", settled: true });
        const lapsed = await household("lapsed", { status: "ACTIVE" });
        const former = await household("former");
        const archived = await household("archived", { status: "ACTIVE", settled: true, archived: true });
        const young = await household("young", { status: "NONE" });
        await person("curLead", current, { lead: true });
        await person("curTeen", current, { dob: TEEN });
        await person("curKid", current, { dob: KID });
        await person("curNoEmail", current, { email: false });
        await person("lapsedLead", lapsed, { lead: true });
        await person("formerLead", former, { lead: true });
        await person("archLead", archived, { lead: true });
        await person("youngLead", young, { lead: true });
        await person("youngKid", young, { dob: KID });
        await person("staff", former);
        await person("core", former);
        await person("leader", former);

        const mk = (name: string, extra: object) => prisma.program.create({
            data: { name: `${TAG} ${name}`, startAt: NOW, endAt: NOW, appliesToYear: 2026, phase: "RUNNING", ...extra },
        });
        const all = await mk("all", {
            participantsGoogleGroupEmail: addr("part"), parentsGoogleGroupEmail: addr("par"),
            mentorsGoogleGroupEmail: addr("men"), externalGoogleGroupEmail: addr("ext"), leadMentorId: id.leader,
            volunteers: { create: [{ personId: id.core, isCore: true }, { personId: id.staff, isCore: false }] },
            participants: { create: [
                { personId: id.curTeen, status: "ACTIVE" }, { personId: id.youngKid, status: "ACTIVE" },
                { personId: id.curKid, status: "PENDING" }, { personId: id.formerLead, status: "WITHDRAWN" },
            ] },
        });
        const none = await mk("none", { participants: { create: [{ personId: id.curLead, status: "ACTIVE" }] } });
        programIds = [all.id, none.id];
        await prisma.programExternalContact.create({ data: { programId: all.id, email: `outside-${TAG}@elsewhere.example.org` } });
        await prisma.programExternalContact.create({ data: { programId: all.id, email: `removed-${TAG}@elsewhere.example.org`, removedAt: NOW } });
    });

    afterAll(async () => {
        await prisma.programExternalContact.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.programVolunteer.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.programParticipant.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.program.deleteMany({ where: { id: { in: programIds } } });
        await prisma.person.deleteMany({ where: { id: { in: Object.values(id) } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: households } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: households } } });
        await prisma.household.deleteMany({ where: { id: { in: households } } });
        if (saved) await prisma.boardSettings.update({ where: { id: 1 }, data: saved });
    });

    it("MEMBERS: current households only, 13+, with an email", async () => {
        const t = find(await computeDesiredState(prisma, NOW), "MEMBERS", addr("members"));
        expect(["curLead", "curTeen"].map((k) => has(t, k))).toEqual([true, true]);
        for (const k of ["curKid", "curNoEmail", "lapsedLead", "formerLead", "archLead", "youngLead"]) expect(has(t, k)).toBe(false);
    });

    it("NEWSLETTER: lapsed and former people too; never under 13, archived or email-less", async () => {
        const t = find(await computeDesiredState(prisma, NOW), "NEWSLETTER", addr("news"));
        for (const k of ["curLead", "curTeen", "lapsedLead", "formerLead", "youngLead", "staff"]) expect(has(t, k)).toBe(true);
        for (const k of ["curKid", "youngKid", "curNoEmail", "archLead"]) expect(has(t, k)).toBe(false);
    });

    it("program lists: participants 13+, leads of an 8-year-old, leader plus core, external contacts", async () => {
        const all = await computeDesiredState(prisma, NOW);
        const part = find(all, "PROGRAM_PARTICIPANTS", addr("part"));
        expect(has(part, "curTeen")).toBe(true);
        for (const k of ["youngKid", "curKid", "formerLead"]) expect(has(part, k)).toBe(false);
        const parents = find(all, "PROGRAM_PARENTS", addr("par"));
        expect(has(parents, "youngLead")).toBe(true);
        expect(has(parents, "curLead")).toBe(true);
        expect(has(parents, "formerLead")).toBe(false);
        const mentors = find(all, "PROGRAM_MENTORS", addr("men"));
        expect(["leader", "core"].map((k) => has(mentors, k))).toEqual([true, true]);
        expect(has(mentors, "staff")).toBe(false);
        expect(find(all, "PROGRAM_EXTERNAL", addr("ext"))?.members.map((m) => [m.personId, m.email])).toEqual([[null, `outside-${TAG}@elsewhere.example.org`]]);
    });

    it("MEMBERS with no year boundary set: ACTIVE alone, so the list is not emptied", async () => {
        await prisma.boardSettings.update({ where: { id: 1 }, data: { orgMembershipYearBoundary: null } });
        const t = find(await computeDesiredState(prisma, NOW), "MEMBERS", addr("members"));
        await prisma.boardSettings.update({ where: { id: 1 }, data: { orgMembershipYearBoundary: new Date(Date.UTC(2026, 7, 1)) } });
        expect(["curLead", "lapsedLead"].map((k) => has(t, k))).toEqual([true, true]);
        expect(has(t, "formerLead")).toBe(false);
    });

    it("a list with no address is no target", async () => {
        const all = await computeDesiredState(prisma, NOW);
        expect(all.filter((t) => t.targetRef.includes(TAG)).map((t) => t.targetKind).sort()).toEqual(
            ["MEMBERS", "NEWSLETTER", "PROGRAM_EXTERNAL", "PROGRAM_MENTORS", "PROGRAM_PARENTS", "PROGRAM_PARTICIPANTS"],
        );
        await prisma.boardSettings.update({ where: { id: 1 }, data: { newsletterGoogleGroupEmail: null } });
        expect(find(await computeDesiredState(prisma, NOW), "NEWSLETTER", addr("news"))).toBeUndefined();
    });
});
