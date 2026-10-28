import prisma from "@/lib/prisma";
import type { AuthenticatedUser } from "@/types/auth";
import type { TxClient } from "@/lib/db-client";
import { personBgOpen } from "@/lib/membership/lifecycle";
import { advanceHouseholdBgAfterMerge, householdBgFresh } from "@/lib/membership/mergeBgAdvance";
import { refuseSelfGrant } from "@/lib/membership/selfGrantGuard";
import { lockAndFindDeniedHousehold } from "@/lib/membership/householdStatus";
import { KIND_TO_FLAG, setRoleFlag, lockBoardRoles, RoleMatrixError } from "@/lib/roles";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
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

/** Thrown when the tombstone CAS loses the race (concurrent/repeat merge). */
export class AlreadyMergedError extends Error {}

/** Thrown when a subject refusal that passed in prepareMerge applies under the lock. */
export class MergeRefusedError extends Error {
    constructor(public readonly refusal: MergeRefusal) {
        super(refusal.error);
    }
}

export type MergePlan = {
    keep: KeepSubject;
    merge: MergeSubject;
    choices: FieldChoices;
    keeperUpdate: Record<string, unknown>;
    bgFreshBeforeMerge: boolean;
};

/**
 * Load both people and run every pre-transaction refusal, in the order a
 * caller sees them. Returns the plan to execute, or why the merge is refused.
 */
export async function prepareMerge(
    actor: AuthenticatedUser | null,
    keepId: number,
    mergeId: number,
    fieldChoices: unknown,
): Promise<{ plan: MergePlan } | { refused: MergeRefusal }> {
    const keep = await prisma.person.findUnique({ where: { id: keepId }, include: KEEP_INCLUDE });
    const merge = await prisma.person.findUnique({ where: { id: mergeId }, include: MERGE_INCLUDE });

    if (!keep || !merge) {
        return { refused: { status: 404, error: "Participant(s) not found." } };
    }

    // Double-merge / merge-a-tombstone guard — either side, before opening the tx.
    if (keep.mergedIntoId != null || merge.mergedIntoId != null) {
        return { refused: { status: 409, error: "Cannot merge: one of these participants has already been merged." } };
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

    const [keeperOpenVisit, mergeOpenVisit] = await Promise.all([
        prisma.visit.findFirst({ where: { personId: keepId, departedAt: null, deletedAt: null }, select: { id: true } }),
        prisma.visit.findFirst({ where: { personId: mergeId, departedAt: null, deletedAt: null }, select: { id: true } }),
    ]);
    const collisions = findCollisions(keep, merge, { keep: !!keeperOpenVisit, merge: !!mergeOpenVisit }, new Date());
    if (collisions.length > 0) {
        const detail = collisions.map(c => c.message).join('; ');
        return { refused: { status: 409, error: `Cannot merge: ${detail}`, collisions } };
    }

    const parsed = parseFieldChoices(keep, merge, fieldChoices);
    if ('error' in parsed) return { refused: { status: 400, error: parsed.error } };

    const keeperUpdate = planKeeperUpdate(keep, merge, parsed.choices);
    if ('error' in keeperUpdate) return { refused: { status: 400, error: keeperUpdate.error } };

    // The post-commit carryover acts only on a household THIS merge made
    // background-check fresh, so it needs the pre-merge answer: afterwards the
    // keeper already carries the merged date and the two are indistinguishable.
    const bgFreshBeforeMerge = await householdBgFresh(keep.householdId);

    return { plan: { keep, merge, choices: parsed.choices, keeperUpdate: keeperUpdate.data, bgFreshBeforeMerge } };
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
 * Run the merge transaction, then the post-commit membership carryover.
 * Throws AlreadyMergedError on a lost race, and the lib/roles errors when a
 * role move is refused.
 */
export async function executeMerge(plan: MergePlan, actor: AuthenticatedUser | null): Promise<void> {
    const { keep, merge } = plan;
    const keepId = keep.id;
    const mergeId = merge.id;

    await prisma.$transaction(async (tx) => {
        await lockAndRecheckKeeper(tx, keepId, mergeId, [keep.householdId, merge.householdId]);
        await recheckSubjects(tx, plan, actor);
        await clearTombstoneIdentity(tx, mergeId, keepId);
        await applyKeeperChoices(tx, keepId, plan.keeperUpdate);

        const moved = emptyTallies();
        await moveVisits(tx, keepId, mergeId, moved);
        await moveJoinTables(tx, keep, merge, moved);
        await moveRemainingRelations(tx, keepId, mergeId, actor, moved);
        await moveRoles(tx, keepId, mergeId, actor, moved);
        await moveAttestations(tx, keep, merge, moved);
        await moveCorporations(tx, keep, merge, moved);
        await moveBucketTreasurers(tx, keepId, mergeId, moved);
        await moveMailAliases(tx, keepId, mergeId, moved);

        // 6. The household lead guard ran pre-tx. householdId stays pointing at
        // the old household: every participant must belong to one, and merged-away
        // records are tombstoned rather than deleted. Leadership was cleared in
        // step 1's CAS.

        await archiveMerge(tx, keepId, merge);
        await auditMerge(tx, plan, actor, moved);
    });

    // The keeper may have just inherited a still-valid background check, which
    // can leave the household's parked application covered. Post-commit: the
    // survivor's live leads are only final once the tombstone's lead flag and
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
 * households' membership rows, then the keeper. BOARD first is the order a role
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
}

/**
 * Re-run the subject refusals on a live read, under the households' membership
 * locks: a household denied after prepareMerge is seen here and refuses the
 * merge. A subject that changed household since the plan refuses too, since the
 * locks cover the planned households only.
 */
async function recheckSubjects(tx: TxClient, plan: MergePlan, actor: AuthenticatedUser | null): Promise<void> {
    const keep = await tx.person.findUniqueOrThrow({ where: { id: plan.keep.id }, include: KEEP_INCLUDE });
    const merge = await tx.person.findUniqueOrThrow({ where: { id: plan.merge.id }, include: MERGE_INCLUDE });
    if (keep.householdId !== plan.keep.householdId || merge.householdId !== plan.merge.householdId) {
        throw new MergeRefusedError({ status: 409, error: "One of these participants changed household while merging. Reload and try again." });
    }
    const refusal = subjectRefusal(keep, merge, actor);
    if (refusal) throw new MergeRefusedError(refusal);
}

/**
 * 1. Clear tombstone identity first (CAS) — frees the tombstone's unique
 * email/googleId so the keeper can adopt them without a P2002. updateMany (not
 * update) so `mergedIntoId: null` is part of the write: two concurrent merges
 * targeting the same mergeId race on this row, and exactly one wins — the
 * loser's count is 0 and its tx rolls back.
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
            // Every PersonRole row moves off the tombstone in moveRoles, so its
            // legacy role mirrors must go with them. Zeroed here rather than
            // derived after the loop for the same reason isHouseholdLead is: a
            // merged-away record holds no authority, so `false` is the right
            // value even if a row raced in.
            ...roleMirrors(new Set()),
            // Name is NOT mangled — mergedIntoId carries the semantics; the UI
            // shows a "merged" badge wherever tombstones surface.
        },
    });
    if (cas.count !== 1) throw new AlreadyMergedError();
}

/** 2. Apply the keeper field choices computed before the transaction. */
async function applyKeeperChoices(tx: TxClient, keepId: number, data: Record<string, unknown>): Promise<void> {
    if (Object.keys(data).length > 0) {
        await tx.person.update({ where: { id: keepId }, data });
    }
}

/**
 * 3. Move visits. Both-open was pre-refused; the keeper-open guard here covers
 * a visit opened between that check and the CAS.
 */
async function moveVisits(tx: TxClient, keepId: number, mergeId: number, moved: Tallies): Promise<void> {
    const keeperHasOpenVisit = await tx.visit.findFirst({ where: { personId: keepId, departedAt: null, deletedAt: null }, select: { id: true } });
    moved.visits = (await tx.visit.updateMany({
        where: { personId: mergeId, ...(keeperHasOpenVisit ? { departedAt: { not: null } } : {}) },
        data: { personId: keepId },
    })).count;
}

/**
 * 4. Move join tables. Decision-bearing collisions (ProgramParticipant,
 * ToolStatus) were pre-refused; the `left` fallback covers a race. Bare-join
 * collisions (ProgramVolunteer) auto-dedupe.
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
    // DELIBERATE exception to the no-deletion principle: sessions are auth
    // artifacts, not person data, and there's no reason for the keeper to
    // inherit the tombstone's login session. Sessions are JWT-strategy, so this
    // row is not what ends the tombstone's access — the LIVE_PERSON filter on
    // the jwt() re-sync (auth-options.ts) collapses that token on next refresh.
    await tx.session.deleteMany({ where: { userId: mergeId } });
    await tx.orgMembershipProcess.updateMany({ where: { subjectPersonId: mergeId }, data: { subjectPersonId: keepId } });
    // Both sides can have owed a check — the survivor keeps exactly one.
    moved.personBgArchived = await archiveDuplicatePersonBg(tx, keepId, actor ? actor.id : 0);
    await tx.program.updateMany({ where: { leadMentorId: mergeId }, data: { leadMentorId: keepId } });
    await tx.programInstance.updateMany({ where: { leadMentorId: mergeId }, data: { leadMentorId: keepId } });
    await tx.trustedAdult.updateMany({ where: { trustedAdultPersonId: mergeId }, data: { trustedAdultPersonId: keepId } });
    await tx.trustedAdult.updateMany({ where: { disclosedById: mergeId }, data: { disclosedById: keepId } });

    // RawBadgeLog.personId is RESTRICT: a scan left on the tombstone pins
    // that Person row in place forever.
    moved.rawBadgeLogs = (await tx.rawBadgeLog.updateMany({ where: { personId: mergeId }, data: { personId: keepId } })).count;
    // PresenceEvent.personId is CASCADE: the append-only log follows the
    // survivor so later flushes project against the live record.
    moved.presenceEvents = (await tx.presenceEvent.updateMany({ where: { personId: mergeId }, data: { personId: keepId } })).count;

    // "Which staff member did this" facts, all SET NULL — left on the
    // tombstone they read as nobody the moment the row goes.
    moved.noteAcks = (await tx.orgMembershipProcess.updateMany({ where: { noteAckById: mergeId }, data: { noteAckById: keepId } })).count;
    moved.zohoSigners = (await tx.orgMembershipProcess.updateMany({ where: { zohoSignerPersonId: mergeId }, data: { zohoSignerPersonId: keepId } })).count;
    moved.attendanceConfirmations = (await tx.event.updateMany({ where: { attendanceConfirmedById: mergeId }, data: { attendanceConfirmedById: keepId } })).count;
    moved.facilityCloses = (await tx.facilityClose.updateMany({ where: { closedById: mergeId }, data: { closedById: keepId } })).count;
    moved.trustedAdultDecisions = (await tx.trustedAdultReview.updateMany({ where: { decidedById: mergeId }, data: { decidedById: keepId } })).count;

    // Earlier merges that named THIS record as their survivor. Repointed rather
    // than chained, unlike Person.mergedIntoId: the archive answers "where is
    // this person now", and its toId is RESTRICT, so leaving it would pin the
    // tombstone row in place. Collapsing the chain here is also why compliance
    // §6 attributes a date inherited two merges back. No unique constraint on
    // toId, so a plain updateMany.
    moved.archivedMerges = (await tx.personMerge.updateMany({ where: { toId: mergeId }, data: { toId: keepId } })).count;
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

/**
 * 7. Archive the merge. Same transaction as the tombstone write, so the two can
 * never disagree: fromId is @unique and the step-1 CAS already serialises
 * concurrent merges of the same id, so a create here cannot collide without
 * the CAS having failed first.
 */
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

async function archiveMerge(tx: TxClient, keepId: number, merge: MergeSubject): Promise<void> {
    await tx.personMerge.create({
        data: { fromId: merge.id, toId: keepId, snapshot: mergeSnapshot(merge) },
    });
}

/**
 * 8. Audit — tallies: migrated (repointed), deduped (bare-join duplicate
 * deleted), left (decision-bearing collision, race fallback).
 */
async function auditMerge(tx: TxClient, plan: MergePlan, actor: AuthenticatedUser | null, moved: Tallies): Promise<void> {
    if (!actor) return;
    await tx.auditLog.create({
        data: {
            actorId: actor.id,
            action: "DELETE",
            tableName: "Person",
            affectedEntityId: plan.keep.id,
            secondaryAffectedEntity: plan.merge.id,
            // Both pre-images, captured before either update ran: the merged-away
            // Person at the top level, the keeper — whose name/email/DOB a field
            // choice can overwrite — under `keeper`.
            oldData: {
                ...personPreImage(plan.merge),
                keeper: personPreImage(plan.keep),
            },
            newData: { keepId: plan.keep.id, fieldChoices: plan.choices, moved },
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
 * No new lifecycle edge: this is the declared §13 archive transition
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
