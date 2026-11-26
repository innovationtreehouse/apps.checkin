import prisma from "@/lib/prisma";
import type { AuthenticatedUser } from "@/types/auth";
import type { DbClient, TxClient } from "@/lib/db-client";
import { fromWhere, personBgOpen } from "@/lib/membership/lifecycle";
import { KVA_KIND, findSignedCurrentKva } from "@/lib/membership/keyVolunteerProcess";
import { recallSigningRequests } from "@/lib/membership/keyVolunteer";
import { disputingReviews, loadCheckReviews } from "@/lib/membership/checkStanding";
import { settleAfterEvent } from "@/lib/membership/settleHouseholdBg";
import { findSelfGrantRefusal, recordSelfGrantRefusal, type SelfGrantRefusal } from "@/lib/membership/selfGrantGuard";
import { lockAndFindDeniedHousehold } from "@/lib/membership/householdStatus";
import { ArchivedHouseholdError, lockLiveHouseholds } from "@/lib/household/archiveGuard";
import { KIND_TO_FLAG, setRoleFlag, lockBoardRoles, RoleMatrixError, trustStatus } from "@/lib/roles";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { notifyBoardOfYouthLeads } from "@/lib/membership/boardAlerts";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { anyMergedAway } from "@/lib/person/archivedPeople";
import { isBlankEmail, leadsUnfinishedProgram, LEADER_EMAIL_REQUIRED, LEADER_NEEDS_EMAIL } from "@/lib/programs/leaderEligibility";
import { isTreehouseHousehold } from "@/lib/household/treehouseAccount";
import { bgSubjectKey, bringsOthersIntoKeeperHousehold, disputedCheckBlock, TREEHOUSE_MERGE_REFUSAL, type CheckSide } from "./guard";
import {
    KEEP_INCLUDE,
    MERGE_INCLUDE,
    findCollisions,
    mergeSnapshot,
    parseFieldChoices,
    personPreImage,
    planKeeperUpdate,
    roleMirrors,
    subjectRefusal,
    type FieldChoices,
    type KeepSubject,
    type MergeRefusal,
    type MergeSubject,
} from "./plan";

/** Thrown when either subject is gone under the lock: a concurrent or repeat merge won. */
export class AlreadyMergedError extends Error {}

/** Thrown when a subject refusal that passed in prepareMerge applies under the lock. */
export class MergeRefusedError extends Error {
    constructor(public readonly refusal: MergeRefusal) {
        super(refusal.error);
    }
}

/** A self-grant refusal found under the lock; executeMerge records it after the rollback. */
class SelfGrantMergeRefusedError extends MergeRefusedError {
    constructor(public readonly selfGrant: SelfGrantRefusal) {
        super(OWN_HOUSEHOLD);
    }
}

const OWN_HOUSEHOLD: MergeRefusal = { status: 403, error: "You cannot merge a record in your own household — someone outside your household must." };

const ALREADY_MERGED: MergeRefusal = { status: 409, error: "Cannot merge: one of these participants has already been merged." };

/** A row landed on the merged-away record between the plan and the move. */
const CHANGED_WHILE_MERGING: MergeRefusal = {
    status: 409,
    error: "Cannot merge: one of these participants changed while merging. Reload and try again.",
};

type LiveSubjects = { keep: KeepSubject; merge: MergeSubject; keeperUpdate: Record<string, unknown> };

export type MergePlan = {
    keep: KeepSubject;
    merge: MergeSubject;
    choices: FieldChoices;
    emailChangeReason: string;
};

/**
 * A trusted person's login email changes only by Board action, with a reason. A
 * merge changes it when the trusted person is the merged-away side, whose roles
 * land on the keeper's login, or when a trusted keeper takes the other side's identity
 * or its linked sign-in accounts, which then sign in as the keeper.
 */
async function trustedLoginRefusal(
    db: DbClient,
    plan: Pick<MergePlan, "emailChangeReason"> & { keepId: number; mergeId: number; keeperUpdate: Record<string, unknown> },
    actor: AuthenticatedUser | null,
): Promise<MergeRefusal | null> {
    const changesTrustedLogin = (await trustStatus(db, plan.mergeId)).isTrusted
        || (("email" in plan.keeperUpdate || await db.account.count({ where: { userId: plan.mergeId } }) > 0)
            && (await trustStatus(db, plan.keepId)).isTrusted);
    if (!changesTrustedLogin) return null;
    if (!actor?.isBoardMember) {
        return { status: 403, error: "This merge changes the sign-in email of someone in a position of trust. Only a board member can do that." };
    }
    if (!plan.emailChangeReason) {
        return { status: 400, error: "This merge changes the sign-in email of someone in a position of trust. Give a reason." };
    }
    return null;
}

/**
 * Load both people and run every pre-transaction refusal, in the order a
 * caller sees them. Returns the plan to execute, or why the merge is refused.
 */
export async function prepareMerge(
    actor: AuthenticatedUser | null,
    keepId: number,
    mergeId: number,
    fieldChoices: unknown,
    emailChangeReason?: unknown,
): Promise<{ plan: MergePlan } | { refused: MergeRefusal }> {
    const keep = await prisma.person.findUnique({ where: { id: keepId }, include: KEEP_INCLUDE });
    const merge = await prisma.person.findUnique({ where: { id: mergeId }, include: MERGE_INCLUDE });

    if (!keep || !merge) {
        if (await anyMergedAway(prisma, [keepId, mergeId])) return { refused: ALREADY_MERGED };
        return { refused: { status: 404, error: "Participant(s) not found." } };
    }

    // Conflict of interest: no actor may merge a record in their OWN household.
    // The merge takes the newer of the two lastBackgroundCheck dates
    // (resolveKeeperUpdate), so without this an actor can seat a background-check
    // date on their own family with no second actor — the thing attest() and
    // boardResetReview refuse. Both subjects count: the merged-away record's household is
    // where the carried date comes from, the keeper's is where it lands, and the
    // two need not be the same household. No role bypasses this, and an actor
    // whose household can't be resolved is refused (fail closed).
    if (actor) {
        const selfGrant = await ownHouseholdRefusal(prisma, actor, keep, merge);
        if (selfGrant) {
            await recordSelfGrantRefusal(prisma, selfGrant);
            return { refused: OWN_HOUSEHOLD };
        }
    }

    const subjectBlock = subjectRefusal(keep, merge, actor) ?? await treehouseMergeRefusal(prisma, keep, merge);
    if (subjectBlock) return { refused: subjectBlock };

    const collisionBlock = await collisionRefusal(prisma, keep, merge);
    if (collisionBlock) return { refused: collisionBlock };

    const parsed = parseFieldChoices(keep, merge, fieldChoices);
    if ('error' in parsed) return { refused: { status: 400, error: parsed.error } };

    const keeperUpdate = planKeeperUpdate(keep, merge, parsed.choices);
    if ('error' in keeperUpdate) return { refused: { status: 400, error: keeperUpdate.error } };

    const disputedBlock = await disputedCheckRefusal(prisma, keep, merge, keeperUpdate.data);
    if (disputedBlock) return { refused: disputedBlock };

    const reason = typeof emailChangeReason === "string" ? emailChangeReason.trim() : "";
    const trustBlock = await trustedLoginRefusal(prisma, { keepId, mergeId, keeperUpdate: keeperUpdate.data, emailChangeReason: reason }, actor);
    if (trustBlock) return { refused: trustBlock };

    const leaderBlock = await leaderEmailMergeRefusal(prisma, keep, merge, keeperUpdate.data);
    if (leaderBlock) return { refused: leaderBlock };

    return { plan: { keep, merge, choices: parsed.choices, emailChangeReason: reason } };
}

/** The self-grant refusal for either subject, or null. Writes nothing. */
async function ownHouseholdRefusal(db: DbClient, actor: AuthenticatedUser, keep: KeepSubject, merge: MergeSubject): Promise<SelfGrantRefusal | null> {
    const attempt = { table: "Person" as const, attempted: { keepId: keep.id, mergeId: merge.id } };
    return await findSelfGrantRefusal(db, actor.id, { personId: keep.id, householdId: keep.householdId }, attempt)
        ?? await findSelfGrantRefusal(db, actor.id, { personId: merge.id, householdId: merge.householdId }, attempt);
}

/**
 * A merge whose keeper ends with no email while a program it leads, or one it takes
 * over from the merged-away side, hasn't finished, as a refusal, or null.
 */
async function leaderEmailMergeRefusal(db: DbClient, keep: KeepSubject, merge: MergeSubject, keeperUpdate: Record<string, unknown>): Promise<MergeRefusal | null> {
    const finalEmail = "email" in keeperUpdate ? keeperUpdate.email : keep.email;
    if (!isBlankEmail(finalEmail ?? null)) return null;
    if (!isBlankEmail(keep.email) && await leadsUnfinishedProgram(db, [keep.id])) return { status: 409, error: LEADER_EMAIL_REQUIRED };
    if (await leadsUnfinishedProgram(db, [merge.id])) return { status: 409, error: LEADER_NEEDS_EMAIL };
    return null;
}

/** A merge that brings someone into a Treehouse account's household, as a refusal, or null. */
async function treehouseMergeRefusal(db: DbClient, keep: KeepSubject, merge: MergeSubject): Promise<MergeRefusal | null> {
    const liveOthers = merge.household?.householdMembers.filter(p => p.id !== merge.id).length ?? 0;
    if (!bringsOthersIntoKeeperHousehold({ sameHousehold: keep.householdId === merge.householdId, liveOthers })) return null;
    return await isTreehouseHousehold(db, keep.householdId) ? { status: 409, error: TREEHOUSE_MERGE_REFUSAL } : null;
}

/** A merge that would change a disputed person's check facts, as a refusal, or null. */
async function disputedCheckRefusal(db: DbClient, keep: KeepSubject, merge: MergeSubject, keeperUpdate: Record<string, unknown>): Promise<MergeRefusal | null> {
    const reviews = await loadCheckReviews(db, [keep.id, merge.id]);
    const blocked = await blockedApplicationsByLead(db, [keep, merge]);
    const side = (personId: number): CheckSide => {
        const own = reviews.get(personId) ?? [];
        return { disputing: [...disputingReviews(own), ...(blocked.get(personId) ?? [])], openReviews: own.length };
    };
    const error = disputedCheckBlock(side(keep.id), side(merge.id), "lastBackgroundCheck" in keeperUpdate);
    return error ? { status: 409, error } : null;
}

/**
 * A household application BLOCKED by a household attestation names nobody, so it
 * disputes every lead of its household.
 */
async function blockedApplicationsByLead(db: DbClient, people: { id: number; householdId: number; isHouseholdLead: boolean }[]): Promise<Map<number, { id: number }[]>> {
    const leads = people.filter(p => p.isHouseholdLead);
    if (leads.length === 0) return new Map();
    const rows = await db.orgMembershipProcess.findMany({
        where: { status: "BLOCKED", orgMembership: { householdId: { in: leads.map(p => p.householdId) } } },
        select: { id: true, orgMembership: { select: { householdId: true } } },
    });
    return new Map(leads.map(p => [p.id, rows.filter(r => r.orgMembership?.householdId === p.householdId)]));
}

/** The decision-bearing collisions between the two subjects, as a refusal, or null. */
async function collisionRefusal(db: DbClient, keep: KeepSubject, merge: MergeSubject): Promise<MergeRefusal | null> {
    const openVisit = (personId: number) => db.visit.findFirst({ where: { personId, departedAt: null, deletedAt: null }, select: { id: true } });
    const openVisits = { keep: !!(await openVisit(keep.id)), merge: !!(await openVisit(merge.id)) };
    const collisions = findCollisions(keep, merge, openVisits, new Date());
    if (collisions.length === 0) return null;
    return { status: 409, error: `Cannot merge: ${collisions.map(c => c.message).join('; ')}`, collisions };
}

/** Per-relation tallies recorded in the merge's audit row. */
function emptyTallies() {
    return {
        visits: 0,
        personBgArchived: 0,
        kvaArchived: 0,
        rawBadgeLogs: 0,
        presenceEvents: 0,
        zohoSigners: 0,
        attendanceConfirmations: 0,
        facilityCloses: 0,
        trustedAdultDecisions: 0,
        archivedMerges: 0,
        roleGrants: 0,
        bucketOwners: 0,
        roles: { migrated: 0, deduped: 0 },
        bgAttestationSubjects: { migrated: 0, left: 0 },
        programParticipants: { migrated: 0, left: 0 },
        programVolunteers: { migrated: 0, deduped: 0 },
        rsvps: { migrated: 0, deduped: 0, left: 0 },
        toolStatuses: { migrated: 0, deduped: 0, left: 0 },
        bgAttestations: { migrated: 0, left: 0 },
        corporationLeads: { migrated: 0, deduped: 0 },
        corporationMembers: { migrated: 0, deduped: 0 },
        bucketTreasurers: { migrated: 0, deduped: 0 },
        mailAliases: { migrated: [] as number[], deduped: [] as number[] },
    };
}
type Tallies = ReturnType<typeof emptyTallies>;

/**
 * Run the merge transaction, then settle both households. The
 * transaction moves everything off the merged-away record, archives it as a
 * PersonMerge row and deletes its Person row. Throws AlreadyMergedError on a
 * lost race, MergeRefusedError when a refusal applies under the locks or a row
 * is still left on the merged-away record, and the lib/roles errors when a role
 * move is refused.
 */
export async function executeMerge(plan: MergePlan, actor: AuthenticatedUser | null): Promise<void> {
    const { keep, merge } = plan;
    const keepId = keep.id;
    const mergeId = merge.id;

    // The timeout also covers the waits in lockMergeRows.
    const { personMergeId, lockedKeeper, recallRequestIds } = await prisma.$transaction(async (tx) => {
        await lockMergeRows(tx, keepId, mergeId, [keep.householdId, merge.householdId]);
        const live = await recheckSubjects(tx, plan, actor);
        await clearMergedIdentity(tx, mergeId);
        await applyKeeperChoices(tx, keepId, live.keeperUpdate);

        const moved = emptyTallies();
        await moveVisits(tx, keepId, mergeId, moved);
        await moveJoinTables(tx, live.keep, live.merge, moved);
        const recallRequestIds = await moveRemainingRelations(tx, keepId, mergeId, actor, moved);
        await moveRoles(tx, keepId, mergeId, actor, moved);
        await moveAttestations(tx, live.keep, live.merge, moved);
        await moveCorporations(tx, live.keep, live.merge, moved);
        await moveBucketTreasurers(tx, keepId, mergeId, moved);
        await moveMailAliases(tx, keepId, mergeId, moved);
        refuseLeftRows(moved);

        // 6. The household lead guard ran pre-tx. The merged-away record's
        // household loses a member with the delete below; a household left with
        // nobody in it stays, as one whose last member was removed does.

        const archiveId = await archiveMerge(tx, keepId, live.merge);
        await deleteMergedPerson(tx, mergeId);
        await auditMerge(tx, plan, live, actor, moved);
        return { personMergeId: archiveId, lockedKeeper: live.keep, recallRequestIds };
    }, { maxWait: 5_000, timeout: 15_000 }).catch(async (e: unknown) => {
        if (e instanceof SelfGrantMergeRefusedError) await recordSelfGrantRefusal(prisma, e.selfGrant);
        throw e;
    });

    // The keeper may now carry a newer check date or another person's review, and the
    // merged-away record has left its household: settle both on their people's checks.
    // Post-commit, so a failure becomes a stuck settle rather than a failed merge.
    for (const householdId of new Set([keep.householdId, merge.householdId])) {
        await settleAfterEvent(householdId, "merge", { trigger: { kind: "merge", personMergeId } }, { keepId, mergeId });
    }
    await notifyBoardOfYouthLeads([lockedKeeper]);
    await recallSigningRequests(recallRequestIds);

    invalidateAttendanceCache();
}

/**
 * Locks, in the order lib/lockOrder.ts states: BOARD roles, both households'
 * membership rows, both Household rows (an archived one refuses the merge), both
 * Person rows, then the application rows this merge writes. The membership rows
 * serialize a deny with the merge even when there are no BOARD rows to lock.
 */
async function lockMergeRows(tx: TxClient, keepId: number, mergeId: number, householdIds: number[]): Promise<void> {
    await lockBoardRoles(tx);
    await lockAndFindDeniedHousehold(tx, householdIds);
    try {
        await lockLiveHouseholds(tx, householdIds);
    } catch (e) {
        if (e instanceof ArchivedHouseholdError) throw new MergeRefusedError({ status: 409, error: e.message });
        throw e;
    }
    await lockBothSubjects(tx, keepId, mergeId);
    await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess"
        WHERE "subjectPersonId" IN (${keepId}, ${mergeId}) OR "zohoSignerPersonId" = ${mergeId}
        ORDER BY id FOR UPDATE`;
}

/**
 * Lock both Person rows, in id order so two merges of the same pair in opposite
 * directions cannot deadlock. A merge that commits deletes its merged-away row,
 * so a merge waiting on that lock finds the row gone and loses with
 * AlreadyMergedError: of two concurrent merges sharing a subject, one wins.
 */
async function lockBothSubjects(tx: TxClient, keepId: number, mergeId: number): Promise<void> {
    const locked = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "Person"
        WHERE id IN (${keepId}, ${mergeId}) ORDER BY id FOR UPDATE`;
    if (locked.length !== 2) throw new AlreadyMergedError();
}

/**
 * Re-run the subject, collision and disputed-check refusals on a live read, under the
 * households' membership locks: a household denied after prepareMerge is seen
 * here and refuses the merge. A subject that changed household since the plan
 * refuses too, since the locks cover the planned households only. Returns the
 * live read, which the moves work from so a row added since the plan moves too,
 * and the keeper's update rebuilt from it, so a date or field written since the
 * plan is never overwritten. The admin's choices name a side and apply to that
 * side's live value; a conflict they never decided refuses the merge.
 */
async function recheckSubjects(tx: TxClient, plan: MergePlan, actor: AuthenticatedUser | null): Promise<LiveSubjects> {
    const keep = await tx.person.findUnique({ where: { id: plan.keep.id }, include: KEEP_INCLUDE });
    const merge = await tx.person.findUnique({ where: { id: plan.merge.id }, include: MERGE_INCLUDE });
    if (!keep || !merge) throw new AlreadyMergedError();
    if (keep.householdId !== plan.keep.householdId || merge.householdId !== plan.merge.householdId) {
        throw new MergeRefusedError({ status: 409, error: "One of these participants changed household while merging. Reload and try again." });
    }
    // The actor's household is re-read under the Household locks, so an actor who joined either household since the plan is refused.
    const selfGrant = actor ? await ownHouseholdRefusal(tx, actor, keep, merge) : null;
    if (selfGrant) throw new SelfGrantMergeRefusedError(selfGrant);
    const refusal = subjectRefusal(keep, merge, actor) ?? await treehouseMergeRefusal(tx, keep, merge) ?? await collisionRefusal(tx, keep, merge);
    if (refusal) throw new MergeRefusedError(refusal);
    const parsed = parseFieldChoices(keep, merge, plan.choices);
    const keeperUpdate = 'error' in parsed ? parsed : planKeeperUpdate(keep, merge, parsed.choices);
    if ('error' in keeperUpdate) throw new MergeRefusedError(CHANGED_WHILE_MERGING);
    const disputedBlock = await disputedCheckRefusal(tx, keep, merge, keeperUpdate.data);
    if (disputedBlock) throw new MergeRefusedError(disputedBlock);
    const trustBlock = await trustedLoginRefusal(tx, { emailChangeReason: plan.emailChangeReason, keeperUpdate: keeperUpdate.data, keepId: keep.id, mergeId: merge.id }, actor);
    if (trustBlock) throw new MergeRefusedError(trustBlock);
    const leaderBlock = await leaderEmailMergeRefusal(tx, keep, merge, keeperUpdate.data);
    if (leaderBlock) throw new MergeRefusedError(leaderBlock);
    return { keep, merge, keeperUpdate: keeperUpdate.data };
}

/**
 * 1. Clear the merged-away identity before the keeper update: it frees the
 * unique email/googleId so the keeper can adopt them without a P2002.
 */
async function clearMergedIdentity(tx: TxClient, mergeId: number): Promise<void> {
    await tx.person.update({
        where: { id: mergeId },
        data: {
            googleId: null,
            email: `merged-${mergeId}@deleted.invalid`,
            // Null the verified stamp with the identity, so the sentinel
            // address never carries a "verified" mark.
            emailVerified: null,
            phone: null,
            isHouseholdLead: false,
            // Every PersonRole row moves off the merged-away record in
            // moveRoles, so its legacy role mirrors must go with them. Zeroed
            // here rather than derived after the loop for the same reason
            // isHouseholdLead is: a merged-away record holds no authority, so
            // `false` is the right value even if a row raced in.
            ...roleMirrors(new Set()),
        },
    });
}

/** 2. Apply the keeper update built from the live rows. */
async function applyKeeperChoices(tx: TxClient, keepId: number, data: Record<string, unknown>): Promise<void> {
    if (Object.keys(data).length > 0) {
        await tx.person.update({ where: { id: keepId }, data });
    }
}

/**
 * 3. Move visits. Both-open was refused under the locks; a visit opened since
 * then would give the keeper two open visits, so it refuses the merge instead
 * of moving.
 */
async function moveVisits(tx: TxClient, keepId: number, mergeId: number, moved: Tallies): Promise<void> {
    const keeperHasOpenVisit = await tx.visit.findFirst({ where: { personId: keepId, departedAt: null, deletedAt: null }, select: { id: true } });
    moved.visits = (await tx.visit.updateMany({
        where: { personId: mergeId, ...(keeperHasOpenVisit ? { NOT: { departedAt: null, deletedAt: null } } : {}) },
        data: { personId: keepId },
    })).count;
    if (await tx.visit.findFirst({ where: { personId: mergeId }, select: { id: true } })) {
        throw new MergeRefusedError({ status: 409, error: "Cannot merge: both records now have an open visit. Close one of them, then merge." });
    }
}

/**
 * 4. Move join tables. Decision-bearing collisions (ProgramParticipant,
 * different-level ToolStatus, future RSVP) were refused under the locks; a `left`
 * row means one raced in since, and refuseLeftRows refuses the merge. Bare-join
 * collisions (ProgramVolunteer) and same-level ToolStatus pairs auto-dedupe.
 */
async function moveJoinTables(tx: TxClient, keep: KeepSubject, merge: MergeSubject, moved: Tallies): Promise<void> {
    const keepId = keep.id;
    const mergeId = merge.id;

    for (const pp of merge.programParticipants) {
        if (!keep.programParticipants.find(k => k.programId === pp.programId)) {
            await tx.programParticipant.update({
                where: { programId_personId: { programId: pp.programId, personId: mergeId } },
                data: { personId: keepId },
            });
            moved.programParticipants.migrated++;
        } else {
            moved.programParticipants.left++;
        }
    }

    for (const pv of merge.programVolunteers) {
        if (!keep.programVolunteers.find(k => k.programId === pv.programId)) {
            await tx.programVolunteer.update({
                where: { programId_personId: { programId: pv.programId, personId: mergeId } },
                data: { personId: keepId },
            });
            moved.programVolunteers.migrated++;
        } else {
            await tx.programVolunteer.delete({
                where: { programId_personId: { programId: pv.programId, personId: mergeId } },
            });
            moved.programVolunteers.deduped++;
        }
    }

    for (const rsvp of merge.rsvps) {
        if (!keep.rsvps.find(k => k.eventId === rsvp.eventId)) {
            await tx.rSVP.update({
                where: { eventId_personId: { eventId: rsvp.eventId, personId: mergeId } },
                data: { personId: keepId },
            });
            moved.rsvps.migrated++;
        } else if (rsvp.event.startAt <= new Date()) {
            await tx.rSVP.delete({
                where: { eventId_personId: { eventId: rsvp.eventId, personId: mergeId } },
            });
            moved.rsvps.deduped++;
        } else {
            moved.rsvps.left++;
        }
    }

    for (const tool of merge.toolStatuses) {
        const kept = keep.toolStatuses.find(k => k.toolId === tool.toolId);
        if (!kept) {
            await tx.toolStatus.update({
                where: { personId_toolId: { toolId: tool.toolId, personId: mergeId } },
                data: { personId: keepId },
            });
            moved.toolStatuses.migrated++;
        } else if (kept.level === tool.level) {
            // Matching on level too: a level changed since the read is left, and refuses the merge.
            const { count } = await tx.toolStatus.deleteMany({
                where: { toolId: tool.toolId, personId: mergeId, level: tool.level },
            });
            if (count > 0) moved.toolStatuses.deduped++;
            else moved.toolStatuses.left++;
        } else {
            moved.toolStatuses.left++;
        }
    }
}

/**
 * 5. Move the remaining MOVE relations — single updateMany each, no delete.
 * Returns the Zoho request ids of archived duplicate agreements, to recall after commit.
 */
async function moveRemainingRelations(tx: TxClient, keepId: number, mergeId: number, actor: AuthenticatedUser | null, moved: Tallies): Promise<string[]> {
    await tx.account.updateMany({ where: { userId: mergeId }, data: { userId: keepId } });
    // Sessions are auth artifacts, not person data, and there's no reason for
    // the keeper to inherit the merged-away login session. Sessions are
    // JWT-strategy, so this row is not what ends that access — the jwt()
    // re-sync (auth-options.ts) finds no live row and collapses the token on
    // next refresh.
    await tx.session.deleteMany({ where: { userId: mergeId } });
    await tx.orgMembershipProcess.updateMany({ where: { subjectPersonId: mergeId }, data: { subjectPersonId: keepId } });
    // Both sides can have owed a check — the survivor keeps exactly one.
    moved.personBgArchived = await archiveDuplicatePersonBg(tx, keepId, actor ? actor.id : 0);
    const kva = await archiveDuplicateKva(tx, keepId, actor ? actor.id : 0);
    moved.kvaArchived = kva.archived;
    await tx.program.updateMany({ where: { leadMentorId: mergeId }, data: { leadMentorId: keepId } });
    await tx.programInstance.updateMany({ where: { leadMentorId: mergeId }, data: { leadMentorId: keepId } });
    await tx.trustedAdult.updateMany({ where: { trustedAdultPersonId: mergeId }, data: { trustedAdultPersonId: keepId } });
    await tx.trustedAdult.updateMany({ where: { disclosedById: mergeId }, data: { disclosedById: keepId } });

    // RawBadgeLog.personId is RESTRICT: a scan left behind blocks the delete.
    moved.rawBadgeLogs = (await tx.rawBadgeLog.updateMany({ where: { personId: mergeId }, data: { personId: keepId } })).count;
    // PresenceEvent.personId is CASCADE: the append-only log follows the
    // survivor so later flushes project against the live record.
    moved.presenceEvents = (await tx.presenceEvent.updateMany({ where: { personId: mergeId }, data: { personId: keepId } })).count;

    // "Which staff member did this" facts, all SET NULL — left behind they
    // read as nobody once the row is deleted.
    moved.zohoSigners = (await tx.orgMembershipProcess.updateMany({ where: { zohoSignerPersonId: mergeId }, data: { zohoSignerPersonId: keepId } })).count;
    moved.attendanceConfirmations = (await tx.event.updateMany({ where: { attendanceConfirmedById: mergeId }, data: { attendanceConfirmedById: keepId } })).count;
    moved.facilityCloses = (await tx.facilityClose.updateMany({ where: { closedById: mergeId }, data: { closedById: keepId } })).count;
    moved.trustedAdultDecisions = (await tx.trustedAdultReview.updateMany({ where: { decidedById: mergeId }, data: { decidedById: keepId } })).count;

    // Earlier merges that named THIS record as their survivor: the archive
    // answers "where is this person now", and its toId is RESTRICT, so leaving
    // it would block the delete. Collapsing the chain here is also why
    // compliance attributes a date inherited two merges back. No unique
    // constraint on toId, so a plain updateMany.
    moved.archivedMerges = (await tx.personMerge.updateMany({ where: { toId: mergeId }, data: { toId: keepId } })).count;
    moved.bucketOwners = (await tx.budgetOwner.updateMany({ where: { ownerId: mergeId }, data: { ownerId: keepId } })).count;
    return kva.recallRequestIds;
}

/**
 * PersonRole.personId is CASCADE — a role left on the merged-away record is a
 * security grant its delete destroys. Each role moves through setRoleFlag, the role
 * routes' choke point, so it runs their guards and writes one audit row per
 * change: every role is granted to the keeper first (a no-op when the keeper
 * already holds it), then revoked from the merged-away record, so a moving BOARD never
 * counts down to zero. KEY_VOLUNTEER is granted first and revoked last, the
 * order its rules need; the move is not a new grant, so the Key Volunteer
 * agreement check is skipped (the agreements moved with the other relations).
 * A moved row keeps its original grant metadata; the audit rows name the
 * merging actor. Read in the transaction so a role granted after the pre-tx
 * read still moves.
 */
async function moveRoles(tx: TxClient, keepId: number, mergeId: number, actor: AuthenticatedUser | null, moved: Tallies): Promise<void> {
    const mergedAwayRoles = (await tx.personRole.findMany({
        where: { personId: mergeId },
        select: { role: true, grantedById: true, grantedAt: true },
    })).sort((a, b) => Number(b.role === "KEY_VOLUNTEER") - Number(a.role === "KEY_VOLUNTEER"));
    if (mergedAwayRoles.length > 0 && !actor) throw new RoleMatrixError("Forbidden");
    if (actor) {
        for (const { role, grantedById, grantedAt } of mergedAwayRoles) {
            const granted = await setRoleFlag(tx, keepId, KIND_TO_FLAG[role], true, actor, { move: true });
            if (granted.changed) {
                await tx.personRole.update({
                    where: { personId_role: { personId: keepId, role } },
                    data: { grantedById, grantedAt },
                });
                moved.roles.migrated++;
            } else {
                moved.roles.deduped++;
            }
        }
        for (const { role } of [...mergedAwayRoles].reverse()) {
            await setRoleFlag(tx, mergeId, KIND_TO_FLAG[role], false, actor);
        }
    }
    // After the holder pass, so a granter stamp on a deduped row isn't counted.
    moved.roleGrants = (await tx.personRole.updateMany({ where: { grantedById: mergeId }, data: { grantedById: keepId } })).count;
    // setRoleFlag mirrors each role it moves; this rewrite from the keeper's
    // whole final role set also heals mirror drift the keeper already had
    // (canReviewBackgroundChecks and reviewer notifications read the mirror).
    //
    // Re-read IN the transaction rather than reusing the pre-tx snapshot:
    // this write asserts all four flags at once, so a role revoked from the
    // keeper between the pre-tx read and here would be re-asserted true with
    // no row behind it (privilege retention), and one granted in that window
    // zeroed with a row present.
    const keeperFinalRoles = await tx.personRole.findMany({ where: { personId: keepId }, select: { role: true } });
    await tx.person.update({
        where: { id: keepId },
        data: roleMirrors(new Set(keeperFinalRoles.map(r => r.role))),
    });
}

/**
 * Background-check attestations, reviewer side then subject side. Collisions
 * on either were pre-refused; `left` covers a race.
 */
async function moveAttestations(tx: TxClient, keep: KeepSubject, merge: MergeSubject, moved: Tallies): Promise<void> {
    const keepAttestProcessIds = new Set(keep.bgAttestations.map(a => a.processId));
    for (const att of merge.bgAttestations) {
        if (!keepAttestProcessIds.has(att.processId)) {
            await tx.backgroundCheckAttestation.update({ where: { id: att.id }, data: { reviewerId: keep.id } });
            moved.bgAttestations.migrated++;
        } else {
            moved.bgAttestations.left++;
        }
    }

    const keepSubjectKeys = new Set(keep.bgAttestationsAsSubject.map(bgSubjectKey));
    for (const att of merge.bgAttestationsAsSubject) {
        if (!keepSubjectKeys.has(bgSubjectKey(att))) {
            await tx.backgroundCheckAttestation.update({ where: { id: att.id }, data: { subjectPersonId: keep.id } });
            moved.bgAttestationSubjects.migrated++;
        } else {
            moved.bgAttestationSubjects.left++;
        }
    }
}

/** Corporation leads and members: bare joins, auto-dedupe. */
async function moveCorporations(tx: TxClient, keep: KeepSubject, merge: MergeSubject, moved: Tallies): Promise<void> {
    const keepId = keep.id;
    const mergeId = merge.id;

    const keepCorpLeadIds = new Set(keep.corporationLeads.map(c => c.corporationId));
    for (const cl of merge.corporationLeads) {
        if (!keepCorpLeadIds.has(cl.corporationId)) {
            await tx.corporationLead.update({
                where: { corporationId_personId: { corporationId: cl.corporationId, personId: mergeId } },
                data: { personId: keepId },
            });
            moved.corporationLeads.migrated++;
        } else {
            await tx.corporationLead.delete({
                where: { corporationId_personId: { corporationId: cl.corporationId, personId: mergeId } },
            });
            moved.corporationLeads.deduped++;
        }
    }

    const keepCorpMemberIds = new Set(keep.corporationMembers.map(c => c.corporationId));
    for (const cm of merge.corporationMembers) {
        if (!keepCorpMemberIds.has(cm.corporationId)) {
            await tx.corporationMember.update({
                where: { corporationId_personId: { corporationId: cm.corporationId, personId: mergeId } },
                data: { personId: keepId },
            });
            moved.corporationMembers.migrated++;
        } else {
            await tx.corporationMember.delete({
                where: { corporationId_personId: { corporationId: cm.corporationId, personId: mergeId } },
            });
            moved.corporationMembers.deduped++;
        }
    }
}

/** Bucket treasurers: a bare join, auto-dedupe. */
async function moveBucketTreasurers(tx: TxClient, keepId: number, mergeId: number, moved: Tallies): Promise<void> {
    const keepBuckets = new Set(
        (await tx.budgetOwnerTreasurer.findMany({ where: { personId: keepId }, select: { budgetOwnerId: true } })).map(t => t.budgetOwnerId),
    );
    const mergeRows = await tx.budgetOwnerTreasurer.findMany({ where: { personId: mergeId }, select: { budgetOwnerId: true } });
    for (const { budgetOwnerId } of mergeRows) {
        const where = { budgetOwnerId_personId: { budgetOwnerId, personId: mergeId } };
        if (keepBuckets.has(budgetOwnerId)) {
            await tx.budgetOwnerTreasurer.delete({ where });
            moved.bucketTreasurers.deduped++;
        } else {
            await tx.budgetOwnerTreasurer.update({ where, data: { personId: keepId } });
            moved.bucketTreasurers.migrated++;
        }
    }
}

/**
 * Receipt mail aliases follow the survivor, as its email does. An alias equal to
 * the survivor's final sign-in address is deleted: that address already
 * identifies it. Read after applyKeeperChoices, which may have swapped the email.
 */
async function moveMailAliases(tx: TxClient, keepId: number, mergeId: number, moved: Tallies): Promise<void> {
    const keeper = await tx.person.findUniqueOrThrow({ where: { id: keepId }, select: { email: true } });
    const signIn = keeper.email?.trim().toLowerCase();
    const aliases = await tx.personMailAlias.findMany({ where: { personId: { in: [keepId, mergeId] } }, select: { id: true, personId: true, address: true } });
    for (const alias of aliases) {
        if (alias.address === signIn) {
            await tx.personMailAlias.delete({ where: { id: alias.id } });
            moved.mailAliases.deduped.push(alias.id);
        } else if (alias.personId === mergeId) {
            await tx.personMailAlias.update({ where: { id: alias.id }, data: { personId: keepId } });
            moved.mailAliases.migrated.push(alias.id);
        }
    }
}

/**
 * A `left` row is a collision that raced in after the in-lock recheck. The
 * delete cannot leave it behind: the RESTRICT ones would block it and
 * BackgroundCheckAttestation.subjectPersonId (SET NULL) would lose its subject.
 */
function refuseLeftRows(moved: Tallies): void {
    const left = moved.programParticipants.left + moved.rsvps.left + moved.toolStatuses.left
        + moved.bgAttestations.left + moved.bgAttestationSubjects.left;
    if (left > 0) throw new MergeRefusedError(CHANGED_WHILE_MERGING);
}

/**
 * 7. Archive the merge, in the same transaction as the delete, so a deleted id
 * always has an archive row to resolve through. The row lock already serialises
 * merges of the same id; fromId @unique backs it, and a collision there means
 * another merge of this record won.
 */
async function archiveMerge(tx: TxClient, keepId: number, merge: MergeSubject): Promise<number> {
    try {
        const archive = await tx.personMerge.create({
            data: { fromId: merge.id, toId: keepId, snapshot: mergeSnapshot(merge) },
            select: { id: true },
        });
        return archive.id;
    } catch (error) {
        if (isPrismaError(error, "P2002")) throw new AlreadyMergedError();
        throw error;
    }
}

/**
 * 8. Delete the merged-away Person row. A RESTRICT reference still on it — a
 * row written since the moves read their sources — fails the delete, and the
 * whole merge is refused rather than committed half-moved.
 */
async function deleteMergedPerson(tx: TxClient, mergeId: number): Promise<void> {
    try {
        await tx.person.delete({ where: { id: mergeId } });
    } catch (error) {
        if (isPrismaError(error, "P2003")) throw new MergeRefusedError(CHANGED_WHILE_MERGING);
        throw error;
    }
}

/**
 * 9. Audit — tallies: migrated (repointed), deduped (bare-join duplicate
 * deleted), left (always 0 on a committed merge; see refuseLeftRows).
 */
async function auditMerge(tx: TxClient, plan: MergePlan, live: LiveSubjects, actor: AuthenticatedUser | null, moved: Tallies): Promise<void> {
    if (!actor) return;
    await tx.auditLog.create({
        data: {
            actorId: actor.id,
            action: "DELETE",
            tableName: "Person",
            affectedEntityId: plan.keep.id,
            secondaryAffectedEntity: plan.merge.id,
            // Both pre-images, read under the locks before either update ran: the merged-away
            // Person at the top level, the keeper — whose name/email/DOB a field
            // choice can overwrite — under `keeper`.
            oldData: {
                ...personPreImage(live.merge),
                keeper: personPreImage(live.keep),
            },
            newData: {
                keepId: plan.keep.id,
                fieldChoices: plan.choices,
                moved,
                ...(plan.emailChangeReason && { emailChangeReason: plan.emailChangeReason }),
            },
        },
    });
}

/**
 * One human owes at most ONE open background check. Both merge subjects can hold an
 * open PERSON_BG, and re-pointing both at the survivor leaves two concurrent 2-of-N
 * reviews for the same person — the trigger's own dedupe never sees them (it runs at
 * create time). Keep the furthest-along row, archive the rest.
 *
 * Rank: BLOCKED outranks an open review — archiving a block in favour of a pending
 * row would erase a rejection and hand the person a fresh path to clearance. Then
 * more attestations, then consent recorded, then the older row.
 *
 * Attestations stay on the archived row: moving them onto the survivor would seat
 * reviewers past attest()'s same-household/already-attested gates, and the archived
 * row keeps the record. The audit row matches archiveApplication's shape, so the
 * board can unarchive one archived by mistake.
 *
 * No new lifecycle edge: this is the declared archive transition
 * ({PENDING_BG_REVIEW,BLOCKED}→ARCHIVED) driven from a second site, and the CAS
 * from-state comes from the definition (`personBgOpen.where` covers both).
 */
async function archiveDuplicatePersonBg(tx: TxClient, personId: number, actorId: number): Promise<number> {
    const open = await tx.orgMembershipProcess.findMany({
        where: { kind: "PERSON_BG", subjectPersonId: personId, ...personBgOpen.where },
        select: { id: true, status: true, bgConsentAt: true, _count: { select: { attestations: true } } },
    });
    if (open.length < 2) return 0;

    const rank = (p: (typeof open)[number]) => [p.status === "BLOCKED" ? 1 : 0, p._count.attestations, p.bgConsentAt ? 1 : 0, -p.id];
    const [survivor, ...losers] = [...open].sort((a, b) => {
        const [ra, rb] = [rank(a), rank(b)];
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
        return 0;
    });

    let archived = 0;
    for (const loser of losers) {
        // CAS on the open set: a concurrent attest that just cleared or blocked this
        // row wins, and we leave it alone.
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: loser.id, ...personBgOpen.where },
            data: { status: "ARCHIVED", archivedFromStatus: loser.status, stageEnteredAt: new Date() },
        });
        if (count !== 1) continue;
        await tx.auditLog.create({
            data: {
                actorId,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: loser.id,
                oldData: { status: loser.status },
                newData: { status: "ARCHIVED", reason: "duplicate PERSON_BG resolved by participant merge", survivorProcessId: survivor.id },
            },
        });
        archived++;
    }
    return archived;
}

/**
 * One human has at most ONE open Key Volunteer agreement, and none once they have
 * signed the current version. Both merge subjects can hold one, and re-pointing
 * both leaves the survivor two, or an open one beside a signed current one. Keep
 * the signed current row or else the furthest-along open row, and archive the
 * rest, as archiveDuplicatePersonBg does. An open row beside a signature below the
 * current version is the person's re-sign, so it stays.
 *
 * Rank of open rows: the newer agreement version, then a Zoho request already sent
 * (the person has begun signing), then the older row. The losers' Zoho requests are
 * returned for the caller to recall after commit; an archived process never matches
 * the Zoho webhook, so a signature landing first changes nothing.
 */
async function archiveDuplicateKva(tx: TxClient, personId: number, actorId: number): Promise<{ archived: number; recallRequestIds: string[] }> {
    const openWhere = { kind: KVA_KIND, contractSignedAt: null, ...fromWhere("PENDING_EXTERNAL_ACTION") };
    const open = await tx.orgMembershipProcess.findMany({
        where: { subjectPersonId: personId, ...openWhere },
        select: { id: true, agreementVersion: true, zohoEnvelopeId: true },
    });
    if (open.length === 0) return { archived: 0, recallRequestIds: [] };
    const signed = await findSignedCurrentKva(tx, personId);
    if (!signed && open.length < 2) return { archived: 0, recallRequestIds: [] };

    const rank = (p: (typeof open)[number]) => [p.agreementVersion ?? 0, p.zohoEnvelopeId ? 1 : 0, -p.id];
    const ranked = [...open].sort((a, b) => {
        const [ra, rb] = [rank(a), rank(b)];
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
        return 0;
    });
    const survivor = signed ?? ranked[0];
    const losers = signed ? ranked : ranked.slice(1);

    let archived = 0;
    const recallRequestIds: string[] = [];
    for (const loser of losers) {
        // CAS on the open set: a signature that just landed on this row wins.
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: loser.id, kind: KVA_KIND, contractSignedAt: null, ...fromWhere("PENDING_EXTERNAL_ACTION") },
            data: { status: "ARCHIVED", archivedFromStatus: "PENDING_EXTERNAL_ACTION", stageEnteredAt: new Date() },
        });
        if (count !== 1) continue;
        await tx.auditLog.create({
            data: {
                actorId,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: loser.id,
                oldData: { status: "PENDING_EXTERNAL_ACTION" },
                newData: {
                    status: "ARCHIVED",
                    reason: signed
                        ? "open Key Volunteer agreement superseded by a signed current one on participant merge"
                        : "duplicate Key Volunteer agreement resolved by participant merge",
                    survivorProcessId: survivor.id,
                },
            },
        });
        if (loser.zohoEnvelopeId) recallRequestIds.push(loser.zohoEnvelopeId);
        archived++;
    }
    return { archived, recallRequestIds };
}
