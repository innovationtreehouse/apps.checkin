import type { PersonRoleKind } from "@/generated/prisma/client";
import { type DbClient, type TxClient, withTx } from "@/lib/db-client";
import { personActor, systemActor, type SystemActorName } from "@/lib/auditActor";
import { resolveActorHouseholdId, sharesHousehold } from "@/lib/conflictOfInterest";
import { archiveOpenKvas, hasSignedCurrentKva, openKvaIfNeeded } from "@/lib/membership/keyVolunteerProcess";

/**
 * The ONE hand-written map: session/JWT authority flag -> PersonRole table kind.
 * Everything else in this file (the RoleFlag type, ROLE_FLAGS, rolesToFlags) is
 * derived from it — adding a role is meant to start and end here (plus the
 * PersonRoleKind enum in prisma/schema.prisma, and wherever the new flag needs
 * to be surfaced: next-auth.d.ts's JWT/Session interfaces, RoleBadge's
 * ROLE_META). The flag names are the derived claim names that
 * `withAuth`/`BusinessRole`/`SessionUser`/the session-claim consumers read.
 */
export const FLAG_TO_KIND = {
    isSysadmin: "SYSADMIN",
    isBoardMember: "BOARD",
    isKeyholder: "KEYHOLDER",
    isBackgroundCheckReviewer: "BG_REVIEWER",
    isOperations: "OPERATIONS",
    isInventoryManager: "INVENTORY_MANAGER",
    isFinance: "FINANCE",
    isKeyVolunteer: "KEY_VOLUNTEER",
} as const satisfies Record<string, PersonRoleKind>;

export type RoleFlag = keyof typeof FLAG_TO_KIND;

export const ROLE_FLAGS: RoleFlag[] = Object.keys(FLAG_TO_KIND) as RoleFlag[];

export const KIND_TO_FLAG = Object.fromEntries(
    Object.entries(FLAG_TO_KIND).map(([flag, kind]) => [kind, flag]),
) as Record<PersonRoleKind, RoleFlag>;

/**
 * Legacy mirror columns on Person, kept in sync by write-through so
 * `where:{isBoardMember:true}`-style readers stay correct.
 * OPERATIONS has no column, so it's table-only.
 */
export const KIND_TO_MIRROR: Partial<Record<PersonRoleKind, RoleFlag>> = {
    SYSADMIN: "isSysadmin",
    BOARD: "isBoardMember",
    KEYHOLDER: "isKeyholder",
    BG_REVIEWER: "isBackgroundCheckReviewer",
};

/**
 * Roles granted only to a Key Volunteer who has signed the current agreement.
 * `KEY_VOLUNTEER` cannot be removed while the person holds any of them.
 */
export const KEY_VOLUNTEER_GATED_FLAGS: readonly RoleFlag[] = ["isBoardMember", "isBackgroundCheckReviewer"];

/**
 * The order one request's role changes are written in, so a single request can
 * do what the Key Volunteer rules allow: revocations first, `isKeyVolunteer`
 * last among them (after the roles it underpins); then grants, `isKeyVolunteer`
 * first.
 */
export function orderRoleChanges(requested: Partial<Record<RoleFlag, boolean>>): [RoleFlag, boolean][] {
    const changes = ROLE_FLAGS.filter((f) => requested[f] !== undefined).map((f): [RoleFlag, boolean] => [f, requested[f]!]);
    const kvLast = (a: [RoleFlag, boolean], b: [RoleFlag, boolean]) =>
        Number(a[0] === "isKeyVolunteer") - Number(b[0] === "isKeyVolunteer");
    return [
        ...changes.filter(([, on]) => !on).sort(kvLast),
        ...changes.filter(([, on]) => on).sort((a, b) => kvLast(b, a)),
    ];
}

/** Derive the session booleans from a person's `PersonRole` rows. */
export function rolesToFlags(rows: { role: PersonRoleKind }[]): Record<RoleFlag, boolean> {
    const held = new Set(rows.map((r) => r.role));
    return Object.fromEntries(
        ROLE_FLAGS.map((flag) => [flag, held.has(FLAG_TO_KIND[flag])]),
    ) as Record<RoleFlag, boolean>;
}

/**
 * Grant or revoke one role flag: writes the `PersonRole` row (truth + grant
 * metadata) AND mirrors the legacy boolean column (if one exists), in one tx.
 * Private dual-write primitive — `setRoleFlag` is the only caller (it owns
 * the lock + invariants).
 *
 * Idempotent: granting an already-held role keeps the original grant metadata
 * (upsert's `update` is a no-op) rather than clobbering grantedAt/grantedById.
 */
async function applyRoleFlag(
    db: DbClient,
    personId: number,
    flag: RoleFlag,
    on: boolean,
    grantedById?: number,
): Promise<void> {
    const role = FLAG_TO_KIND[flag];
    await withTx(db, async (tx) => {
        if (on) {
            await tx.personRole.upsert({
                where: { personId_role: { personId, role } },
                create: { personId, role, grantedById },
                update: {},
            });
        } else {
            await tx.personRole.deleteMany({ where: { personId, role } });
        }
        const mirror = KIND_TO_MIRROR[role];
        if (mirror) {
            await tx.person.update({ where: { id: personId }, data: { [mirror]: on } });
        }
    });
}

/** A position of trust: every granted role, plus those derived from other tables. */
export type TrustedRole = PersonRoleKind | "BUCKET_OWNER" | "BUCKET_TREASURER" | "PROGRAM_LEADER" | "TOOL_CERTIFIER";

/**
 * The one answer to "is this person trusted?", and which roles make them so.
 * The list is set by Board ruling and owner decision.
 * Any row counts, including on an archived bucket or a past program, so the
 * answer stays fail-closed until the row itself is removed.
 */
export async function trustStatus(db: DbClient, personId: number): Promise<{ isTrusted: boolean; roles: TrustedRole[] }> {
    const person = await db.person.findUnique({
        where: { id: personId },
        select: {
            roles: { select: { role: true } },
            budgetOwnersOwned: { select: { id: true }, take: 1 },
            budgetOwnerTreasurerships: { select: { budgetOwnerId: true }, take: 1 },
            programsLed: { select: { id: true }, take: 1 },
            instancesLed: { select: { id: true }, take: 1 },
            toolStatuses: { where: { level: "MAY_CERTIFY_OTHERS" }, select: { toolId: true }, take: 1 },
        },
    });
    if (!person) return { isTrusted: false, roles: [] };
    const roles: TrustedRole[] = person.roles.map((r) => r.role);
    if (person.budgetOwnersOwned.length > 0) roles.push("BUCKET_OWNER");
    if (person.budgetOwnerTreasurerships.length > 0) roles.push("BUCKET_TREASURER");
    if (person.programsLed.length + person.instancesLed.length > 0) roles.push("PROGRAM_LEADER");
    if (person.toolStatuses.length > 0) roles.push("TOOL_CERTIFIER");
    return { isTrusted: roles.length > 0, roles };
}

/** Thrown by `setRoleFlag` when the actor's authority matrix denies the requested change. */
export class RoleMatrixError extends Error {}
/** Thrown by `setRoleFlag` when the change would remove the last remaining board member. */
export class LastBoardMemberError extends Error {}
/** Thrown by `setRoleFlag` when granting BOARD to a member of a DENIED household. */
export class DeniedHouseholdBoardError extends Error {}
/** Thrown when granting a gated role to someone who is not a Key Volunteer signed at the current agreement version. */
export class KeyVolunteerAgreementRequiredError extends Error {}
/** Thrown when removing KEY_VOLUNTEER from someone who still holds a gated role. */
export class KeyVolunteerRemovalOrderError extends Error {}
/** Thrown when an actor changes a role or flag on themself or someone in their own household. */
export class OwnHouseholdRoleError extends Error {
    constructor(readonly targetId: number) { super(); }
}

/**
 * Refuses a role/flag change whose target is the actor or shares the actor's
 * household (`Person.householdId` — a person is in exactly one). Applies to every
 * role kind and every person actor, sysadmin and board alike. Fails closed when
 * the actor id is not a positive integer or does not resolve to a person.
 */
export async function assertNotOwnHousehold(db: DbClient, actorId: number, targetId: number): Promise<void> {
    const actorHouseholdId = await resolveActorHouseholdId(db, actorId);
    if (actorHouseholdId === null) throw new RoleMatrixError("Forbidden");
    if (actorId === targetId) throw new OwnHouseholdRoleError(targetId);
    const target = await db.person.findUnique({ where: { id: targetId }, select: { householdId: true } });
    if (sharesHousehold(actorHouseholdId, target?.householdId)) throw new OwnHouseholdRoleError(targetId);
}

/**
 * Locks the BOARD role rows FOR UPDATE. `setRoleFlag` takes it before any role
 * write, and a household deny takes it before its board-member probe, so a BOARD
 * grant and a deny of the grantee's household serialize: whichever runs second
 * sees the other's committed write.
 */
export async function lockBoardRoles(tx: TxClient): Promise<void> {
    await tx.$queryRaw`SELECT "personId" FROM "PersonRole" WHERE "role" = 'BOARD' FOR UPDATE`;
}

/**
 * A logged-in actor's authority, for the matrix check below — or a named system
 * actor that bypasses the matrix and the own-household rule. The system form is
 * for callers that have no requesting user to check authority against because
 * the caller IS the trusted source of the grant (bootstrap first-sysadmin
 * promotion off an env allowlist; dev seed fixtures) — not a shortcut for "skip
 * the checks", which is why it does NOT also skip the last-board-member guard
 * below, and its grants are still audited under its own name.
 */
export type RoleActor =
    | { id: number; isBoardMember: boolean; isSysadmin: boolean }
    | { system: SystemActorName };

/**
 * `move: true` is a person merge carrying a role from the merged-away record to
 * the keeper. It is the same person's existing grant, not a new one, so the Key
 * Volunteer grant check does not apply to it.
 */
export type RoleWriteOptions = { move?: boolean };

/**
 * Whether `actor` may grant or remove KEY_VOLUNTEER: a board member; or a
 * sysadmin while no board member exists, so a new installation can seat its
 * first board. A system actor is not checked.
 */
export async function mayManageKeyVolunteers(db: DbClient, actor: { isBoardMember?: boolean; isSysadmin?: boolean }): Promise<boolean> {
    if (actor.isBoardMember) return true;
    return !!actor.isSysadmin && (await db.personRole.count({ where: { role: "BOARD" } })) === 0;
}

/**
 * THE write choke point for role changes. Grants/revokes one `flag` on
 * `target`, owning every invariant a role write has to hold:
 *
 *  - the per-flag authority matrix: a board actor may grant/revoke any
 *    of the five flags, including adding/removing isSysadmin and removing
 *    isBoardMember; a sysadmin-only actor (not board) may grant any flag,
 *    including adding board, but may never remove board membership.
 *    A system actor skips this check entirely.
 *  - the own-household rule (`assertNotOwnHousehold`): no person actor changes
 *    a role on themself or anyone in their household. A no-op writes nothing,
 *    so it returns before this check.
 *  - the last-board-member guard: board membership can never be revoked down
 *    to zero, regardless of actor (including a system actor — this protects data
 *    integrity, not authority, so the bypass above does not extend to it).
 *  - the denied-household guard: BOARD can't be granted to a member of a DENIED
 *    household, the mirror of the deny-side refusal in
 *    POST /api/membership-ops/households. Also actor-independent.
 *  - the Key Volunteer rules (docs/rules/membership.md): KEY_VOLUNTEER is granted
 *    and removed by the Board (`mayManageKeyVolunteers`); the gated roles are
 *    granted only to a Key Volunteer signed at the current agreement version, for
 *    every actor; KEY_VOLUNTEER can't be removed while a gated role is held.
 *    Granting it opens the agreement; removing it archives an open, unsigned one
 *    and returns that agreement's Zoho request ids for the caller to recall
 *    (`recallSigningRequests`) once its transaction commits.
 *  - the audit row: every change writes one AuditLog row (actor, target, flag,
 *    before/after) in the same transaction as the write.
 *
 * Every writer that mutates a role — the PATCH /api/roles route, bootstrap
 * self-promotion, dev seeds — routes through here, so a new caller can't
 * accidentally skip any of them.
 *
 * Locks the whole BOARD row set FOR UPDATE before checking or writing.
 * ponytail: FOR UPDATE over the whole set — tiny table (a handful of rows),
 * so a coarse lock is fine; per-row locking buys nothing at this scale. This
 * serializes concurrent board-removals so two txns can't each drop a
 * different board member down to zero. Re-acquiring the lock on rows this
 * same transaction already holds is a no-op, so calling this more than once
 * per request (one delta field at a time) is safe.
 *
 * A no-op (flag already at `on`, per the under-lock read) returns
 * `{changed:false}` after taking the lock but without writing or auditing.
 */
export async function setRoleFlag(
    db: DbClient,
    personId: number,
    flag: RoleFlag,
    on: boolean,
    actor: RoleActor,
    { move = false }: RoleWriteOptions = {},
): Promise<{ changed: boolean; before: boolean; after: boolean; recallRequestIds: string[] }> {
    return withTx(db, async (tx) => {
        // Lock the BOARD row set FIRST, then read THIS person's roles under the lock,
        // so the no-op short-circuit and the returned before/after are consistent with
        // the write (no pre-lock snapshot). ponytail: a no-op takes the lock
        // before returning — fine, the board table is a handful of rows.
        await lockBoardRoles(tx);

        const rows = await tx.personRole.findMany({ where: { personId }, select: { role: true } });
        const held = rolesToFlags(rows);
        const before = held[flag];
        if (before === on) return { changed: false, before, after: before, recallRequestIds: [] };

        if (!("system" in actor)) await assertNotOwnHousehold(tx, actor.id, personId);

        if (!("system" in actor)) {
            if (!actor.isBoardMember) {
                if (!actor.isSysadmin) {
                    // Unreachable via the API: the route's withAuth gate already 403'd
                    // anyone who is neither board nor sysadmin before this is ever called.
                    // Kept as a defensive matrix boundary for any future caller.
                    throw new RoleMatrixError("Forbidden");
                }
                if (flag === "isBoardMember" && on === false) {
                    throw new RoleMatrixError("Only board members can remove board membership");
                }
            }
            if (flag === "isKeyVolunteer" && !(await mayManageKeyVolunteers(tx, actor))) {
                throw new RoleMatrixError("Only board members can grant or remove the Key Volunteer role");
            }
        }

        if (flag === "isBoardMember" && on === false) {
            const boardCount = await tx.personRole.count({ where: { role: "BOARD" } });
            if (boardCount <= 1) throw new LastBoardMemberError();
        }

        // The other half of the deny guard in POST /api/membership-ops/households: a
        // denied household holds no authority and every member of it is locked out of
        // sign-in, so BOARD can't be granted into one from this side either. Like the
        // last-board guard this protects the data, not authority — a system actor doesn't
        // bypass it.
        if (flag === "isBoardMember" && on === true) {
            const target = await tx.person.findUnique({
                where: { id: personId },
                select: { household: { select: { orgMembership: { select: { status: true } } } } },
            });
            if (target?.household.orgMembership?.status === "DENIED") throw new DeniedHouseholdBoardError();
        }

        if (on && !move && KEY_VOLUNTEER_GATED_FLAGS.includes(flag)) {
            if (!held.isKeyVolunteer || !(await hasSignedCurrentKva(tx, personId))) {
                throw new KeyVolunteerAgreementRequiredError();
            }
        }
        if (flag === "isKeyVolunteer" && !on && KEY_VOLUNTEER_GATED_FLAGS.some((f) => held[f])) {
            throw new KeyVolunteerRemovalOrderError();
        }

        const auditActor = "system" in actor ? systemActor(actor.system) : personActor(actor.id);
        await applyRoleFlag(tx, personId, flag, on, "system" in actor ? undefined : actor.id);
        let recallRequestIds: string[] = [];
        if (flag === "isKeyVolunteer") {
            if (on) await openKvaIfNeeded(tx, personId, auditActor);
            else recallRequestIds = await archiveOpenKvas(tx, { subjectPersonId: personId }, auditActor, "Key Volunteer role removed");
        }
        await tx.auditLog.create({
            data: {
                ...auditActor,
                action: "EDIT",
                tableName: "PersonRole",
                affectedEntityId: personId,
                oldData: { [flag]: before },
                newData: { [flag]: on },
            },
        });
        return { changed: true, before, after: on, recallRequestIds };
    });
}
