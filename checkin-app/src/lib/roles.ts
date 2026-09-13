import type { PersonRoleKind } from "@/generated/prisma/client";
import { type DbClient, withTx } from "@/lib/db-client";

/**
 * The ONE hand-written map: session/JWT authority flag -> PersonRole table kind.
 * Everything else in this file (the RoleFlag type, ROLE_FLAGS, rolesToFlags) is
 * derived from it — adding a role is meant to start and end here (plus the
 * PersonRoleKind enum in prisma/schema.prisma, and wherever the new flag needs
 * to be surfaced: next-auth.d.ts's JWT/Session interfaces, RoleBadge's
 * ROLE_META). The flag names are the derived claim names, unchanged from the
 * pre-table boolean-column era so `withAuth`/`BusinessRole`/`SessionUser`/the
 * ~200 session-claim consumers don't move (expand phase of expand/contract).
 */
export const FLAG_TO_KIND = {
    isSysadmin: "SYSADMIN",
    isBoardMember: "BOARD",
    isKeyholder: "KEYHOLDER",
    isBackgroundCheckReviewer: "BG_REVIEWER",
    isOperations: "OPERATIONS",
    isInventoryManager: "INVENTORY_MANAGER",
} as const satisfies Record<string, PersonRoleKind>;

export type RoleFlag = keyof typeof FLAG_TO_KIND;

export const ROLE_FLAGS: RoleFlag[] = Object.keys(FLAG_TO_KIND) as RoleFlag[];

/**
 * Legacy mirror columns on Person, kept in sync by write-through so the ~15
 * existing `where:{isBoardMember:true}`-style readers stay correct without
 * porting them this PR (contract PR ports them, then drops the columns).
 * OPERATIONS has none — it never shipped a column, so it's table-only.
 */
export const KIND_TO_MIRROR: Partial<Record<PersonRoleKind, RoleFlag>> = {
    SYSADMIN: "isSysadmin",
    BOARD: "isBoardMember",
    KEYHOLDER: "isKeyholder",
    BG_REVIEWER: "isBackgroundCheckReviewer",
};

/** Derive the five session booleans from a person's `PersonRole` rows. */
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

/** Thrown by `setRoleFlag` when the actor's authority matrix denies the requested change. */
export class RoleMatrixError extends Error {}
/** Thrown by `setRoleFlag` when the change would remove the last remaining board member. */
export class LastBoardMemberError extends Error {}
/** Thrown by `setRoleFlag` when granting BOARD to a member of a DENIED household. */
export class DeniedHouseholdBoardError extends Error {}

/**
 * A logged-in actor's authority, for the matrix check below — or the literal
 * `"system"` to bypass the matrix entirely. `"system"` is for callers that
 * have no requesting user to check authority against because the caller IS
 * the trusted source of the grant (bootstrap first-sysadmin promotion off an
 * env allowlist; dev seed fixtures) — not a shortcut for "skip the checks",
 * which is why it does NOT also skip the last-board-member guard below.
 */
export type RoleActor = { id: number; isBoardMember: boolean; isSysadmin: boolean } | "system";

/**
 * THE write choke point for role changes. Grants/revokes one `flag` on
 * `target`, owning every invariant a role write has to hold:
 *
 *  - the per-flag authority matrix (§4.3): a board actor may grant/revoke any
 *    of the five flags, including adding/removing isSysadmin and removing
 *    isBoardMember; a sysadmin-only actor (not board) may grant any flag,
 *    including adding board, but may never remove board membership.
 *    `actor: "system"` skips this check entirely.
 *  - the last-board-member guard: board membership can never be revoked down
 *    to zero, regardless of actor (including "system" — this protects data
 *    integrity, not authority, so the bypass above does not extend to it).
 *  - the denied-household guard: BOARD can't be granted to a member of a DENIED
 *    household, the mirror of the deny-side refusal in
 *    POST /api/membership-ops/households. Also actor-independent.
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
): Promise<{ changed: boolean; before: boolean; after: boolean }> {
    return withTx(db, async (tx) => {
        // Lock the BOARD row set FIRST, then read THIS person's roles under the lock,
        // so the no-op short-circuit and the returned before/after are consistent with
        // the write (thpr C: no pre-lock snapshot). ponytail: a no-op now takes the lock
        // before returning — fine, the board table is a handful of rows.
        await tx.$queryRaw`SELECT "personId" FROM "PersonRole" WHERE "role" = 'BOARD' FOR UPDATE`;

        const rows = await tx.personRole.findMany({ where: { personId }, select: { role: true } });
        const before = rolesToFlags(rows)[flag];
        if (before === on) return { changed: false, before, after: before };

        if (actor !== "system") {
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
        }

        if (flag === "isBoardMember" && on === false) {
            const boardCount = await tx.personRole.count({ where: { role: "BOARD" } });
            if (boardCount <= 1) throw new LastBoardMemberError();
        }

        // The other half of the deny guard in POST /api/membership-ops/households: a
        // denied household holds no authority and every member of it is locked out of
        // sign-in, so BOARD can't be granted into one from this side either. Like the
        // last-board guard this protects the data, not authority — "system" doesn't
        // bypass it.
        if (flag === "isBoardMember" && on === true) {
            const target = await tx.person.findUnique({
                where: { id: personId },
                select: { household: { select: { orgMembership: { select: { status: true } } } } },
            });
            if (target?.household.orgMembership?.status === "DENIED") throw new DeniedHouseholdBoardError();
        }

        await applyRoleFlag(tx, personId, flag, on, actor === "system" ? undefined : actor.id);
        return { changed: true, before, after: on };
    });
}
