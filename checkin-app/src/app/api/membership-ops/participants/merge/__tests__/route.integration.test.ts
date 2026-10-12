/**
 * @jest-environment node
 *
 * Node, not jsdom: the route's graph reaches @aws-sdk/client-s3 (via external.ts ->
 * agreementDocument), and jsdom resolves the SDK's `browser` export condition to an
 * ESM build jest cannot transform. Every SDK-touching suite here runs on node.
 */
import { POST } from "../route";
import { GET as analyzeGET } from "../analyze/route";
import { GET as searchGET } from "@/app/api/people/search/route";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";

jest.mock("next-auth/next");
const mockGetServerSession = getServerSession as jest.Mock;

// The background-check carryover below converges a held application, which sends the
// family a payment-open notice. Stub the transport, as every other membership suite does.
jest.mock("@/lib/email", () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

// runMatchAudit (matrix #17) gates on mirror.isConfigured() before touching the
// enrollment sweep this test cares about. The mirror itself (order-side) isn't
// what LIVE_PERSON changed, so it's stubbed to a trivial "configured, no orders"
// shape — real Prisma still runs the enrollment/membership queries against the
// live test DB, which is what actually proves the filter.
jest.mock("@/lib/shopifyRead/client", () => ({
    isConfigured: () => true,
    lineVariantStats: async () => ({ lines: 0, withVariant: 0 }),
    ordersForVariants: async () => [],
    orderLegacyIdsPresent: async () => new Set<string>(),
    ordersByLegacyIds: async () => [],
    minRealOrderLegacyId: async () => null,
}));
import { runMatchAudit } from "@/lib/finance/matchAudit";
import { orgMembershipStatusBlocksLogin } from "@/lib/orgMembership";
import { canReviewBackgroundChecks } from "@/lib/membership/review";
import type { OrgMembershipProcessStatus, OrgMembershipStatus } from "@/generated/prisma/client";

// Base fixture participants differ on name+email by design (realistic collision
// data for the field-picker tests below). name is a per-field conflict and both
// sides carry a login identity (an email), so a merge needs *some* resolution for
// both — default to "keep" for name and the identity unit; tests that specifically
// exercise fieldChoices validation pass their own map (including `{}` to
// deliberately hit the "missing choice" 400).
function mergeReq(keepId: number, mergeId: number, fieldChoices: Record<string, string> = { name: "keep", identity: "keep" }) {
    return new Request("http://localhost/api/membership-ops/participants/merge", {
        method: "POST",
        body: JSON.stringify({ keepId, mergeId, fieldChoices })
    }) as unknown as import("next/server").NextRequest;
}

function analyzeReq(a: number, b: number) {
    return new Request(`http://localhost/api/membership-ops/participants/merge/analyze?a=${a}&b=${b}`) as unknown as import("next/server").NextRequest;
}

describe("Merge Participants API", () => {
    let pKeepId: number;
    let pMergeId: number;
    let householdId: number;
    let actorId: number;
    // Extra rows/ids a given test creates beyond the base fixture — cleaned up
    // generically in afterEach so each test doesn't hand-roll teardown ordering.
    let extraPersonIds: number[];
    let extraHouseholdIds: number[];
    let createdProgramId: number | undefined;
    let createdToolId: number | undefined;
    let createdEventId: number | undefined;
    let createdCorporationId: number | undefined;
    let createdProcessIds: number[];

    beforeEach(async () => {
        extraPersonIds = [];
        extraHouseholdIds = [];
        createdProgramId = undefined;
        createdToolId = undefined;
        createdEventId = undefined;
        createdCorporationId = undefined;
        createdProcessIds = [];

        const hh = await prisma.household.create({ data: { name: "Merge Test Household" } });
        householdId = hh.id;

        // The actor lives OUTSIDE the merge subjects' household: the route refuses any
        // merge touching the actor's own household (conflict of interest, #1588).
        const actor = await prisma.person.create({
            data: {
                name: "Board Actor", email: "actor@example.com", isBoardMember: true,
                householdId: await makeHousehold("Merge Test Actor Household"),
            }
        });
        actorId = actor.id;

        mockGetServerSession.mockResolvedValue({
            user: { id: actorId, email: "actor@example.com", isBoardMember: true }
        });

        const pKeep = await prisma.person.create({
            data: { name: "Keep User", email: "keep@example.com", householdId: hh.id }
        });
        pKeepId = pKeep.id;

        const pMerge = await prisma.person.create({
            data: { name: "Merge User", email: "merge@example.com", phone: "123-456-7890", householdId: hh.id }
        });
        pMergeId = pMerge.id;
    });

    /** A second household for the membership-guard tests; no OrgMembership row reads as NONE. */
    async function makeHousehold(name: string, status?: OrgMembershipStatus): Promise<number> {
        const hh = await prisma.household.create({ data: { name } });
        extraHouseholdIds.push(hh.id);
        if (status) await prisma.orgMembership.create({ data: { householdId: hh.id, status } });
        return hh.id;
    }

    afterEach(async () => {
        const personIds = [pKeepId, pMergeId, actorId, ...extraPersonIds];

        // RESTRICT-FK children must go before their Person rows.
        await prisma.backgroundCheckAttestation.deleteMany({ where: { OR: [{ reviewerId: { in: personIds } }, { subjectPersonId: { in: personIds } }] } });
        await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.corporationLead.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.corporationMember.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.trustedAdultReview.deleteMany({ where: { householdId } });
        await prisma.trustedAdult.deleteMany({ where: { householdId } });
        await prisma.toolStatus.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.rSVP.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.visit.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.programParticipant.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.programVolunteer.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { OR: [{ id: { in: createdProcessIds } }, { subjectPersonId: { in: personIds } }] } });
        await prisma.auditLog.deleteMany({ where: { actorId } });
        // PersonMerge.toId is RESTRICT, so the archive row outranks its survivor here
        // exactly as it will in prod — teardown has to clear it first.
        await prisma.personMerge.deleteMany({ where: { OR: [{ toId: { in: personIds } }, { fromId: { in: personIds } }] } });
        // Account/Session cascade-delete with their Person; no manual step needed.
        await prisma.person.deleteMany({ where: { id: { in: personIds } } });

        if (createdEventId) await prisma.event.deleteMany({ where: { id: createdEventId } });
        if (createdToolId) await prisma.tool.deleteMany({ where: { id: createdToolId } });
        if (createdProgramId) await prisma.program.deleteMany({ where: { id: createdProgramId } });
        if (createdCorporationId) await prisma.corporation.deleteMany({ where: { id: createdCorporationId } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: [householdId, ...extraHouseholdIds] } } });
        if (householdId) await prisma.household.deleteMany({ where: { id: householdId } });
        if (extraHouseholdIds.length) await prisma.household.deleteMany({ where: { id: { in: extraHouseholdIds } } });
    });

    it("should successfully merge two participants", async () => {
        await prisma.visit.create({ data: { personId: pMergeId, arrivedAt: new Date() } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);

        const visits = await prisma.visit.findMany({ where: { personId: pKeepId } });
        expect(visits.length).toBe(1);

        const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
        expect(kept?.phone).toBe("123-456-7890");

        const merged = await prisma.person.findUnique({ where: { id: pMergeId } });
        expect(merged?.email).toContain("merged-");
        expect(merged?.email).toContain("@deleted.invalid");
        expect(merged?.phone).toBeNull();
        // decision 5: tombstone identity keeps its ORIGINAL name — no mangling.
        expect(merged?.name).toBe("Merge User");
        expect(merged?.mergedIntoId).toBe(pKeepId);
    });

    // #1456 phase 2b — the PersonMerge archive. The tombstone Person row is still
    // written here; 2b-3 deletes it and this table becomes the only record.
    describe("PersonMerge archive", () => {
        it("writes exactly one archive row, snapshotting identity as it stood", async () => {
            // UTC midnight: lastBackgroundCheck is @db.Date, so that is what the
            // column round-trips and what the snapshot must carry (1149 design).
            const bgDate = new Date("2026-03-04T00:00:00.000Z");
            await prisma.person.update({
                where: { id: pMergeId },
                data: { lastBackgroundCheck: bgDate, dateOfBirth: new Date("1990-01-01"), isKeyholder: true },
            });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            const rows = await prisma.personMerge.findMany({ where: { fromId: pMergeId } });
            expect(rows).toHaveLength(1);
            expect(rows[0].toId).toBe(pKeepId);
            expect(rows[0].mergedAt).toBeInstanceOf(Date);

            // Exact shape, not a subset: Decision 1 is that dateOfBirth stays OUT, and
            // only an exhaustive key assertion catches it being added back — that is
            // what would silently re-tier the whole Json column from pii to personal.
            expect(rows[0].snapshot).toEqual({
                name: "Merge User",
                email: "merge@example.com",
                lastBackgroundCheck: bgDate.toISOString(),
                isSysadmin: false,
                isBoardMember: false,
                isKeyholder: true,
                isBackgroundCheckReviewer: false,
            });
        });

        // The snapshot is taken BEFORE step 1's CAS, which mangles the email to
        // merged-*@deleted.invalid and zeroes the role mirrors. Archiving the
        // post-CAS row would record the sentinel address as the person's identity.
        it("snapshots the pre-merge identity, not the mangled tombstone", async () => {
            await POST(mergeReq(pKeepId, pMergeId));

            const row = await prisma.personMerge.findUnique({ where: { fromId: pMergeId } });
            const snap = row?.snapshot as { email: string };
            expect(snap.email).toBe("merge@example.com");
            expect(snap.email).not.toContain("deleted.invalid");
        });

        it("carries a null lastBackgroundCheck through rather than dropping the key", async () => {
            await POST(mergeReq(pKeepId, pMergeId));

            const row = await prisma.personMerge.findUnique({ where: { fromId: pMergeId } });
            expect(row?.snapshot).toMatchObject({ lastBackgroundCheck: null });
        });

        // The 2b-3 rehearsal: 2b-0 repointed every RESTRICT relation off the loser,
        // so the tombstone row is finally deletable — including for someone who had
        // scanned a badge, which is what RawBadgeLog used to make impossible. If this
        // starts failing, a new Person FK arrived without a merge disposition.
        it("leaves the tombstone Person row deletable, badge history and all", async () => {
            await prisma.rawBadgeLog.create({ data: { personId: pMergeId, location: "Main Entrance" } });
            await prisma.visit.create({ data: { personId: pMergeId, arrivedAt: new Date() } });

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            await expect(prisma.person.delete({ where: { id: pMergeId } })).resolves.toMatchObject({ id: pMergeId });
            // ...and the archive outlives it, which is the whole point.
            expect(await prisma.personMerge.findUnique({ where: { fromId: pMergeId } })).not.toBeNull();
        });

        // A→B then B→C. The archive answers "where is this person now", so A's row
        // follows B to C; leaving it on B would also pin B's Person row via the
        // RESTRICT on toId, blocking the very delete 2b-3 exists to do.
        it("repoints an earlier merge's archive row when its survivor is itself merged away", async () => {
            const pFinal = await prisma.person.create({
                data: { name: "Final User", email: "final@example.com", householdId },
            });
            extraPersonIds.push(pFinal.id);

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);
            expect((await POST(mergeReq(pFinal.id, pKeepId))).status).toBe(200);

            expect((await prisma.personMerge.findUnique({ where: { fromId: pMergeId } }))?.toId).toBe(pFinal.id);
            expect((await prisma.personMerge.findUnique({ where: { fromId: pKeepId } }))?.toId).toBe(pFinal.id);
            // fromId is @unique: two merges, two rows, no double-archive.
            expect(await prisma.personMerge.count({ where: { toId: pFinal.id } })).toBe(2);
        });
    });

    it("should write an AuditLog row capturing the merge (matrix 15)", async () => {
        await prisma.visit.create({ data: { personId: pMergeId, arrivedAt: new Date() } });
        // Authority the tombstone held: the merge zeroes it, so the audit row is the
        // only place it survives.
        await prisma.personRole.create({ data: { personId: pMergeId, role: "KEYHOLDER" } });
        await prisma.person.update({ where: { id: pMergeId }, data: { isKeyholder: true } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);

        const log = await prisma.auditLog.findFirst({
            where: { tableName: "Person", affectedEntityId: pKeepId, secondaryAffectedEntity: pMergeId }
        });
        expect(log).not.toBeNull();
        expect(log?.actorId).toBe(actorId);
        expect(log?.oldData).toMatchObject({ id: pMergeId, name: "Merge User", email: "merge@example.com" });
        const newData = log?.newData as { keepId: number; fieldChoices: Record<string, string>; moved: { visits: number; programParticipants: { migrated: number; left: number } } };
        expect(newData.keepId).toBe(pKeepId);
        expect(newData.fieldChoices).toEqual({ name: "keep", identity: "keep" });
        expect(newData.moved.visits).toBe(1);
        // Tallies use migrated/left, not the old `deleted` name.
        expect(newData.moved.programParticipants).toEqual({ migrated: 0, left: 0 });

        // Full pre-image of the merged-away Person: every field the merge
        // rewrites (tombstone) or moves (backfill), captured before either update.
        // The four role mirrors are in here because the merge rewrites them on both
        // sides — nothing is deleted, so this row is the only record of what
        // authority the merged-away record held.
        const PRE_IMAGE_KEYS = [
            "dateOfBirth", "email", "emailSuppressed", "emailVerified", "googleId",
            "householdId", "id", "image", "isHouseholdLead", "lastBackgroundCheck",
            "lastWaiverSign", "name", "phone",
            "isSysadmin", "isBoardMember", "isKeyholder", "isBackgroundCheckReviewer",
        ].sort();
        const oldData = log?.oldData as Record<string, unknown>;
        expect(Object.keys(oldData).sort()).toEqual([...PRE_IMAGE_KEYS, "keeper"].sort());
        expect(oldData.id).toBe(pMergeId);
        expect(oldData.email).toBe("merge@example.com");
        expect(oldData.phone).toBe("123-456-7890");
        // Recoverable authority: true in the pre-image, false on the row itself.
        expect(oldData.isKeyholder).toBe(true);
        expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.isKeyholder).toBe(false);

        // …and the keeper's own pre-image, since a field choice can overwrite it.
        const keeper = oldData.keeper as Record<string, unknown>;
        expect(Object.keys(keeper).sort()).toEqual(PRE_IMAGE_KEYS);
        expect(keeper.id).toBe(pKeepId);
        expect(keeper.name).toBe("Keep User");
    });

    it("should succeed when the MERGED side holds googleId+email and the keeper holds neither (prod P2002 repro)", async () => {
        // This is the exact prod failure: the keeper backfill used to copy
        // googleId/email onto the keeper BEFORE the tombstone cleared them off
        // the merge-side row, tripping the @unique constraint and surfacing as
        // a generic 500. Reordering (tombstone first) fixes it.
        // Keeper starts with no email/googleId of its own (beforeEach gives it one
        // by default) so the backfill actually has something to copy.
        await prisma.person.update({
            where: { id: pKeepId },
            data: { email: null, googleId: null }
        });
        await prisma.person.update({
            where: { id: pMergeId },
            data: { googleId: "google-conflict-id", email: "conflict@example.com" }
        });

        const req = new Request("http://localhost/api/membership-ops/participants/merge", {
            method: "POST",
            // name is a true conflict here (base fixture: "Keep User" vs "Merge
            // User") — the field-picker route 400s without an explicit choice.
            body: JSON.stringify({ keepId: pKeepId, mergeId: pMergeId, fieldChoices: { name: "keep" } })
        }) as unknown as import('next/server').NextRequest;

        const res = await POST(req);
        const data = await res.json();
        // Assert on the pair together so a failure's diff shows the response
        // body (was a console.error; folded into the assertion instead).
        expect({ status: res.status, data }).toEqual({ status: 200, data: { success: true } });

        const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
        expect(kept?.googleId).toBe("google-conflict-id");
        expect(kept?.email).toBe("conflict@example.com");

        const merged = await prisma.person.findUnique({ where: { id: pMergeId } });
        expect(merged?.googleId).toBeNull();
        expect(merged?.email).toContain("merged-");
        expect(merged?.email).toContain("@deleted.invalid");
    });

    // Matrix 1a (#1456): decision-bearing collisions refuse the merge.
    it("409s on decision-bearing collisions, naming every collision in the response", async () => {
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: "Merge Conflict Program" } });
        createdProgramId = program.id;
        const tool = await prisma.tool.create({ data: { name: "Conflict Tool" } });
        createdToolId = tool.id;
        const futureEvent = await prisma.event.create({
            data: { programId: program.id, name: "Future Event", startAt: new Date(Date.now() + 86400000), endAt: new Date(Date.now() + 90000000) },
        });
        createdEventId = futureEvent.id;
        const process = await prisma.orgMembershipProcess.create({ data: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW" } });
        createdProcessIds.push(process.id);

        await prisma.programParticipant.create({ data: { programId: program.id, personId: pKeepId } });
        await prisma.programParticipant.create({ data: { programId: program.id, personId: pMergeId } });
        await prisma.toolStatus.create({ data: { toolId: tool.id, personId: pKeepId, level: "BASIC" } });
        await prisma.toolStatus.create({ data: { toolId: tool.id, personId: pMergeId, level: "MAY_CERTIFY_OTHERS" } });
        await prisma.rSVP.create({ data: { eventId: futureEvent.id, personId: pKeepId, status: "ATTENDING" } });
        await prisma.rSVP.create({ data: { eventId: futureEvent.id, personId: pMergeId, status: "NOT_ATTENDING" } });
        await prisma.backgroundCheckAttestation.create({ data: { processId: process.id, reviewerId: pKeepId, result: "APPROVE" } });
        await prisma.backgroundCheckAttestation.create({ data: { processId: process.id, reviewerId: pMergeId, result: "REJECT" } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(409);
        const data = await res.json();
        const types = (data.collisions as { type: string }[]).map(c => c.type).sort();
        expect(types).toEqual(['bgAttestation', 'programParticipant', 'rsvp', 'toolStatus']);
        expect(data.error).toContain("Merge Conflict Program");
        expect(data.error).toContain("Conflict Tool");
        expect(data.error).toContain("Future Event");

        // Nothing moved — pre-transaction refusal.
        expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBeNull();
    });

    // Matrix 1b (#1456): bare-join collisions auto-dedupe — merge succeeds, duplicates deleted.
    it("auto-dedupes bare-join collisions (ProgramVolunteer, CorporationLead, CorporationMember)", async () => {
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: "Dedupe Program" } });
        createdProgramId = program.id;
        const corp = await prisma.corporation.create({ data: {} });
        createdCorporationId = corp.id;

        await prisma.programVolunteer.create({ data: { programId: program.id, personId: pKeepId } });
        await prisma.programVolunteer.create({ data: { programId: program.id, personId: pMergeId } });
        await prisma.corporationLead.create({ data: { corporationId: corp.id, personId: pKeepId } });
        await prisma.corporationLead.create({ data: { corporationId: corp.id, personId: pMergeId } });
        await prisma.corporationMember.create({ data: { corporationId: corp.id, personId: pKeepId } });
        await prisma.corporationMember.create({ data: { corporationId: corp.id, personId: pMergeId } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);

        // Duplicates deleted — one row per entity, on the keeper.
        expect(await prisma.programVolunteer.count({ where: { programId: program.id } })).toBe(1);
        expect(await prisma.corporationLead.count({ where: { corporationId: corp.id } })).toBe(1);
        expect(await prisma.corporationMember.count({ where: { corporationId: corp.id } })).toBe(1);

        // Surviving row is on the keeper.
        expect(await prisma.programVolunteer.findUnique({ where: { programId_personId: { programId: program.id, personId: pKeepId } } })).not.toBeNull();
        expect(await prisma.programVolunteer.findUnique({ where: { programId_personId: { programId: program.id, personId: pMergeId } } })).toBeNull();

        const log = await prisma.auditLog.findFirst({ where: { tableName: "Person", affectedEntityId: pKeepId, secondaryAffectedEntity: pMergeId } });
        const newData = log?.newData as { moved: Record<string, { migrated: number; deduped: number }> };
        expect(newData.moved.programVolunteers).toEqual({ migrated: 0, deduped: 1 });
        expect(newData.moved.corporationLeads).toEqual({ migrated: 0, deduped: 1 });
        expect(newData.moved.corporationMembers).toEqual({ migrated: 0, deduped: 1 });
    });

    // Matrix 1c (#1456): past RSVP collisions auto-dedupe; future RSVP collisions refuse.
    it("auto-dedupes past RSVP collisions, refuses future RSVP collisions", async () => {
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: "RSVP Program" } });
        createdProgramId = program.id;

        const pastEvent = await prisma.event.create({
            data: { programId: program.id, name: "Past Event", startAt: new Date(Date.now() - 86400000), endAt: new Date(Date.now() - 82800000) },
        });
        createdEventId = pastEvent.id;

        await prisma.rSVP.create({ data: { eventId: pastEvent.id, personId: pKeepId, status: "ATTENDING" } });
        await prisma.rSVP.create({ data: { eventId: pastEvent.id, personId: pMergeId, status: "NOT_ATTENDING" } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);

        // Past RSVP collision auto-deduped: keeper's row survives, merge-side deleted.
        expect(await prisma.rSVP.count({ where: { eventId: pastEvent.id } })).toBe(1);
        expect(await prisma.rSVP.findUnique({ where: { eventId_personId: { eventId: pastEvent.id, personId: pKeepId } } })).not.toBeNull();

        const log = await prisma.auditLog.findFirst({ where: { tableName: "Person", affectedEntityId: pKeepId, secondaryAffectedEntity: pMergeId } });
        const newData = log?.newData as { moved: Record<string, { migrated: number; deduped: number; left: number }> };
        expect(newData.moved.rsvps).toEqual({ migrated: 0, deduped: 1, left: 0 });
    });

    // Matrix 2: non-collision move — the row relinks to the keeper, not duplicated.
    it("moves a tombstone-only enrollment/tool/rsvp to the keeper (no collision)", async () => {
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: "Non-Collision Program" } });
        createdProgramId = program.id;
        const tool = await prisma.tool.create({ data: { name: "Tool" } });
        createdToolId = tool.id;
        const event = await prisma.event.create({
            data: { programId: program.id, name: "Event", startAt: new Date(), endAt: new Date(Date.now() + 3600000) },
        });
        createdEventId = event.id;

        // Only the MERGE side has these — nothing for the keeper to collide with.
        await prisma.programParticipant.create({ data: { programId: program.id, personId: pMergeId } });
        await prisma.toolStatus.create({ data: { toolId: tool.id, personId: pMergeId, level: "CERTIFIED" } });
        await prisma.rSVP.create({ data: { eventId: event.id, personId: pMergeId, status: "MAYBE" } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);

        expect(await prisma.programParticipant.findUnique({ where: { programId_personId: { programId: program.id, personId: pKeepId } } })).not.toBeNull();
        expect(await prisma.programParticipant.findUnique({ where: { programId_personId: { programId: program.id, personId: pMergeId } } })).toBeNull();
        expect((await prisma.toolStatus.findUnique({ where: { personId_toolId: { personId: pKeepId, toolId: tool.id } } }))?.level).toBe("CERTIFIED");
        expect((await prisma.rSVP.findUnique({ where: { eventId_personId: { eventId: event.id, personId: pKeepId } } }))?.status).toBe("MAYBE");
    });

    it("should fail to merge if merged user is the lead of a household with other members", async () => {
        await prisma.person.update({ where: { id: pMergeId }, data: { isHouseholdLead: true } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain("lead of a household with other members");
    });

    // The lead guard counts LIVE household members only: a tombstone left in the
    // household by an earlier merge is not another member.
    it("merges a household lead whose only other household row is a tombstone", async () => {
        const hh = await prisma.household.create({ data: { name: "Lead + Tombstone Household" } });
        extraHouseholdIds.push(hh.id);

        const lead = await prisma.person.create({
            data: { name: "Lead Person", householdId: hh.id, isHouseholdLead: true }
        });
        const ghost = await prisma.person.create({
            data: { name: "Already Merged", householdId: hh.id, mergedIntoId: pKeepId }
        });
        extraPersonIds.push(lead.id, ghost.id);

        // name is the only conflict — the lead carries no email/googleId, so the
        // keeper's identity is untouched and no `identity` choice is needed.
        const res = await POST(mergeReq(pKeepId, lead.id, { name: "keep" }));
        expect({ status: res.status, data: await res.json() }).toEqual({ status: 200, data: { success: true } });

        expect((await prisma.person.findUnique({ where: { id: lead.id } }))?.mergedIntoId).toBe(pKeepId);
        // ghost stays put — a tombstone is never cleaned up by a merge.
        expect((await prisma.person.findUnique({ where: { id: ghost.id } }))?.householdId).toBe(hh.id);
    });

    it("analyze omits a tombstoned household member from householdMembers", async () => {
        const hh = await prisma.household.create({ data: { name: "Analyze Tombstone Household" } });
        extraHouseholdIds.push(hh.id);

        const lead = await prisma.person.create({
            data: { name: "Analyze Lead", householdId: hh.id, isHouseholdLead: true }
        });
        const ghost = await prisma.person.create({
            data: { name: "Analyze Ghost", householdId: hh.id, mergedIntoId: pKeepId }
        });
        extraPersonIds.push(lead.id, ghost.id);

        const res = await analyzeGET(analyzeReq(pKeepId, lead.id));
        expect(res.status).toBe(200);
        const { participants } = await res.json();
        const members = participants[1].household.householdMembers as { id: number }[];
        expect(members.map(m => m.id)).toEqual([lead.id]);
    });

    // OrgMembership is 1:1 with Household and the merge never moves it: the tombstone
    // keeps its householdId, the keeper stays in its own household. Both resulting
    // harms depend on which side is merged away, so the guard is asymmetric.
    describe("household membership guard", () => {
        it("400s when the merged-away record is the last live member of an ACTIVE household (value stranded)", async () => {
            // Sole live member AND lead — the existing lead guard (lead + others > 0)
            // cannot see this shape.
            const memberHh = await makeHousehold("Paid Member Household", "ACTIVE");
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: memberHh, isHouseholdLead: true } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toContain("last live member");
            expect(data.error).toContain("ACTIVE");

            // Refused before the transaction: the ACTIVE membership still has a live
            // member, and the surviving human isn't sitting in the NONE household.
            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBeNull();
            expect(await prisma.person.count({ where: { householdId: memberHh, mergedIntoId: null } })).toBe(1);
        });

        it("400s on ACTIVE keeper vs ACTIVE merged-away when the merged-away side is its household's last live member", async () => {
            // Equal status on both sides, and still a stranding: the equality alone
            // says nothing about who is left to use the merged-away membership.
            await prisma.orgMembership.create({ data: { householdId, status: "ACTIVE" } });
            const otherActive = await makeHousehold("Other Active Household", "ACTIVE");
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: otherActive } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toContain("last live member");
            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBeNull();
        });

        it("counts only LIVE others: an ACTIVE household whose remaining members are all tombstones still blocks", async () => {
            const memberHh = await makeHousehold("Hollow Member Household", "ACTIVE");
            const alreadyMerged = await prisma.person.create({ data: { name: "Prior Tombstone", householdId: memberHh, mergedIntoId: pKeepId } });
            extraPersonIds.push(alreadyMerged.id);
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: memberHh } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toContain("last live member");
        });

        it("allows an ACTIVE household merge when another live member remains", async () => {
            const memberHh = await makeHousehold("Shared Member Household", "ACTIVE");
            const sibling = await prisma.person.create({ data: { name: "Sibling", householdId: memberHh } });
            extraPersonIds.push(sibling.id);
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: memberHh } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);
            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBe(pKeepId);
        });

        it("400s when the merged-away record's household is DENIED and the keeper's is NONE (restriction laundered)", async () => {
            const deniedHh = await makeHousehold("Denied Household", "DENIED");
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: deniedHh } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toContain("which restriction applies");
            expect(data.error).toContain("DENIED");

            // The login block is derived live from the person's household (authClaims),
            // so had the merge run, the surviving record would simply not be denied.
            const merged = await prisma.person.findUnique({ where: { id: pMergeId }, include: { household: { include: { orgMembership: true } } } });
            const kept = await prisma.person.findUnique({ where: { id: pKeepId }, include: { household: { include: { orgMembership: true } } } });
            expect(merged?.mergedIntoId).toBeNull();
            expect(orgMembershipStatusBlocksLogin(merged?.household?.orgMembership?.status)).toBe(true);
            expect(orgMembershipStatusBlocksLogin(kept?.household?.orgMembership?.status)).toBe(false);
        });

        it("400s when the KEEPER's household carries the restriction and the merged-away side is weaker", async () => {
            const revokedHh = await makeHousehold("Revoked Household", "REVOKED");
            await prisma.person.update({ where: { id: pKeepId }, data: { householdId: revokedHh } });
            const noneHh = await makeHousehold("Plain Household", "NONE");
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: noneHh } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toContain("REVOKED");
            expect(data.error).toContain("which restriction applies");
        });

        it("allows two restricted households at the same status to merge", async () => {
            // Both on fresh households — the fixture's own household holds the board
            // actor, and a household containing a board member cannot be DENIED.
            const keepDenied = await makeHousehold("Keeper Denied Household", "DENIED");
            await prisma.person.update({ where: { id: pKeepId }, data: { householdId: keepDenied } });
            const otherDenied = await makeHousehold("Other Denied Household", "DENIED");
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: otherDenied } });

            // Nothing of value is stranded by a live-empty DENIED household, and the
            // survivor stays denied either way — no restriction changes hands.
            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);
        });

        // The archetypal dedupe: createParticipantWithHousehold gives every fresh
        // Google sign-in its own membership-less household and makes them its lead,
        // so the duplicate is NONE and its own sole member.
        it("allows the ordinary dedupe — ACTIVE keeper, duplicate alone in its own membership-less household", async () => {
            await prisma.orgMembership.create({ data: { householdId, status: "ACTIVE" } });
            const dupHh = await makeHousehold("Duplicate's Own Household");
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: dupHh, isHouseholdLead: true } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);
            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBe(pKeepId);
        });

        it("allows the merge when one household has an explicit NONE row and the other has no membership at all", async () => {
            const noneHh = await makeHousehold("Explicit None Household", "NONE");
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: noneHh } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);
        });

        it("analyze reports the block per direction, so the picker can warn and point at the swap", async () => {
            // A alone in a NONE household, B alone in an ACTIVE one: merging B away
            // strands the membership, merging A away is the ordinary dedupe.
            const activeHh = await makeHousehold("Analyze Active Household", "ACTIVE");
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: activeHh } });

            const res = await analyzeGET(analyzeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.membershipBlock.aAsKeeper).toContain("last live member");
            expect(data.membershipBlock.bAsKeeper).toBeNull();

            // Back in one household, neither direction is blocked.
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId } });
            const clean = await analyzeGET(analyzeReq(pKeepId, pMergeId));
            expect((await clean.json()).membershipBlock).toEqual({ aAsKeeper: null, bAsKeeper: null });
        });
    });

    // The merge takes the newer lastBackgroundCheck of the two records, so merging is a
    // way to seat a background-check date on a person — with no second actor. Both
    // subjects are checked: the two need not share a household (#1588).
    describe("conflict of interest", () => {
        it("403s when the actor shares a household with the kept record", async () => {
            const tombstoneHh = await makeHousehold("Tombstone Household");
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: tombstoneHh } });
            await prisma.person.update({ where: { id: actorId }, data: { householdId } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(403);
            expect((await res.json()).error).toContain("your own household");

            // Refused before the transaction — nothing moved.
            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBeNull();
            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.email).toBe("merge@example.com");
        });

        it("403s when the actor shares a household with the merged-away record only", async () => {
            const keeperHh = await makeHousehold("Keeper Household");
            await prisma.person.update({ where: { id: pKeepId }, data: { householdId: keeperHh } });
            await prisma.person.update({ where: { id: actorId }, data: { householdId } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(403);
            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBeNull();
        });

        it("403s a sysadmin too — no role bypasses the rule", async () => {
            await prisma.person.update({ where: { id: actorId }, data: { householdId } });
            mockGetServerSession.mockResolvedValue({
                user: { id: actorId, email: "actor@example.com", isSysadmin: true, isBoardMember: true }
            });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(403);
            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBeNull();
        });

        it("allows the merge when the actor is outside both households", async () => {
            const tombstoneHh = await makeHousehold("Unrelated Household");
            await prisma.person.update({ where: { id: pMergeId }, data: { householdId: tombstoneHh } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);
            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBe(pKeepId);
        });
    });

    // Matrix 4
    it("400s on self-merge", async () => {
        const res = await POST(mergeReq(pKeepId, pKeepId));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe("Invalid participant IDs provided.");
    });

    // Matrix 5
    it("409s on double-merge / merging a tombstone, both directions, and on analyze", async () => {
        const res1 = await POST(mergeReq(pKeepId, pMergeId));
        expect(res1.status).toBe(200);

        // Third participant to attempt merging with the now-tombstoned pMergeId.
        const third = await prisma.person.create({ data: { name: "Third", householdId } });
        extraPersonIds.push(third.id);

        const asMergeId = await POST(mergeReq(third.id, pMergeId));
        expect(asMergeId.status).toBe(409);

        const asKeepId = await POST(mergeReq(pMergeId, third.id));
        expect(asKeepId.status).toBe(409);

        const analyzeRes = await analyzeGET(analyzeReq(pMergeId, third.id));
        expect(analyzeRes.status).toBe(409);
    });

    it("analyze projects only what the merge picker reads — no raw Person/Household rows", async () => {
        // The fixture must actually SET the sensitive fields, or the negative
        // assertions below pass vacuously and pin nothing.
        await prisma.household.update({
            where: { id: householdId },
            data: { intakeNotes: "family notes, not for the merge screen", line1: "1 Secret Ln" }
        });
        await prisma.person.update({
            where: { id: pKeepId },
            data: { allergies: "peanuts", googleId: "google-keep-1", dateOfBirth: new Date("2001-02-03") }
        });
        await prisma.person.update({
            where: { id: pMergeId },
            data: { allergies: "latex", googleId: "google-merge-2", dateOfBirth: new Date("2002-03-04") }
        });
        await prisma.visit.create({ data: { personId: pKeepId, arrivedAt: new Date() } });

        const res = await analyzeGET(analyzeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);
        const { participants } = await res.json();
        const hit = participants[0];
        expect(hit.id).toBe(pKeepId);

        // Stripped: nothing on this screen reads any of these.
        expect(hit.allergies).toBeUndefined();
        expect(hit.notificationSettings).toBeUndefined();
        expect(hit.lastBackgroundCheck).toBeUndefined();
        expect(hit.household.intakeNotes).toBeUndefined();
        expect(hit.household.line1).toBeUndefined();
        const member = hit.household.householdMembers.find((m: { id: number }) => m.id === pMergeId);
        expect(member.googleId).toBeUndefined();
        expect(member.dateOfBirth).toBeUndefined();
        expect(member.email).toBeUndefined();
        expect(member.allergies).toBeUndefined();

        // Surviving: the conflict picker's inputs and the keep/merge score.
        expect(hit.googleId).toBe("google-keep-1");
        expect(hit.dateOfBirth).toBeTruthy();
        expect(hit.name).toBe("Keep User");
        expect(hit.email).toBe("keep@example.com");
        expect(member).toHaveProperty("isHouseholdLead");
        expect(member.name).toBe("Merge User");
        expect(hit.household.name).toBe("Merge Test Household");
        expect(hit._count.visits).toBe(1);
        expect(hit._count.programParticipants).toBe(0);
    });

    // #1456: analyze reports collisions up front so the UI can warn before the operator commits.
    it("analyze returns collisions for decision-bearing overlaps", async () => {
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: "Collision Analysis Program" } });
        createdProgramId = program.id;
        const tool = await prisma.tool.create({ data: { name: "Collision Analysis Tool" } });
        createdToolId = tool.id;

        await prisma.programParticipant.create({ data: { programId: program.id, personId: pKeepId } });
        await prisma.programParticipant.create({ data: { programId: program.id, personId: pMergeId } });
        await prisma.toolStatus.create({ data: { toolId: tool.id, personId: pKeepId, level: "BASIC" } });
        await prisma.toolStatus.create({ data: { toolId: tool.id, personId: pMergeId, level: "CERTIFIED" } });

        const res = await analyzeGET(analyzeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);
        const data = await res.json();
        const types = (data.collisions as { type: string }[]).map(c => c.type).sort();
        expect(types).toEqual(['programParticipant', 'toolStatus']);
        expect(data.collisions[0].message).toBeTruthy();
    });

    // Matrix 6
    it("concurrent double-merge: exactly one CAS wins, the other 409s and rolls back", async () => {
        const keep2 = await prisma.person.create({ data: { name: "Keep Two", householdId } });
        extraPersonIds.push(keep2.id);

        const [resA, resB] = await Promise.all([
            POST(mergeReq(pKeepId, pMergeId)),
            POST(mergeReq(keep2.id, pMergeId)),
        ]);

        const statuses = [resA.status, resB.status].sort();
        expect(statuses).toEqual([200, 409]);

        const tombstone = await prisma.person.findUnique({ where: { id: pMergeId } });
        const winnerId = resA.status === 200 ? pKeepId : keep2.id;
        expect(tombstone?.mergedIntoId).toBe(winnerId);
    });

    // Matrix 7
    it("merge chain A→B→C: provenance and moved rows both follow to the terminal record", async () => {
        const c = await prisma.person.create({ data: { name: "Terminal C", householdId } });
        extraPersonIds.push(c.id);

        await prisma.visit.create({ data: { personId: pMergeId, arrivedAt: new Date(Date.now() - 86400000), departedAt: new Date(Date.now() - 80000000) } });

        // A (pMergeId) merges into B (pKeepId).
        const res1 = await POST(mergeReq(pKeepId, pMergeId));
        expect(res1.status).toBe(200);

        // B (pKeepId) merges into C.
        const res2 = await POST(mergeReq(c.id, pKeepId));
        expect(res2.status).toBe(200);

        const a = await prisma.person.findUnique({ where: { id: pMergeId } });
        const b = await prisma.person.findUnique({ where: { id: pKeepId } });
        expect(a?.mergedIntoId).toBe(pKeepId);
        expect(b?.mergedIntoId).toBe(c.id);

        // A's visit moved to B on the first merge, then on to C on the second.
        const visitsOnC = await prisma.visit.findMany({ where: { personId: c.id } });
        expect(visitsOnC.length).toBe(1);
        expect(await prisma.visit.count({ where: { personId: pMergeId } })).toBe(0);
        expect(await prisma.visit.count({ where: { personId: pKeepId } })).toBe(0);
    });

    // Matrix 8
    describe("fieldChoices validation", () => {
        it("400s on an unknown field key", async () => {
            const res = await POST(mergeReq(pKeepId, pMergeId, { notAField: "keep" }));
            expect(res.status).toBe(400);
        });

        it("400s on an invalid choice value", async () => {
            const res = await POST(mergeReq(pKeepId, pMergeId, { phone: "x" }));
            expect(res.status).toBe(400);
        });

        it("400s when a true conflict has no choice", async () => {
            // name differs and is non-null on both sides ("Keep User" vs "Merge User").
            const res = await POST(mergeReq(pKeepId, pMergeId, {}));
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toContain("name");
        });

        it("identity 'merge' adopts the tombstone's email with no P2002 (clear-first ordering proven)", async () => {
            const res = await POST(mergeReq(pKeepId, pMergeId, { name: "keep", identity: "merge" }));
            expect(res.status).toBe(200);
            const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
            expect(kept?.email).toBe("merge@example.com");
        });

        it("identity 'keep' leaves the keeper's value", async () => {
            const res = await POST(mergeReq(pKeepId, pMergeId, { name: "keep", identity: "keep" }));
            expect(res.status).toBe(200);
            const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
            expect(kept?.email).toBe("keep@example.com");
            expect(kept?.name).toBe("Keep User");
        });
    });

    // #1225 failure #2: emailSuppressed is an opt-out tied to a specific address.
    // The login identity resolves as one unit, so suppression must ride with
    // whichever side's address wins — not stay stuck on the keeper's own.
    it("carries emailSuppressed with the identity when 'merge' wins", async () => {
        await prisma.person.update({ where: { id: pKeepId }, data: { emailSuppressed: false } });
        await prisma.person.update({ where: { id: pMergeId }, data: { emailSuppressed: true } });

        const res = await POST(mergeReq(pKeepId, pMergeId, { name: "keep", identity: "merge" }));
        expect(res.status).toBe(200);
        const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
        expect(kept?.email).toBe("merge@example.com");
        expect(kept?.emailSuppressed).toBe(true); // opt-out rode in with address B
    });

    it("backfills emailSuppressed with the identity when the keeper had no identity of its own", async () => {
        await prisma.person.update({ where: { id: pKeepId }, data: { email: null, emailSuppressed: false } });
        await prisma.person.update({ where: { id: pMergeId }, data: { emailSuppressed: true } });

        // name is the base-fixture conflict; the merge-side identity is backfilled
        // (keeper empty), so no `identity` radio is needed.
        const res = await POST(mergeReq(pKeepId, pMergeId, { name: "keep" }));
        expect(res.status).toBe(200);
        const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
        expect(kept?.email).toBe("merge@example.com");
        expect(kept?.emailSuppressed).toBe(true);
    });

    // Matrix 9 — the login identity (email+googleId+emailVerified) resolves as ONE
    // unit, so a merge can never strand it: picking either side keeps a whole,
    // self-consistent identity. This proves it on the most adversarial shape — both
    // sides carry a full email+googleId — where the OLD per-field design could have
    // spliced keeper-email onto merge-googleId. Now `identity: "merge"` adopts the
    // merge side wholesale.
    it("does not strand the login identity on a full email+googleId conflict", async () => {
        await prisma.person.update({ where: { id: pKeepId }, data: { googleId: "g-keep" } });
        await prisma.person.update({ where: { id: pMergeId }, data: { googleId: "g-merge" } });
        const res = await POST(mergeReq(pKeepId, pMergeId, { name: "keep", identity: "merge" }));
        expect(res.status).toBe(200);
        const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
        expect(kept?.email).toBe("merge@example.com");
        expect(kept?.googleId).toBe("g-merge");
    });

    // #1225 identity-unit: email/googleId/emailVerified resolve together, never split.
    describe("login identity resolves as one unit (#1225)", () => {
        it("both sides Google, identity 'merge': keeper takes merge's email+googleId+emailVerified together, no cross-side split", async () => {
            const keepVerified = new Date("2026-01-01");
            const mergeVerified = new Date("2026-05-05");
            await prisma.person.update({ where: { id: pKeepId }, data: { googleId: "g-keep", emailVerified: keepVerified } });
            await prisma.person.update({ where: { id: pMergeId }, data: { googleId: "g-merge", emailVerified: mergeVerified } });

            const res = await POST(mergeReq(pKeepId, pMergeId, { name: "keep", identity: "merge" }));
            expect(res.status).toBe(200);

            const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
            // Every identity field came from the merge side — no field left over from the keeper.
            expect(kept?.email).toBe("merge@example.com");
            expect(kept?.googleId).toBe("g-merge");
            expect(kept?.emailVerified?.getTime()).toBe(mergeVerified.getTime());
            // The stale keeper stamp must NOT ride along on the swapped-in address.
            expect(kept?.emailVerified?.getTime()).not.toBe(keepVerified.getTime());

            // Tombstone carries no verified stamp for the sentinel address.
            const tomb = await prisma.person.findUnique({ where: { id: pMergeId } });
            expect(tomb?.emailVerified).toBeNull();
        });

        it("magic-link keeper (email, no googleId) + Google merge, identity 'merge': all three move as a unit", async () => {
            const mergeVerified = new Date("2026-06-06");
            // keeper: magic-link/imported — email + emailVerified, NO googleId.
            await prisma.person.update({ where: { id: pKeepId }, data: { googleId: null, emailVerified: new Date("2026-02-02") } });
            await prisma.person.update({ where: { id: pMergeId }, data: { googleId: "g-merge", emailVerified: mergeVerified } });

            const res = await POST(mergeReq(pKeepId, pMergeId, { name: "keep", identity: "merge" }));
            expect(res.status).toBe(200);

            const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
            expect(kept?.email).toBe("merge@example.com");
            expect(kept?.googleId).toBe("g-merge");
            expect(kept?.emailVerified?.getTime()).toBe(mergeVerified.getTime());
        });

        it("one-sided: empty keeper auto-adopts the merge side's email+googleId+emailVerified as a unit", async () => {
            const mergeVerified = new Date("2026-07-07");
            await prisma.person.update({ where: { id: pKeepId }, data: { email: null, googleId: null, emailVerified: null } });
            await prisma.person.update({ where: { id: pMergeId }, data: { googleId: "g-merge", emailVerified: mergeVerified } });

            // No identity choice needed (keeper has none); name is still a conflict.
            const res = await POST(mergeReq(pKeepId, pMergeId, { name: "keep" }));
            expect(res.status).toBe(200);

            const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
            expect(kept?.email).toBe("merge@example.com");
            expect(kept?.googleId).toBe("g-merge");
            expect(kept?.emailVerified?.getTime()).toBe(mergeVerified.getTime());
        });

        it("400s when both sides have a login identity but fieldChoices.identity is missing", async () => {
            // Base fixture: keeper and merge both have an email — an unavoidable identity conflict.
            const res = await POST(mergeReq(pKeepId, pMergeId, { name: "keep" }));
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toContain("identity");
        });
    });

    // Matrix 10
    it("auto-picks the newer lastBackgroundCheck/lastWaiverSign date (merge side newer)", async () => {
        const older = new Date("2026-01-01");
        const newer = new Date("2026-06-01");
        await prisma.person.update({ where: { id: pKeepId }, data: { lastBackgroundCheck: older, name: "Keep User" } });
        await prisma.person.update({ where: { id: pMergeId }, data: { lastBackgroundCheck: newer, name: "Keep User" } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);
        const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
        expect(kept?.lastBackgroundCheck?.getTime()).toBe(newer.getTime());
    });

    it("auto-picks the newer lastBackgroundCheck/lastWaiverSign date (keep side newer)", async () => {
        const older = new Date("2026-01-01");
        const newer = new Date("2026-06-01");
        await prisma.person.update({ where: { id: pKeepId }, data: { lastWaiverSign: newer, name: "Keep User" } });
        await prisma.person.update({ where: { id: pMergeId }, data: { lastWaiverSign: older, name: "Keep User" } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);
        const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
        expect(kept?.lastWaiverSign?.getTime()).toBe(newer.getTime());
    });

    // Matrix 11
    it("single-sided auto-backfill: keeper null, tombstone set -> keeper backfilled", async () => {
        // #1432 R3: a null-name Person is unrepresentable, so Matrix 11's name
        // arm retires — a set keeper name must survive; the null-backfill
        // behavior stays proven by the five still-nullable fields.
        const kA = await prisma.person.create({ data: { name: "Keeper Name", phone: null, dateOfBirth: null, image: null, googleId: null, email: null, householdId } });
        const kB = await prisma.person.create({
            data: {
                name: "Backfill Source", phone: "555-0100", dateOfBirth: new Date("1990-01-01"),
                image: "https://example.com/a.png", googleId: "g-backfill", email: "backfill@example.com", householdId,
            }
        });
        extraPersonIds.push(kA.id, kB.id);

        const res = await POST(mergeReq(kA.id, kB.id));
        expect(res.status).toBe(200);
        const kept = await prisma.person.findUnique({ where: { id: kA.id } });
        expect(kept?.name).toBe("Keeper Name");
        expect(kept?.phone).toBe("555-0100");
        expect(kept?.dateOfBirth?.toISOString()).toBe(new Date("1990-01-01").toISOString());
        expect(kept?.image).toBe("https://example.com/a.png");
        expect(kept?.googleId).toBe("g-backfill");
        expect(kept?.email).toBe("backfill@example.com");
    });

    // Matrix 12
    it("zero-rows-deleted invariant across every join table + moved relation", async () => {
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: "Invariant Program", leadMentorId: pMergeId } });
        createdProgramId = program.id;
        const corp = await prisma.corporation.create({ data: {} });
        createdCorporationId = corp.id;
        const process = await prisma.orgMembershipProcess.create({ data: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW" } });
        createdProcessIds.push(process.id);
        const bgProcess = await prisma.orgMembershipProcess.create({ data: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW", subjectPersonId: pMergeId } });
        createdProcessIds.push(bgProcess.id);

        await prisma.account.create({ data: { userId: pMergeId, type: "oauth", provider: "google", providerAccountId: "acct-invariant-1" } });
        await prisma.session.create({ data: { userId: pMergeId, sessionToken: "sess-invariant-1", expires: new Date(Date.now() + 86400000) } });
        await prisma.backgroundCheckAttestation.create({ data: { processId: process.id, reviewerId: pMergeId, result: "APPROVE" } });
        await prisma.corporationLead.create({ data: { corporationId: corp.id, personId: pMergeId } });
        await prisma.corporationMember.create({ data: { corporationId: corp.id, personId: pMergeId } });
        await prisma.trustedAdult.create({
            data: { householdId, trustedAdultPersonId: pMergeId, trustedAdultName: "Adult A", trustedAdultPhone: "555-0111", disclosedById: actorId, familyContext: "context" }
        });
        await prisma.trustedAdult.create({
            data: { householdId, trustedAdultName: "Adult B", trustedAdultPhone: "555-0112", disclosedById: pMergeId, familyContext: "context" }
        });
        await prisma.visit.create({ data: { personId: pMergeId, arrivedAt: new Date(Date.now() - 3600000), departedAt: new Date() } });

        // Session is deliberately excluded from this invariant: it's the one
        // relation the merge deletes rather than moves (see route.ts step 5) —
        // asserted separately below.
        const countAll = async () => ({
            account: await prisma.account.count({ where: { userId: { in: [pKeepId, pMergeId] } } }),
            bgAttestation: await prisma.backgroundCheckAttestation.count({ where: { reviewerId: { in: [pKeepId, pMergeId] } } }),
            corporationLead: await prisma.corporationLead.count({ where: { personId: { in: [pKeepId, pMergeId] } } }),
            corporationMember: await prisma.corporationMember.count({ where: { personId: { in: [pKeepId, pMergeId] } } }),
            orgMembershipProcess: await prisma.orgMembershipProcess.count({ where: { subjectPersonId: { in: [pKeepId, pMergeId] } } }),
            program: await prisma.program.count({ where: { leadMentorId: { in: [pKeepId, pMergeId] } } }),
            trustedAdult: await prisma.trustedAdult.count({ where: { OR: [{ trustedAdultPersonId: { in: [pKeepId, pMergeId] } }, { disclosedById: { in: [pKeepId, pMergeId] } }] } }),
            visit: await prisma.visit.count({ where: { personId: { in: [pKeepId, pMergeId] } } }),
        });

        const before = await countAll();
        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);
        const after = await countAll();

        expect(after).toEqual(before);

        // Sessions are the deliberate exception: deleted, not moved — no reason to
        // inherit a login session, and forcing re-login is smaller and safer.
        expect(await prisma.session.count({ where: { userId: { in: [pKeepId, pMergeId] } } })).toBe(0);
    });

    // #1456 slice 2b-0: relations the merge never repointed, so the fact stayed on a
    // record the app treats as nonexistent — and, for the RESTRICT and CASCADE ones,
    // made a later Person delete impossible or silently destructive.
    describe("repoints every Person relation (2b-0)", () => {
        /** Audit tallies for the merge just run. */
        const movedTallies = async () => {
            const log = await prisma.auditLog.findFirst({ where: { tableName: "Person", affectedEntityId: pKeepId, secondaryAffectedEntity: pMergeId } });
            return (log?.newData as { moved: Record<string, unknown> }).moved;
        };

        // RESTRICT: this row is what makes `DELETE FROM "Person"` fail for essentially
        // every real tombstone.
        it("moves RawBadgeLog scans to the survivor", async () => {
            await prisma.rawBadgeLog.create({ data: { personId: pMergeId, location: "front-desk" } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            expect(await prisma.rawBadgeLog.count({ where: { personId: pMergeId } })).toBe(0);
            expect((await prisma.rawBadgeLog.findFirst({ where: { personId: pKeepId } }))?.location).toBe("front-desk");
            expect(await movedTallies()).toMatchObject({ rawBadgeLogs: 1 });
        });

        // SET NULL: left behind, the audit fact becomes "nobody read the note".
        it("moves the intake-note acknowledgement (OrgMembershipProcess.noteAckById)", async () => {
            const process = await prisma.orgMembershipProcess.create({
                data: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW", noteAckById: pMergeId, noteAckAt: new Date() },
            });
            createdProcessIds.push(process.id);

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            expect((await prisma.orgMembershipProcess.findUnique({ where: { id: process.id } }))?.noteAckById).toBe(pKeepId);
            expect(await movedTallies()).toMatchObject({ noteAcks: 1 });
        });

        it("moves the attendance confirmation (Event.attendanceConfirmedById)", async () => {
            const event = await prisma.event.create({
                data: {
                    name: "Confirmed Event", startAt: new Date(Date.now() - 86400000), endAt: new Date(Date.now() - 82800000),
                    attendanceConfirmedById: pMergeId, attendanceConfirmedAt: new Date(),
                },
            });
            createdEventId = event.id;

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            expect((await prisma.event.findUnique({ where: { id: event.id } }))?.attendanceConfirmedById).toBe(pKeepId);
            expect(await movedTallies()).toMatchObject({ attendanceConfirmations: 1 });
        });

        it("moves the facility close's closer (FacilityClose.closedById)", async () => {
            const close = await prisma.facilityClose.create({ data: { closedAt: new Date(), closedById: pMergeId, via: "KIOSK" } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            expect((await prisma.facilityClose.findUnique({ where: { id: close.id } }))?.closedById).toBe(pKeepId);
            expect(await movedTallies()).toMatchObject({ facilityCloses: 1 });
            await prisma.facilityClose.delete({ where: { id: close.id } });
        });

        it("moves the trusted-adult board decision (TrustedAdultReview.decidedById)", async () => {
            const adult = await prisma.trustedAdult.create({
                data: { householdId, trustedAdultName: "Grandma", trustedAdultPhone: "555-0199", disclosedById: actorId, familyContext: "context" },
            });
            const review = await prisma.trustedAdultReview.create({
                data: { trustedAdultId: adult.id, householdId, kind: "INITIAL", decidedById: pMergeId },
            });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            expect((await prisma.trustedAdultReview.findUnique({ where: { id: review.id } }))?.decidedById).toBe(pKeepId);
            expect(await movedTallies()).toMatchObject({ trustedAdultDecisions: 1 });
        });

        // CASCADE: a role left on the tombstone is a security grant a later delete
        // would take with it, with no audit row.
        it("moves a PersonRole the survivor lacks, dedupes one it already holds, and loses none silently", async () => {
            await prisma.personRole.create({ data: { personId: pKeepId, role: "BOARD" } });
            await prisma.personRole.create({ data: { personId: pMergeId, role: "BOARD" } });
            await prisma.personRole.create({ data: { personId: pMergeId, role: "KEYHOLDER" } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            const surviving = await prisma.personRole.findMany({ where: { personId: { in: [pKeepId, pMergeId] } }, select: { personId: true, role: true } });
            expect(surviving.map(r => `${r.personId}:${r.role}`).sort()).toEqual([`${pKeepId}:BOARD`, `${pKeepId}:KEYHOLDER`]);
            // The dropped row is the duplicate grant, and the audit says so — the
            // KEYHOLDER grant is not quietly gone.
            expect(await movedTallies()).toMatchObject({ roles: { migrated: 1, deduped: 1 } });
        });

        // Ordering pin: the granter sweep runs AFTER the holder pass, so the stamp on
        // the row the dedupe just deleted is not counted as moved. Sweep-first would
        // report roleGrants: 1 for a row that no longer exists.
        it("does not count a granter stamp on a role row the dedupe deleted", async () => {
            await prisma.personRole.create({ data: { personId: pKeepId, role: "BOARD" } });
            await prisma.personRole.create({ data: { personId: pMergeId, role: "BOARD", grantedById: pMergeId } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            expect(await movedTallies()).toMatchObject({ roles: { migrated: 0, deduped: 1 }, roleGrants: 0 });
        });

        // Moving PersonRole rows directly bypasses applyRoleFlag (lib/roles.ts),
        // which is what normally dual-writes Person's legacy boolean mirrors. A
        // migrated BG_REVIEWER whose mirror stayed false could not attest
        // (canReviewBackgroundChecks reads the mirror) and dropped out of the
        // reviewer notification list.
        it("syncs Person's role mirrors on a migrated role, and clears the tombstone's", async () => {
            await prisma.personRole.create({ data: { personId: pMergeId, role: "BG_REVIEWER" } });
            await prisma.person.update({ where: { id: pMergeId }, data: { isBackgroundCheckReviewer: true } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            const kept = await prisma.person.findUnique({ where: { id: pKeepId } });
            const tombstone = await prisma.person.findUnique({ where: { id: pMergeId } });
            expect(kept?.isBackgroundCheckReviewer).toBe(true);
            expect(tombstone?.isBackgroundCheckReviewer).toBe(false);
            // End-to-end: the single predicate the API gate, the review service and
            // the UI all read (review.ts) — false here is ReviewError('not_reviewer').
            expect(canReviewBackgroundChecks(kept!)).toBe(true);
            expect(canReviewBackgroundChecks(tombstone!)).toBe(false);
        });

        it("leaves the survivor's mirror set when the role is deduped, and still clears the tombstone's", async () => {
            for (const personId of [pKeepId, pMergeId]) {
                await prisma.personRole.create({ data: { personId, role: "KEYHOLDER" } });
                await prisma.person.update({ where: { id: personId }, data: { isKeyholder: true } });
            }

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            expect((await prisma.person.findUnique({ where: { id: pKeepId } }))?.isKeyholder).toBe(true);
            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.isKeyholder).toBe(false);
        });

        // Written from the survivor's whole FINAL role set rather than patched per
        // migrated row, so a mirror an earlier merge already left stale is repaired —
        // in BOTH directions. The demote case is the one that matters for security: a
        // mirror reading true with no row behind it is retained privilege.
        it("heals a survivor mirror that had already drifted from its PersonRole rows (promote)", async () => {
            await prisma.personRole.create({ data: { personId: pKeepId, role: "BOARD" } });
            await prisma.person.update({ where: { id: pKeepId }, data: { isBoardMember: false } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            expect((await prisma.person.findUnique({ where: { id: pKeepId } }))?.isBoardMember).toBe(true);
        });

        // The lost-update race the in-transaction re-read exists to close: the
        // mirror write asserts all four flags at once, so sourcing it from the
        // pre-tx snapshot would re-assert a role revoked in the window as `true`
        // with no row behind it. Simulated by patching the snapshot itself — a
        // role the pre-tx read saw and the transaction cannot find is exactly what
        // a concurrent revoke leaves behind.
        it("does not re-assert a role revoked between the pre-tx read and the transaction", async () => {
            const realFindUnique = prisma.person.findUnique.bind(prisma.person) as unknown as (args: unknown) => Promise<Record<string, unknown> | null>;
            const spy = jest.spyOn(prisma.person, "findUnique").mockImplementation((async (args: unknown) => {
                const row = await realFindUnique(args);
                // Only the keeper's snapshot, and only when roles were requested.
                if (row && row.id === pKeepId && Array.isArray(row.roles)) {
                    (row.roles as { personId: number; role: string }[]).push({ personId: pKeepId, role: "SYSADMIN" });
                }
                return row;
            }) as unknown as typeof prisma.person.findUnique);

            try {
                const res = await POST(mergeReq(pKeepId, pMergeId));
                expect(res.status).toBe(200);
            } finally {
                spy.mockRestore();
            }

            // No SYSADMIN row was ever created, so the mirror must not claim one.
            expect(await prisma.personRole.count({ where: { personId: pKeepId, role: "SYSADMIN" } })).toBe(0);
            expect((await prisma.person.findUnique({ where: { id: pKeepId } }))?.isSysadmin).toBe(false);
        });

        it("heals a survivor mirror left true with no PersonRole row behind it (demote)", async () => {
            await prisma.person.update({ where: { id: pKeepId }, data: { isKeyholder: true } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            expect((await prisma.person.findUnique({ where: { id: pKeepId } }))?.isKeyholder).toBe(false);
        });

        it("moves the PersonRole granter stamp (grantedById)", async () => {
            await prisma.personRole.create({ data: { personId: actorId, role: "KEYHOLDER", grantedById: pMergeId } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            const granted = await prisma.personRole.findUnique({ where: { personId_role: { personId: actorId, role: "KEYHOLDER" } } });
            expect(granted?.grantedById).toBe(pKeepId);
            expect(await movedTallies()).toMatchObject({ roleGrants: 1 });
        });

        // The repoint AND the proof it isn't over-refused: two DIFFERENT reviewers each
        // naming one of the duplicate identities is an ordinary 2-of-N review.
        it("moves BackgroundCheckAttestation.subjectPersonId, even when another reviewer named the survivor", async () => {
            const reviewer2 = await prisma.person.create({ data: { name: "Second Reviewer", householdId: await makeHousehold("Reviewer Two Household") } });
            extraPersonIds.push(reviewer2.id);
            const process = await prisma.orgMembershipProcess.create({ data: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW" } });
            createdProcessIds.push(process.id);

            await prisma.backgroundCheckAttestation.create({ data: { processId: process.id, reviewerId: reviewer2.id, subjectPersonId: pKeepId, result: "APPROVE" } });
            const mergeSide = await prisma.backgroundCheckAttestation.create({ data: { processId: process.id, reviewerId: actorId, subjectPersonId: pMergeId, result: "APPROVE" } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            expect((await prisma.backgroundCheckAttestation.findUnique({ where: { id: mergeSide.id } }))?.subjectPersonId).toBe(pKeepId);
            expect(await prisma.backgroundCheckAttestation.count({ where: { processId: process.id, subjectPersonId: pKeepId } })).toBe(2);
            expect(await movedTallies()).toMatchObject({ bgAttestationSubjects: { migrated: 1, left: 0 } });
        });
    });

    // #1456 Decision 3: #1686's collision key was `processId` alone, so the subject
    // half of @@unique([processId, reviewerId, subjectPersonId]) went undetected.
    describe("subject-side attestation collision", () => {
        /** One reviewer attested BOTH records as the subject of one process. */
        const seedSubjectCollision = async () => {
            const process = await prisma.orgMembershipProcess.create({ data: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW" } });
            createdProcessIds.push(process.id);
            await prisma.backgroundCheckAttestation.create({ data: { processId: process.id, reviewerId: actorId, subjectPersonId: pKeepId, result: "APPROVE" } });
            await prisma.backgroundCheckAttestation.create({ data: { processId: process.id, reviewerId: actorId, subjectPersonId: pMergeId, result: "APPROVE" } });
            return process.id;
        };

        it("409s, naming the collision, and moves nothing", async () => {
            await seedSubjectCollision();

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(409);
            const data = await res.json();
            // Neither record is the REVIEWER here — only the widened key sees this.
            expect((data.collisions as { type: string }[]).map(c => c.type)).toEqual(['bgAttestationSubject']);
            expect(data.error).toContain("subject of the same background check");

            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBeNull();
            expect(await prisma.backgroundCheckAttestation.count({ where: { subjectPersonId: pMergeId } })).toBe(1);
        });

        it("analyze reports it too, so the picker warns before the operator commits", async () => {
            await seedSubjectCollision();

            const res = await analyzeGET(analyzeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);
            const { collisions } = await res.json();
            expect((collisions as { type: string }[]).map(c => c.type)).toEqual(['bgAttestationSubject']);
            expect(collisions[0].message).toContain("subject of the same background check");
        });
    });

    // One record REVIEWED an attestation naming the other as SUBJECT. Only one row
    // exists, so no unique constraint fires: the subjectPersonId repoint silently
    // makes reviewerId === subjectPersonId, and approvalsForSubject counts that
    // self-approval toward REQUIRED_APPROVALS.
    describe("cross-role attestation collision (reviewer of the other's own check)", () => {
        const seedCrossRole = async (reviewerId: number, subjectPersonId: number) => {
            const process = await prisma.orgMembershipProcess.create({ data: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW" } });
            createdProcessIds.push(process.id);
            return prisma.backgroundCheckAttestation.create({ data: { processId: process.id, reviewerId, subjectPersonId, result: "APPROVE" } });
        };

        it("409s when the KEEPER reviewed an attestation naming the merged-away record", async () => {
            const att = await seedCrossRole(pKeepId, pMergeId);

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(409);
            const data = await res.json();
            expect((data.collisions as { type: string }[]).map(c => c.type)).toEqual(['bgAttestationCrossRole']);
            expect(data.error).toContain("reviewer of their own background check");

            // The row is untouched — no self-review was created.
            const after = await prisma.backgroundCheckAttestation.findUnique({ where: { id: att.id } });
            expect(after?.subjectPersonId).toBe(pMergeId);
            expect(after?.reviewerId).not.toBe(after?.subjectPersonId);
            expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBeNull();
        });

        it("409s in the other direction too — merged-away record as reviewer, keeper as subject", async () => {
            await seedCrossRole(pMergeId, pKeepId);

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(409);
            expect(((await res.json()).collisions as { type: string }[]).map(c => c.type)).toEqual(['bgAttestationCrossRole']);
        });

        it("analyze reports it, both directions", async () => {
            await seedCrossRole(pKeepId, pMergeId);

            const res = await analyzeGET(analyzeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);
            const { collisions } = await res.json();
            expect((collisions as { type: string }[]).map(c => c.type)).toEqual(['bgAttestationCrossRole']);
            expect(collisions[0].message).toContain("reviewer of their own background check");

            // Direction-independent: the same pair swapped reports the same collision.
            const swapped = await analyzeGET(analyzeReq(pMergeId, pKeepId));
            expect(((await swapped.json()).collisions as { type: string }[]).map(c => c.type)).toEqual(['bgAttestationCrossRole']);
        });
    });

    // One human owes ONE background check: both sides can hold an open PERSON_BG, and
    // re-pointing both at the survivor would leave two concurrent 2-of-N reviews.
    describe("duplicate open PERSON_BG on both merge subjects", () => {
        const openPersonBg = (personId: number, extra: { status?: "PENDING_BG_REVIEW" | "BLOCKED"; bgConsentAt?: Date } = {}) =>
            prisma.orgMembershipProcess.create({
                data: { kind: "PERSON_BG", subjectPersonId: personId, status: extra.status ?? "PENDING_BG_REVIEW", bgConsentAt: extra.bgConsentAt ?? null },
            });

        const openForKeeper = () =>
            prisma.orgMembershipProcess.findMany({
                where: { kind: "PERSON_BG", subjectPersonId: pKeepId, status: { in: ["PENDING_BG_REVIEW", "BLOCKED"] } },
            });

        it("leaves the survivor exactly one open PERSON_BG, archiving the less-advanced row", async () => {
            const keeperProc = await openPersonBg(pKeepId);
            const tombstoneProc = await openPersonBg(pMergeId, { bgConsentAt: new Date() }); // further along: submitted for review
            createdProcessIds.push(keeperProc.id, tombstoneProc.id);

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            const open = await openForKeeper();
            expect(open.map(p => p.id)).toEqual([tombstoneProc.id]);

            // The loser is ARCHIVED (not deleted), with archiveApplication's audit shape
            // so the board can unarchive it if the merge picked wrong.
            const loser = await prisma.orgMembershipProcess.findUnique({ where: { id: keeperProc.id } });
            expect(loser?.status).toBe("ARCHIVED");
            expect(loser?.subjectPersonId).toBe(pKeepId);
            const log = await prisma.auditLog.findFirst({ where: { tableName: "OrgMembershipProcess", affectedEntityId: keeperProc.id } });
            expect(log?.oldData).toMatchObject({ status: "PENDING_BG_REVIEW" });
            expect(log?.newData).toMatchObject({ status: "ARCHIVED", survivorProcessId: tombstoneProc.id });

            const mergeLog = await prisma.auditLog.findFirst({ where: { tableName: "Person", affectedEntityId: pKeepId, secondaryAffectedEntity: pMergeId } });
            expect((mergeLog?.newData as { moved: { personBgArchived: number } }).moved.personBgArchived).toBe(1);
        });

        it("keeps the row with attestations when neither has consent", async () => {
            const keeperProc = await openPersonBg(pKeepId);
            const tombstoneProc = await openPersonBg(pMergeId);
            createdProcessIds.push(keeperProc.id, tombstoneProc.id);
            await prisma.backgroundCheckAttestation.create({ data: { processId: keeperProc.id, reviewerId: actorId, result: "APPROVE" } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            const open = await openForKeeper();
            expect(open.map(p => p.id)).toEqual([keeperProc.id]);
            // The reviewer's work is not orphaned onto the archived row.
            expect(await prisma.backgroundCheckAttestation.count({ where: { processId: keeperProc.id } })).toBe(1);
        });

        it("never archives a BLOCKED row in favour of an open review", async () => {
            const keeperProc = await openPersonBg(pKeepId, { bgConsentAt: new Date() });
            const tombstoneProc = await openPersonBg(pMergeId, { status: "BLOCKED" });
            createdProcessIds.push(keeperProc.id, tombstoneProc.id);

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            const open = await openForKeeper();
            // The rejection survives; the pending review is the one archived.
            expect(open.map(p => p.id)).toEqual([tombstoneProc.id]);
            expect((await prisma.orgMembershipProcess.findUnique({ where: { id: keeperProc.id } }))?.status).toBe("ARCHIVED");
        });

        it("leaves a single open PERSON_BG alone (nothing to resolve)", async () => {
            const tombstoneProc = await openPersonBg(pMergeId);
            createdProcessIds.push(tombstoneProc.id);

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            const open = await openForKeeper();
            expect(open.map(p => ({ id: p.id, status: p.status }))).toEqual([{ id: tombstoneProc.id, status: "PENDING_BG_REVIEW" }]);
        });
    });

    // #1396: the merge carries the newer lastBackgroundCheck onto the survivor, which can
    // make the household background-check fresh. Nothing re-derived the state that date
    // feeds, so a covered application stayed parked.
    describe("background-check carryover", () => {
        // Only month/day matter — nextBoundary projects it onto the coming year.
        const BOUNDARY_SEED = new Date(Date.UTC(2000, 7, 1));
        const RECHECK_MONTHS = 24;
        const FRESH = new Date();
        const STALE = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000);
        let savedSettings: { bgRecheckMonths: number; orgMembershipYearBoundary: Date | null } | null = null;
        let hadSettings = false;
        let membershipId: number;

        beforeAll(async () => {
            const prev = await prisma.boardSettings.findUnique({ where: { id: 1 } });
            hadSettings = !!prev;
            savedSettings = prev ? { bgRecheckMonths: prev.bgRecheckMonths, orgMembershipYearBoundary: prev.orgMembershipYearBoundary } : null;
            await prisma.boardSettings.upsert({
                where: { id: 1 },
                create: { id: 1, bgRecheckMonths: RECHECK_MONTHS, orgMembershipYearBoundary: BOUNDARY_SEED },
                update: { bgRecheckMonths: RECHECK_MONTHS, orgMembershipYearBoundary: BOUNDARY_SEED },
            });
        });

        afterAll(async () => {
            if (hadSettings && savedSettings) await prisma.boardSettings.update({ where: { id: 1 }, data: savedSettings });
            else await prisma.boardSettings.delete({ where: { id: 1 } }).catch(() => {});
        });

        beforeEach(async () => {
            // householdBgIsFresh asks about live household LEADS, so the keeper must be one
            // and must have no check of its own — the merge is what makes the household fresh.
            await prisma.person.update({ where: { id: pKeepId }, data: { isHouseholdLead: true, lastBackgroundCheck: null } });
            await prisma.person.update({ where: { id: pMergeId }, data: { lastBackgroundCheck: FRESH } });
            const membership = await prisma.orgMembership.create({ data: { householdId, status: "NONE" } });
            membershipId = membership.id;
        });

        afterEach(async () => {
            // The carryover's own audit rows (and advanceExternalIfComplete's system-actor
            // row) aren't covered by the outer teardown's actorId filter.
            await prisma.auditLog.deleteMany({ where: { tableName: "OrgMembershipProcess", affectedEntityId: { in: createdProcessIds } } });
        });

        async function makeApplication(status: OrgMembershipProcessStatus, extra: Record<string, unknown> = {}) {
            const process = await prisma.orgMembershipProcess.create({
                data: { orgMembershipId: membershipId, kind: "INITIAL", status, ...extra },
            });
            createdProcessIds.push(process.id);
            return process;
        }

        const reload = (id: number) => prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id } });

        it("stamps and advances a PENDING_EXTERNAL_ACTION row whose agreement is already signed", async () => {
            // The row's gate is met the instant bgClearedAt lands, and no later event would
            // re-fire the advance — a stamp alone would strand it one state further on.
            const process = await makeApplication("PENDING_EXTERNAL_ACTION", { contractSignedAt: new Date() });

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(process.id);
            expect(after.bgClearedAt).not.toBeNull();
            expect(after.status).toBe("PENDING_PAYMENT");
        });

        it("stamps an unsigned PENDING_EXTERNAL_ACTION row without moving its status", async () => {
            // The stamp is what lets the row advance on signature: a covered household
            // never records bgConsentAt, and advanceExternalIfComplete needs one or other.
            const process = await makeApplication("PENDING_EXTERNAL_ACTION");

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(process.id);
            expect(after.bgClearedAt).not.toBeNull();
            expect(after.status).toBe("PENDING_EXTERNAL_ACTION");
        });

        it("stamps a parallel-track PENDING_PAYMENT row, dropping it out of the reviewer queue", async () => {
            // Status is already correct here; the stamp IS the work — it ends the redundant
            // 2-of-N and pre-decides activate()'s ACTIVE-vs-PENDING_BG_CLEARANCE branch.
            const process = await makeApplication("PENDING_PAYMENT", { contractSignedAt: new Date(), bgConsentAt: new Date() });

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(process.id);
            expect(after.bgClearedAt).not.toBeNull();
            expect(after.status).toBe("PENDING_PAYMENT");
        });

        it("clears a PENDING_BG_REVIEW row with no attestations, moving the status in the same write", async () => {
            // Stamping bgClearedAt without moving the status would leave the row with no exit
            // but archival — out of the reviewer queue and past the board's own reset.
            const process = await makeApplication("PENDING_BG_REVIEW", { contractSignedAt: new Date() });

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(process.id);
            expect(after.bgClearedAt).not.toBeNull();
            expect(after.status).toBe("PENDING_PAYMENT");
        });

        it("leaves a PENDING_BG_REVIEW row a reviewer has already attested", async () => {
            const process = await makeApplication("PENDING_BG_REVIEW", { contractSignedAt: new Date() });
            await prisma.backgroundCheckAttestation.create({ data: { processId: process.id, reviewerId: actorId, result: "APPROVE", subjectPersonId: pKeepId } });

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(process.id);
            expect({ status: after.status, cleared: after.bgClearedAt }).toEqual({ status: "PENDING_BG_REVIEW", cleared: null });
        });

        it("carries the check over a household that has a live intake note (#1499)", async () => {
            // A note is shown to the reviewers and gates nothing, so it does not gate this
            // either — the same rule submitIntake's fresh-check shortcut follows.
            await prisma.household.update({ where: { id: householdId }, data: { intakeNotes: "please call us first" } });
            const process = await makeApplication("PENDING_PAYMENT", { contractSignedAt: new Date(), bgConsentAt: new Date() });

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(process.id);
            expect(after.bgClearedAt).not.toBeNull();
            expect(after.status).toBe("PENDING_PAYMENT");
        });

        it("stamps nothing when the carried check is outside the recheck window", async () => {
            await prisma.person.update({ where: { id: pMergeId }, data: { lastBackgroundCheck: STALE } });
            const process = await makeApplication("PENDING_BG_REVIEW", { contractSignedAt: new Date() });

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(process.id);
            expect({ status: after.status, cleared: after.bgClearedAt }).toEqual({ status: "PENDING_BG_REVIEW", cleared: null });
        });

        it("never unstamps or re-stamps an already-cleared row", async () => {
            // Advance-only. The household IS made fresh here, so the run reaches the
            // candidate query and the CAS — both of which filter bgClearedAt: null.
            // Drop either filter and this row gets re-stamped with today's date.
            const clearedAt = new Date(Date.now() - 30 * 24 * 3600 * 1000);
            const process = await makeApplication("PENDING_PAYMENT", { contractSignedAt: new Date(), bgConsentAt: new Date(), bgClearedAt: clearedAt });

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(process.id);
            expect(after.bgClearedAt?.getTime()).toBe(clearedAt.getTime());
            // Never in the candidate set at all, so no carryover audit row either.
            expect(await prisma.auditLog.count({ where: { tableName: "OrgMembershipProcess", affectedEntityId: process.id } })).toBe(0);
        });

        it("leaves a parked row alone when the household was ALREADY fresh before the merge", async () => {
            // The predicate is "did THIS merge make the household covered?", not "is it
            // covered?". A board reset re-opens a review on a household whose leads still
            // hold a valid check; stamping that row ends the re-review with no way back
            // (attest then throws wrong_phase) and blames a person who carried nothing in.
            await prisma.person.update({ where: { id: pKeepId }, data: { lastBackgroundCheck: FRESH } });
            await prisma.person.update({ where: { id: pMergeId }, data: { lastBackgroundCheck: null } });
            const process = await makeApplication("PENDING_PAYMENT", { contractSignedAt: new Date(), bgConsentAt: new Date() });

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(process.id);
            expect({ status: after.status, cleared: after.bgClearedAt }).toEqual({ status: "PENDING_PAYMENT", cleared: null });
            expect(await prisma.auditLog.count({ where: { tableName: "OrgMembershipProcess", affectedEntityId: process.id } })).toBe(0);
        });

        it("activates a paid PENDING_BG_CLEARANCE household, without dating anyone's own check", async () => {
            // The one state where the carried check is the SOLE block: dues are settled and
            // the membership sits INACTIVE. A stamp that doesn't converge leaves it there.
            const process = await makeApplication("PENDING_BG_CLEARANCE", { contractSignedAt: new Date(), bgConsentAt: new Date(), paidAt: new Date() });
            const child = await prisma.person.create({ data: { name: "Adult Child", householdId, isHouseholdLead: false } });
            extraPersonIds.push(child.id);

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(process.id);
            expect({ status: after.status, cleared: after.bgClearedAt !== null }).toEqual({ status: "ACTIVE", cleared: true });
            expect((await prisma.orgMembership.findUniqueOrThrow({ where: { id: membershipId } })).status).toBe("ACTIVE");
            // The clearance carries zero attestations, so it names no subject and stamps
            // no person. A household-wide stamp would date this child off a parent's check.
            expect((await prisma.person.findUniqueOrThrow({ where: { id: child.id } })).lastBackgroundCheck).toBeNull();
        });

        it("never touches a PERSON_BG re-pointed onto the survivor", async () => {
            // householdBgIsFresh asks about household LEADS. Answering it for an adult
            // child's own check would clear them because a parent's check is fresh.
            const personBg = await prisma.orgMembershipProcess.create({
                data: { kind: "PERSON_BG", subjectPersonId: pMergeId, status: "PENDING_BG_REVIEW", bgConsentAt: new Date() },
            });
            createdProcessIds.push(personBg.id);

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(personBg.id);
            expect({ status: after.status, cleared: after.bgClearedAt, subject: after.subjectPersonId })
                .toEqual({ status: "PENDING_BG_REVIEW", cleared: null, subject: pKeepId });
        });

        it("never touches a PERSON_AGREEMENT re-pointed onto the survivor", async () => {
            // The other orgMembership-less kind, and the one that shares a status with an
            // acting state. Every candidate query goes through orgMembership, which both
            // PERSON kinds sit outside; widening that scope would sign an adult child's
            // own agreement off a parent's background check.
            const agreement = await prisma.orgMembershipProcess.create({
                data: { kind: "PERSON_AGREEMENT", subjectPersonId: pMergeId, status: "PENDING_EXTERNAL_ACTION" },
            });
            createdProcessIds.push(agreement.id);
            await makeApplication("PENDING_BG_CLEARANCE", { contractSignedAt: new Date(), bgConsentAt: new Date(), paidAt: new Date() });

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const after = await reload(agreement.id);
            expect({ status: after.status, cleared: after.bgClearedAt, signed: after.contractSignedAt })
                .toEqual({ status: "PENDING_EXTERNAL_ACTION", cleared: null, signed: null });
        });

        it("attributes the carryover to the merging board member, naming the record it came from", async () => {
            const process = await makeApplication("PENDING_PAYMENT", { contractSignedAt: new Date(), bgConsentAt: new Date() });

            expect((await POST(mergeReq(pKeepId, pMergeId))).status).toBe(200);

            const log = await prisma.auditLog.findFirst({ where: { tableName: "OrgMembershipProcess", affectedEntityId: process.id } });
            expect(log?.actorId).toBe(actorId);
            expect(log?.actorSystem).toBeNull();
            expect(log?.secondaryAffectedEntity).toBe(householdId);
            expect(log?.newData).toMatchObject({ bgClearedAt: true, via: "merge", sourcePersonId: pMergeId });
        });
    });

    // Matrix 13 (#1456): both-open visits now refused.
    it("409s when both persons have an open visit", async () => {
        await prisma.visit.create({ data: { personId: pKeepId, arrivedAt: new Date(Date.now() - 3600000) } });
        await prisma.visit.create({ data: { personId: pMergeId, arrivedAt: new Date(Date.now() - 7200000) } });
        await prisma.visit.create({ data: { personId: pMergeId, arrivedAt: new Date(Date.now() - 10800000), departedAt: new Date(Date.now() - 9800000) } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(409);
        const data = await res.json();
        expect((data.collisions as { type: string }[]).some(c => c.type === 'openVisit')).toBe(true);
        expect((await prisma.person.findUnique({ where: { id: pMergeId } }))?.mergedIntoId).toBeNull();
    });

    // Matrix 13b: merge-side-only open visit migrates successfully.
    it("moves a merge-side open visit when keeper has no open visit", async () => {
        await prisma.visit.create({ data: { personId: pMergeId, arrivedAt: new Date(Date.now() - 7200000) } });
        await prisma.visit.create({ data: { personId: pMergeId, arrivedAt: new Date(Date.now() - 10800000), departedAt: new Date(Date.now() - 9800000) } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);

        const keeperVisits = await prisma.visit.findMany({ where: { personId: pKeepId } });
        expect(keeperVisits.length).toBe(2);
        expect(keeperVisits.filter(v => v.departedAt === null).length).toBe(1);
        expect(await prisma.visit.count({ where: { personId: pMergeId } })).toBe(0);
    });

    // Matrix 14
    it("accounts move: login-follows-survivor via the same query the NextAuth adapter uses", async () => {
        await prisma.account.create({ data: { userId: pMergeId, type: "oauth", provider: "google", providerAccountId: "acct-login-follow" } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);

        // getUserByAccount's exact query shape (auth-options.ts:103-108).
        const account = await prisma.account.findUnique({
            where: { provider_providerAccountId: { provider: "google", providerAccountId: "acct-login-follow" } },
            include: { user: true },
        });
        expect(account?.user?.id).toBe(pKeepId);

        // getUserByEmail's exact query shape (auth-options.ts:98-100) — placeholder, resolves nobody.
        const byOriginalEmail = await prisma.person.findUnique({ where: { email: "merge@example.com" } });
        expect(byOriginalEmail).toBeNull();
    });

    // Matrix 16 (representative subset — see final report for scope note)
    describe("consumer exclusion (§3 LIVE_PERSON)", () => {
        it("people/search omits a merged-away tombstone even when the query matches its (unchanged) name", async () => {
            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(200);

            mockGetServerSession.mockResolvedValue({ user: { id: actorId, isBoardMember: true } });
            const searchRes = await searchGET(new Request(`http://localhost/api/people/search?q=${encodeURIComponent("Merge User")}`) as unknown as import("next/server").NextRequest);
            expect(searchRes.status).toBe(200);
            const data = await searchRes.json();
            expect((data.people as { id: number }[]).some(p => p.id === pMergeId)).toBe(false);
        });

        // #1456: ProgramParticipant collision now refuses the merge entirely.
        it("enrollment collision refuses instead of leaving a tombstone seat", async () => {
            const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: "Cap Gate Program", maxParticipants: 5 } });
            createdProgramId = program.id;
            await prisma.programParticipant.create({ data: { programId: program.id, personId: pKeepId } });
            await prisma.programParticipant.create({ data: { programId: program.id, personId: pMergeId } });

            const res = await POST(mergeReq(pKeepId, pMergeId));
            expect(res.status).toBe(409);
            const data = await res.json();
            expect(data.error).toContain("Cap Gate Program");
        });
    });

    // Matrix 17 (#1456): collision-bearing merge refused, no tombstone residue to audit.
    it("match-audit: a non-colliding enrollment migrates to the keeper normally", async () => {
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: "Match Audit Program", shopifyVariantId: "variant-match-audit" } });
        createdProgramId = program.id;
        await prisma.programParticipant.create({ data: { programId: program.id, personId: pMergeId, status: "ACTIVE" } });

        const res = await POST(mergeReq(pKeepId, pMergeId));
        expect(res.status).toBe(200);

        const result = await runMatchAudit();
        expect(result.enrollments.some(e => e.personId === pMergeId)).toBe(false);
        expect(result.enrollments.some(e => e.personId === pKeepId && e.programId === program.id)).toBe(true);
    });
});
