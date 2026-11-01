import prisma from "@/lib/prisma";
import type { AuthenticatedUser } from "@/types/auth";
import type { DbClient, TxClient } from "@/lib/db-client";
import { personBgOpen } from "@/lib/membership/lifecycle";
import { advanceHouseholdBgAfterMerge, householdBgFresh } from "@/lib/membership/mergeBgAdvance";
import { refuseSelfGrant } from "@/lib/membership/selfGrantGuard";
import { lockAndFindDeniedHousehold } from "@/lib/membership/householdStatus";
import { KIND_TO_FLAG, setRoleFlag, lockBoardRoles, RoleMatrixError, trustStatus } from "@/lib/roles";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { anyMergedAway } from "@/lib/person/archivedPeople";
import { bgSubjectKey } from "./guard";
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

/** Thrown when the step-1 CAS loses the race (concurrent/repeat merge). */
export class AlreadyMergedError extends Error {}

/** Thrown when a subject refusal that passed in prepareMerge applies under the lock. */
export class MergeRefusedError extends Error {
    constructor(public readonly refusal: MergeRefusal) {
        super(refusal.error);
    }
}

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
    bgFreshBeforeMerge: boolean;
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

    // Double-merge / merge-a-tombstone guard — either side, before opening the tx.
    if (keep.mergedIntoId != null || merge.mergedIntoId != null) {
        return { refused: ALREADY_MERGED };
    }

    // Conflict of interest: no actor may merge a record in their OWN household.
    // The merge takes the newer of the two lastBackgroundCheck dates
    // (resolveKeeperUpdate), so without this an actor can seat a background-check
    // date on their own family with no second actor — the thing attest() and
    // boardResetReview refuse. Both subjects count: the tombstone's household is
    // where the carried date comes from, the keeper's is where it lands, and the
    // two need not be the same household. No role bypasses this, and an actor
    // whose household can't be resolved is refused (fail closed).
    if (actor) {
        const attempt = { table: "Person" as const, attempted: { keepId: keep.id, mergeId: merge.id } };
        if (
            await refuseSelfGrant(prisma, actor.id, { personId: keep.id, householdId: keep.householdId }, attempt)
            || await refuseSelfGrant(prisma, actor.id, { personId: merge.id, householdId: merge.householdId }, attempt)
        ) {
            return { refused: { status: 403, error: "You cannot merge a record in your own household — someone outside your household must." } };
        }
    }

    const subjectBlock = subjectRefusal(keep, merge, actor);
    if (subjectBlock) return { refused: subjectBlock };

    const collisionBlock = await collisionRefusal(prisma, keep, merge);
    if (collisionBlock) return { refused: collisionBlock };

    const parsed = parseFieldChoices(keep, merge, fieldChoices);
    if ('error' in parsed) return { refused: { status: 400, error: parsed.error } };

    const keeperUpdate = planKeeperUpdate(keep, merge, parsed.choices);
    if ('error' in keeperUpdate) return { refused: { status: 400, error: keeperUpdate.error } };

    const reason = typeof emailChangeReason === "string" ? emailChangeReason.trim() : "";
    const trustBlock = await trustedLoginRefusal(prisma, { keepId, mergeId, keeperUpdate: keeperUpdate.data, emailChangeReason: reason }, actor);
    if (trustBlock) return { refused: trustBlock };

    // The post-commit carryover acts only on a household THIS merge made
    // background-check fresh, so it needs the pre-merge answer: afterwards the
    // keeper already carries the merged date and the two are indistinguishable.
    const bgFreshBeforeMerge = await householdBgFresh(keep.householdId);

    return { plan: { keep, merge, choices: parsed.choices, bgFreshBeforeMerge, emailChangeReason: reason } };
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
        rawBadgeLogs: 0,
        presenceEvents: 0,
        noteAcks: 0,
        zohoSigners: 0,
        attendanceConfirmations: 0,
        facilityCloses: 0,
        trustedAdultDecisions: 0,
        archivedMerges: 0,
        chainedTombstones: 0,
        roleGrants: 0,
        bucketOwners: 0,
        roles: { migrated: 0, deduped: 0 },
        bgAttestationSubjects: { migrated: 0, left: 0 },
        programParticipants: { migrated: 0, left: 0 },
        programVolunteers: { migrated: 0, deduped: 0 },
        rsvps: { migrated: 0, deduped: 0, left: 0 },
        toolStatuses: { migrated: 0, left: 0 },
        bgAttestations: { migrated: 0, left: 0 },
        corporationLeads: { migrated: 0, deduped: 0 },
        corporationMembers: { migrated: 0, deduped: 0 },
        bucketTreasurers: { migrated: 0, deduped: 0 },
        mailAliases: { migrated: [] as number[], deduped: [] as number[] },
    };
}
type Tallies = ReturnType<typeof emptyTallies>;

/**
 * Run the merge transaction, then the post-commit membership carryover. The
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

    await prisma.$transaction(async (tx) => {
        await lockAndRecheckKeeper(tx, keepId, mergeId, [keep.householdId, merge.householdId]);
        const live = await recheckSubjects(tx, plan, actor);
        await clearTombstoneIdentity(tx, mergeId, keepId);
        await applyKeeperChoices(tx, keepId, live.keeperUpdate);

        const moved = emptyTallies();
        await moveVisits(tx, keepId, mergeId, moved);
        await moveJoinTables(tx, live.keep, live.merge, moved);
        await moveRemainingRelations(tx, keepId, mergeId, actor, moved);
        await moveRoles(tx, keepId, mergeId, actor, moved);
        await moveAttestations(tx, live.keep, live.merge, moved);
        await moveCorporations(tx, live.keep, live.merge, moved);
        await moveBucketTreasurers(tx, keepId, mergeId, moved);
        await moveMailAliases(tx, keepId, mergeId, moved);
        refuseLeftRows(moved);

        // 6. The household lead guard ran pre-tx. The merged-away record's
        // household loses a member with the delete below; a household left with
        // nobody in it stays, as one whose last member was removed does.

        await archiveMerge(tx, keepId, live.merge);
        await deleteMergedPerson(tx, mergeId);
        await auditMerge(tx, plan, live, actor, moved);
    });

    // The keeper may have just inherited a still-valid background check, which
    // can leave the household's parked application covered. Post-commit: the
    // survivor's live leads are only final once the merged-away lead flag and
    // the keeper's date have landed. Never throws.
    //
    // Session actors only: this advances membership state, and the conflict-of-
    // interest guard — the thing that stops an actor clearing their own
    // household — can only be applied to a session.
    if (actor) {
        await advanceHouseholdBgAfterMerge(keep.householdId, actor.id, mergeId, plan.bgFreshBeforeMerge);
    }

    invalidateAttendanceCache();
}

/**
 * Lock order: BOARD roles, then the application rows this merge writes, then both
 * households' membership rows, then the keeper, then the merged-away record. BOARD first is the order a role
 * change takes. Application before membership is the order payment, clearance
 * and reset take, so a merge never holds a household row while it waits on an
 * application. The membership rows serialize a deny with the merge even when
 * there are no BOARD rows to lock.
 */
async function lockAndRecheckKeeper(tx: TxClient, keepId: number, mergeId: number, householdIds: number[]): Promise<void> {
    await lockBoardRoles(tx);
    await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess"
        WHERE "subjectPersonId" IN (${keepId}, ${mergeId}) OR "zohoSignerPersonId" = ${mergeId} OR "noteAckById" = ${mergeId}
        ORDER BY id FOR UPDATE`;
    await lockAndFindDeniedHousehold(tx, householdIds);
    const [keeper] = await tx.$queryRaw<{ mergedIntoId: number | null }[]>`SELECT "mergedIntoId" FROM "Person" WHERE id = ${keepId} FOR UPDATE`;
    if (!keeper || keeper.mergedIntoId !== null) throw new AlreadyMergedError();
    await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${mergeId} FOR UPDATE`;
}

/**
 * Re-run the subject and collision refusals on a live read, under the
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
    const refusal = subjectRefusal(keep, merge, actor) ?? await collisionRefusal(tx, keep, merge);
    if (refusal) throw new MergeRefusedError(refusal);
    const parsed = parseFieldChoices(keep, merge, plan.choices);
    const keeperUpdate = 'error' in parsed ? parsed : planKeeperUpdate(keep, merge, parsed.choices);
    if ('error' in keeperUpdate) throw new MergeRefusedError(CHANGED_WHILE_MERGING);
    const trustBlock = await trustedLoginRefusal(tx, { emailChangeReason: plan.emailChangeReason, keeperUpdate: keeperUpdate.data, keepId: keep.id, mergeId: merge.id }, actor);
    if (trustBlock) throw new MergeRefusedError(trustBlock);
    return { keep, merge, keeperUpdate: keeperUpdate.data };
}

/**
 * 1. Clear the merged-away identity first (CAS) — frees its unique
 * email/googleId so the keeper can adopt them without a P2002. updateMany (not
 * update) so `mergedIntoId: null` is part of the write: it refuses a merged-away
 * record that is already a tombstone. Two concurrent merges of the same mergeId
 * serialize on the row lock in lockAndRecheckKeeper, and the loser finds the row
 * deleted in recheckSubjects.
 */
async function clearTombstoneIdentity(tx: TxClient, mergeId: number, keepId: number): Promise<void> {
    const cas = await tx.person.updateMany({
        where: { id: mergeId, mergedIntoId: null },
        data: {
            mergedIntoId: keepId,
            googleId: null,
            email: `merged-${mergeId}@deleted.invalid`,
            // Null the verified stamp with the identity: no tombstone
            // row should carry a "verified" mark for the sentinel address.
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
    if (cas.count !== 1) throw new AlreadyMergedError();
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
 * ToolStatus, future RSVP) were refused under the locks; a `left` row means one
 * raced in since, and refuseLeftRows refuses the merge. Bare-join collisions
 * (ProgramVolunteer) auto-dedupe.
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
        if (!keep.toolStatuses.find(k => k.toolId === tool.toolId)) {
            await tx.toolStatus.update({
                where: { personId_toolId: { toolId: tool.toolId, personId: mergeId } },
                data: { personId: keepId },
            });
            moved.toolStatuses.migrated++;
        } else {
            moved.toolStatuses.left++;
        }
    }
}

/** 5. Move the remaining MOVE relations — single updateMany each, no delete. */
async function moveRemainingRelations(tx: TxClient, keepId: number, mergeId: number, actor: AuthenticatedUser | null, moved: Tallies): Promise<void> {
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
    moved.noteAcks = (await tx.orgMembershipProcess.updateMany({ where: { noteAckById: mergeId }, data: { noteAckById: keepId } })).count;
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
    // Legacy tombstone rows that name THIS record as their survivor.
    // Person.mergedIntoId is SET NULL, so the delete would otherwise turn each
    // back into a live person.
    moved.chainedTombstones = (await tx.person.updateMany({ where: { mergedIntoId: mergeId }, data: { mergedIntoId: keepId } })).count;
    moved.bucketOwners = (await tx.budgetOwner.updateMany({ where: { ownerId: mergeId }, data: { ownerId: keepId } })).count;
}

/**
 * PersonRole.personId is CASCADE — a role left on the tombstone is a security
 * grant a later delete destroys. Each role moves through setRoleFlag, the role
 * routes' choke point, so it runs their guards and writes one audit row per
 * change: granted to the keeper first (a no-op when the keeper already holds
 * it), then revoked from the tombstone, so a moving BOARD never counts down to
 * zero. A moved row keeps its original grant metadata; the audit rows name the
 * merging actor. Read in the transaction so a role granted after the pre-tx
 * read still moves.
 */
async function moveRoles(tx: TxClient, keepId: number, mergeId: number, actor: AuthenticatedUser | null, moved: Tallies): Promise<void> {
    const tombstoneRoles = await tx.personRole.findMany({
        where: { personId: mergeId },
        select: { role: true, grantedById: true, grantedAt: true },
    });
    for (const { role, grantedById, grantedAt } of tombstoneRoles) {
        if (!actor) throw new RoleMatrixError("Forbidden");
        const flag = KIND_TO_FLAG[role];
        const granted = await setRoleFlag(tx, keepId, flag, true, actor);
        await setRoleFlag(tx, mergeId, flag, false, actor);
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
 * always has an archive row to resolve through. fromId is @unique and the
 * step-1 CAS already serialises concurrent merges of the same id, so a create
 * here cannot collide without the CAS having failed first.
 */
async function archiveMerge(tx: TxClient, keepId: number, merge: MergeSubject): Promise<void> {
    await tx.personMerge.create({
        data: { fromId: merge.id, toId: keepId, snapshot: mergeSnapshot(merge) },
    });
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
