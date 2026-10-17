import { type DbClient, type TxClient, withTx } from "@/lib/db-client";
import prisma from "@/lib/prisma";
import { LIVE_PERSON } from "@/lib/person/filters";
import { isYouth } from "@/lib/time";

/**
 * Shared household-lead ownership check (audit P1-2). Loads the person and
 * decides whether they may manage their household. `canManage` folds in the
 * sysadmin override, matching every call site's `!isLead && !isSysadmin` guard.
 * Returns null when the user has no household. Callers own the error strings
 * (they differ per route), so this returns facts, not responses.
 */
export async function householdLeadship(
    userId: number,
): Promise<{ householdId: number; canManage: boolean } | null> {
    const user = await prisma.person.findUnique({
        where: { id: userId },
        select: { householdId: true, isHouseholdLead: true, isSysadmin: true },
    });
    if (!user?.householdId) return null;
    return { householdId: user.householdId, canManage: user.isHouseholdLead || user.isSysadmin };
}

/**
 * Emergency-contacts flavour of {@link householdLeadship}: the householdId on
 * success, or an `{error,status}` the route can return directly.
 */
export async function leadHousehold(
    userId: number,
): Promise<number | { error: string; status: number }> {
    const hh = await householdLeadship(userId);
    if (!hh) return { error: "You must create a household first.", status: 400 };
    if (!hh.canManage) return { error: "Only household leads can manage emergency contacts.", status: 403 };
    return hh.householdId;
}

/**
 * Maximum number of leads a single household may have (issue #269).
 * This is policy, not schema shape — change it here, not in a migration.
 */
export const MAX_HOUSEHOLD_LEADS = 2;

/**
 * The canonical "leads of household X" Prisma filter (a1). Single source of truth
 * for the `{ householdId, isHouseholdLead: true }` predicate that would otherwise
 * be hand-spelled at every count/list/stamp call site — keeps them from drifting.
 */
export const householdLeadsWhere = (householdId: number) =>
    ({ householdId, isHouseholdLead: true }) as const;

/** Thrown by {@link addHouseholdLead} when the per-household lead cap is reached. */
export class HouseholdLeadLimitError extends Error {
    constructor(public readonly householdId: number) {
        super(`A household can have at most ${MAX_HOUSEHOLD_LEADS} leads.`);
        this.name = "HouseholdLeadLimitError";
    }
}

/**
 * Thrown when a leader whose household is passed to a lead helper does not actually
 * belong to that household — the invariant `Person.householdId === householdId` that
 * makes `isHouseholdLead` mean "lead of their OWN household". Callers pass the
 * person's own household, so this is a guard against a future miswire, not a
 * user-facing case.
 */
export class HouseholdLeadMismatchError extends Error {
    constructor(public readonly householdId: number, public readonly personId: number) {
        super(`Person ${personId} is not a member of household ${householdId}.`);
        this.name = "HouseholdLeadMismatchError";
    }
}

/**
 * Thrown by {@link addHouseholdLead} when the promotion target is a youth. The UI
 * hides "Make Lead" for youth, but that's client-side only — this is the server
 * enforcement so a direct POST can't flag a youth as a household lead. A null/unknown
 * DOB is NOT a youth ({@link isYouth} returns false), matching the UI which shows the
 * control for null-DOB members.
 */
export class HouseholdLeadYouthError extends Error {
    constructor(public readonly householdId: number, public readonly personId: number) {
        super("A youth cannot be a household lead.");
        this.name = "HouseholdLeadYouthError";
    }
}

/**
 * The count-then-flag core, run inside a transaction. Takes a row lock on the
 * household first so concurrent promotions are serialized: a second caller
 * blocks on the lock, then sees the updated count and is rejected — closing the
 * check-then-act (TOCTOU) race that a bare count+update would leave open.
 *
 * Leadership is `Person.isHouseholdLead`: a person always
 * leads their OWN household ({@link Person.householdId}), so the cap counts
 * flagged members of `householdId`. Caller guarantees `householdId` is the
 * participant's household.
 */
async function addHouseholdLeadTx(
    tx: TxClient,
    householdId: number,
    participantId: number,
): Promise<{ created: boolean }> {
    // FOR UPDATE serializes lead additions for this household. Postgres' default
    // Read Committed isolation does NOT prevent two transactions from both
    // counting N and both flagging — the explicit lock is what does.
    await tx.$queryRaw`SELECT id FROM "Household" WHERE id = ${householdId} FOR UPDATE`;

    const person = await tx.person.findUnique({
        where: { id: participantId },
        select: { isHouseholdLead: true, householdId: true, dateOfBirth: true },
    });
    // Invariant: isHouseholdLead means "lead of their OWN household". Flagging a
    // person whose householdId != the counted/locked household would silently
    // flag them as lead of the wrong household and make the cap count
    // meaningless — reject instead.
    if (person && person.householdId !== householdId) {
        throw new HouseholdLeadMismatchError(householdId, participantId);
    }
    if (person?.isHouseholdLead) return { created: false };
    // Youth exclusion (server-side; UI also filters). null/unknown DOB is allowed.
    if (person && isYouth(person.dateOfBirth)) {
        throw new HouseholdLeadYouthError(householdId, participantId);
    }

    const count = await tx.person.count({ where: { ...householdLeadsWhere(householdId), ...LIVE_PERSON } });
    if (count >= MAX_HOUSEHOLD_LEADS) {
        throw new HouseholdLeadLimitError(householdId);
    }

    await tx.person.update({ where: { id: participantId }, data: { isHouseholdLead: true } });
    return { created: true };
}

/**
 * Add a household lead, enforcing the per-household cap (issue #269) atomically.
 *
 * Idempotent: if the participant is already a lead of the household this is a
 * no-op and does NOT count against the cap. Throws {@link HouseholdLeadLimitError}
 * when the household already has {@link MAX_HOUSEHOLD_LEADS} distinct leads.
 *
 * Pass the prisma singleton and the call runs in its own atomic transaction;
 * pass a transaction client (inside an existing `$transaction`) and the lock +
 * count + create join that transaction instead. Either way the cap check and the
 * insert are serialized against concurrent promotions for the same household.
 *
 * Does not write an audit log — callers own that, since the actor varies (and is
 * absent for system flows like sign-up).
 *
 * @returns `{ created: true }` if a lead row was inserted, `{ created: false }`
 *          if the participant was already a lead.
 */
export async function addHouseholdLead(
    db: DbClient,
    householdId: number,
    participantId: number,
): Promise<{ created: boolean }> {
    return withTx(db, (tx) => addHouseholdLeadTx(tx, householdId, participantId));
}

/** Result of a demote attempt. `not_lead`: wasn't a lead. `last_lead`: refused —
 *  removing them would leave the household with zero leads (a "broken" household). */
export type RemoveLeadResult =
    | { removed: true }
    | { removed: false; reason: "not_lead" | "last_lead" };

/**
 * The count-then-clear core, the demote mirror of {@link addHouseholdLeadTx}. Takes
 * the SAME Household row lock FIRST, so two concurrent demotes of a 2-lead household
 * serialize: the second blocks, then sees count === 1 and is refused — closing the
 * TOCTOU race where both read count === 2, both pass the last-lead guard, and both
 * clear, leaving the household with zero leads. Under Read Committed the lock is the
 * only thing that prevents this; a bare count+update does not.
 */
async function removeHouseholdLeadTx(
    tx: TxClient,
    householdId: number,
    participantId: number,
): Promise<RemoveLeadResult> {
    await tx.$queryRaw`SELECT id FROM "Household" WHERE id = ${householdId} FOR UPDATE`;

    const person = await tx.person.findUnique({
        where: { id: participantId },
        select: { isHouseholdLead: true, householdId: true },
    });
    if (person && person.householdId !== householdId) {
        throw new HouseholdLeadMismatchError(householdId, participantId);
    }
    if (!person?.isHouseholdLead) return { removed: false, reason: "not_lead" };

    const count = await tx.person.count({ where: { ...householdLeadsWhere(householdId), ...LIVE_PERSON } });
    if (count <= 1) return { removed: false, reason: "last_lead" };

    await tx.person.update({ where: { id: participantId }, data: { isHouseholdLead: false } });
    return { removed: true };
}

/**
 * Remove a household lead, refusing to drop the household's last lead, atomically.
 *
 * Pass the prisma singleton to run in its own transaction, or a tx client to join
 * an existing one. Either way the last-lead check and the clear are serialized
 * against concurrent demotes/promotes for the same household via the Household row
 * lock — see {@link removeHouseholdLeadTx}. Does not write an audit log — callers own that.
 */
export async function removeHouseholdLead(
    db: DbClient,
    householdId: number,
    participantId: number,
): Promise<RemoveLeadResult> {
    return withTx(db, (tx) => removeHouseholdLeadTx(tx, householdId, participantId));
}
