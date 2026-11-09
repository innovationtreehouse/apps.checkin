/**
 * OrgMembership.status — the household's status machine, declared once.
 *
 * Same shape as `lifecycle.ts` (the application machine): the states, the
 * transition table, and `fromWhere`. Unlike that module it also owns the ONE
 * runtime writer of the column, `setHouseholdStatus`, plus the ∅→NONE create
 * `ensureHouseholdMembership`. `noRawStatusWrites.test.ts` fails CI on any other
 * status write under src/.
 *
 * Rules (owner, 2026-10-12 — docs/rules/membership.md):
 *   - only an application converging (paid + check cleared) makes a household ACTIVE;
 *   - ACTIVE stops only by REVOKED or DENIED; nothing returns ACTIVE/REVOKED to NONE;
 *   - DENIED never becomes ACTIVE; its only exit is the board's restore to NONE;
 *   - activity that reaches a DENIED household changes nothing and goes to the board
 *     (`raiseDeniedHouseholdActivity`);
 *   - entering DENIED revokes trusted-adult access and lists program ties for the
 *     board (`applyHouseholdDenial`); entering REVOKED does neither.
 *
 * Client-safe apart from the lazily-imported raise and denial: Prisma is `import type` only,
 * and the writers take the client as a parameter.
 */
import type { Prisma, OrgMembershipStatus } from "@/generated/prisma/client";
import { withTx, type DbClient, type TxClient } from "@/lib/db-client";
import type { AuditActor } from "@/lib/auditActor";
import { fromStatusWhere, isLegalTransition, type Transition, type Expect, type Equal } from "@/lib/lifecycle";

export type HouseholdStatus = "NONE" | "ACTIVE" | "REVOKED" | "DENIED";

/** Type-only enum parity: fails to compile if the schema enum drifts from the union. */
export type _StatusParity = Expect<Equal<HouseholdStatus, OrgMembershipStatus>>;

export const STATES: readonly HouseholdStatus[] = ["NONE", "ACTIVE", "REVOKED", "DENIED"];

/** The origin pseudo-state: no OrgMembership row yet. */
export type OriginState = "∅";
type TState = HouseholdStatus | OriginState;

const ROUTE = "membership-ops/households/route.ts";

export const TRANSITIONS: readonly Transition<TState>[] = [
    { from: "∅", to: "NONE", event: "ensureHouseholdMembership", actor: "applicant/board/system", guardSite: "householdStatus.ts insert by householdId skipping duplicates (create only, never sets status)" },
    { from: "NONE", to: "ACTIVE", event: "application converges (paid + check cleared)", actor: "system", guardSite: "payment.ts settle / review.ts clearBackgroundCheck: setHouseholdStatus from [NONE, REVOKED, ACTIVE] under OrgMembership FOR UPDATE" },
    { from: "REVOKED", to: "ACTIVE", event: "application converges (paid + check cleared)", actor: "system", guardSite: "payment.ts settle / review.ts clearBackgroundCheck: setHouseholdStatus from [NONE, REVOKED, ACTIVE] under OrgMembership FOR UPDATE" },
    { from: "ACTIVE", to: "REVOKED", event: "revoke", actor: "board", guardSite: `${ROUTE} setHouseholdStatus from [ACTIVE] + COI` },
    { from: "NONE", to: "DENIED", event: "deny", actor: "board", guardSite: `${ROUTE} setHouseholdStatus + COI + no board member, probed under the BOARD role lock` },
    { from: "ACTIVE", to: "DENIED", event: "deny", actor: "board", guardSite: `${ROUTE} setHouseholdStatus + COI + no board member, probed under the BOARD role lock` },
    { from: "REVOKED", to: "DENIED", event: "deny", actor: "board", guardSite: `${ROUTE} setHouseholdStatus + COI + no board member, probed under the BOARD role lock` },
    { from: "DENIED", to: "NONE", event: "restore (undeny)", actor: "board", guardSite: `${ROUTE} setHouseholdStatus from [DENIED] + COI` },
];

export const INITIAL_STATES: readonly HouseholdStatus[] = ["NONE"];

type Where = Prisma.OrgMembershipWhereInput;

/** The CAS `status` clause for one or more from-states. */
export function fromWhere(from: HouseholdStatus | readonly HouseholdStatus[]): Where {
    return fromStatusWhere<Where>(typeof from === "string" ? [from] : from);
}

/** ∅→NONE: the household's membership row, created at NONE if missing. Never changes an existing row. */
export async function ensureHouseholdMembership(db: DbClient, householdId: number): Promise<{ id: number; status: HouseholdStatus }> {
    // ON CONFLICT DO NOTHING waits out a concurrent insert without raising: a unique
    // violation would abort a caller's transaction, leaving it unable to read the winner.
    await db.orgMembership.createMany({ data: { householdId }, skipDuplicates: true });
    return db.orgMembership.findUniqueOrThrow({ where: { householdId }, select: { id: true, status: true } });
}

/**
 * The one writer of OrgMembership.status. Moves the row to `to` only if its status
 * is still one of `from` (compare-and-set), writes the audit row in the same
 * transaction (a savepoint when `db` is already a tx), and returns whether it
 * applied. A row already at `to` with `to` listed in `from` is a no-op success (an
 * ACTIVE household's renewal converging). Throws on an edge the table doesn't
 * declare — a programming error, not a race.
 */
export async function setHouseholdStatus(
    db: DbClient,
    membershipId: number,
    opts: { from: readonly HouseholdStatus[]; to: HouseholdStatus; actor: AuditActor; reason: string },
): Promise<boolean> {
    const { from, to, actor, reason } = opts;
    for (const f of from) {
        if (f !== to && !isLegalTransition(TRANSITIONS, f, to)) {
            throw new Error(`Household status ${f} → ${to} is not a declared transition`);
        }
    }
    return withTx(db, async (tx) => {
        const row = await tx.orgMembership.findUnique({ where: { id: membershipId }, select: { status: true, householdId: true } });
        if (!row || !from.includes(row.status)) return false;
        if (row.status === to) return true;

        // CAS on the status just read, so the audit's oldData is exact and a concurrent
        // write in between (a deny landing before a revoke) makes this one miss.
        const { count } = await tx.orgMembership.updateMany({
            where: { id: membershipId, ...fromWhere(row.status) },
            data: { status: to },
        });
        if (count !== 1) return false;
        await tx.auditLog.create({
            data: {
                ...actor,
                action: "EDIT",
                tableName: "OrgMembership",
                affectedEntityId: membershipId,
                secondaryAffectedEntity: row.householdId,
                oldData: { status: row.status },
                newData: { status: to, reason },
            },
        });
        // A denial's trusted-adult revocations and board items commit with it, whichever path denies.
        if (to === "DENIED") {
            const { applyHouseholdDenial } = await import("@/lib/membership/denial");
            await applyHouseholdDenial(tx, row.householdId, actor);
        }
        return true;
    });
}

/**
 * Locks the OrgMembership rows of `householdIds` FOR UPDATE, in household-id order,
 * and returns the first DENIED household among them, or null. A household move or
 * merge holds these locks so a concurrent deny either lands first and is seen, or
 * waits for the move. Callers that also take board roles (`lockBoardRoles`) take
 * them first, the order a deny takes its locks in.
 */
export async function lockAndFindDeniedHousehold(tx: TxClient, householdIds: readonly number[]): Promise<number | null> {
    let denied: number | null = null;
    for (const householdId of [...new Set(householdIds)].sort((a, b) => a - b)) {
        const [row] = await tx.$queryRaw<{ status: HouseholdStatus }[]>`SELECT status FROM "OrgMembership" WHERE "householdId" = ${householdId} FOR UPDATE`;
        if (row?.status === "DENIED" && denied === null) denied = householdId;
    }
    return denied;
}

/**
 * Something happened to a DENIED household after the deny (a payment, an approval,
 * an application start). Nothing changes; the board gets a CRITICAL payment
 * exception (queue + email). Call after the transaction commits: it writes through
 * the root client.
 */
export async function raiseDeniedHouseholdActivity(ref: {
    householdId: number;
    processId?: number | null;
    personId?: number | null;
    what: string;
}): Promise<void> {
    // Lazy so the table above stays importable without the DB client (generator CLI, pages).
    const [{ raisePaymentException }, { logger }, { default: prisma }] = await Promise.all([
        import("@/lib/finance/reconcile/exceptions"),
        import("@/lib/logger"),
        import("@/lib/prisma"),
    ]);
    logger.warn(`[membership] activity on DENIED household ${ref.householdId}: ${ref.what}`);
    // An exception row with neither a process nor a person would dedupe against every
    // other household's; anchor it on a household member instead.
    const personId = ref.processId || ref.personId
        ? ref.personId ?? null
        : (await prisma.person.findFirst({
              where: { householdId: ref.householdId },
              orderBy: [{ isHouseholdLead: "desc" }, { id: "asc" }],
              select: { id: true },
          }))?.id ?? null;
    await raisePaymentException("DENIED_HOUSEHOLD_ACTIVITY", {
        processId: ref.processId ?? null,
        personId,
        severity: "CRITICAL",
    });
}
