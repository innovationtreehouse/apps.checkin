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
 *     (`raiseDeniedHouseholdActivity`).
 *
 * Client-safe apart from the lazily-imported raise: Prisma is `import type` only,
 * and the writers take the client as a parameter.
 */
import type { Prisma, OrgMembershipStatus } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
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
    { from: "∅", to: "NONE", event: "ensureHouseholdMembership", actor: "applicant/board/system", guardSite: "householdStatus.ts upsert by householdId (create only, never sets status)" },
    { from: "NONE", to: "ACTIVE", event: "application converges (paid + check cleared)", actor: "system", guardSite: "setHouseholdStatus from [NONE, REVOKED]" },
    { from: "REVOKED", to: "ACTIVE", event: "application converges (paid + check cleared)", actor: "system", guardSite: "setHouseholdStatus from [NONE, REVOKED]" },
    { from: "ACTIVE", to: "REVOKED", event: "revoke", actor: "board", guardSite: `${ROUTE} setHouseholdStatus from [ACTIVE] + COI` },
    { from: "NONE", to: "DENIED", event: "deny", actor: "board", guardSite: `${ROUTE} setHouseholdStatus + COI + no board member` },
    { from: "ACTIVE", to: "DENIED", event: "deny", actor: "board", guardSite: `${ROUTE} setHouseholdStatus + COI + no board member` },
    { from: "REVOKED", to: "DENIED", event: "deny", actor: "board", guardSite: `${ROUTE} setHouseholdStatus + COI + no board member` },
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
    return db.orgMembership.upsert({
        where: { householdId },
        create: { householdId },
        update: {},
        select: { id: true, status: true },
    });
}

/**
 * The one writer of OrgMembership.status. Moves the row to `to` only if its status
 * is still one of `from` (compare-and-set), writes the audit row, and returns
 * whether it applied. A row already at `to` with `to` listed in `from` is a no-op
 * success (an ACTIVE household's renewal converging). Throws on an edge the table
 * doesn't declare — a programming error, not a race.
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
    const row = await db.orgMembership.findUnique({ where: { id: membershipId }, select: { status: true, householdId: true } });
    if (!row || !from.includes(row.status)) return false;
    if (row.status === to) return true;

    // CAS on the status just read, so the audit's oldData is exact and a concurrent
    // write in between (a deny landing before a revoke) makes this one miss.
    const { count } = await db.orgMembership.updateMany({
        where: { id: membershipId, ...fromWhere(row.status) },
        data: { status: to },
    });
    if (count !== 1) return false;
    await db.auditLog.create({
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
    return true;
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
        import("@/lib/finance/reconcile"),
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
