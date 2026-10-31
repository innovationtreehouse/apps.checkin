import prisma from "@/lib/prisma";
import { logger, logBackendError } from "@/lib/logger";
import { personActor } from "@/lib/auditActor";
import { removeAliasesForSignInEmail } from "@/lib/person/mailAliases";
import { isPrismaError, uniqueViolationFields } from "@/lib/prismaUniqueViolation";
import { EMAIL_IN_USE_REFUSAL } from "@/lib/household/emailInUse";
import type { OrgMembershipProcess } from "@/generated/prisma/client";
import { IN_FLIGHT_INITIAL_STATUSES } from "@/lib/membership/phases";
import { getExternalStatus, advanceExternalIfComplete, getOwnBackgroundCheck } from "@/lib/membership/external";
import { householdBgIsFresh, nextBoundary, householdApplicationOpenOrBlockedWhere } from "@/lib/membership/renewal";
import { ensureHouseholdMembership, lockAndFindDeniedHousehold, raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";
import { fromWhere } from "@/lib/membership/lifecycle";
import { findOpenPersonAgreement } from "@/lib/membership/personAgreementTriggers";
import { applyVolunteerFamilyStatus } from "@/lib/membership/review";
import { addHouseholdLead, HouseholdLeadLimitError, HouseholdLeadDeniedError, HouseholdLeadYouthError, MAX_HOUSEHOLD_LEADS } from "@/lib/household/leads";
import { upsertPrimaryContact, reconcileHouseholdConflicts } from "@/lib/emergencyContacts/service";
import { normalizeAddressInput, pickAddress, type StructuredAddress } from "@/lib/address";
import { INTAKE_PROFILES, missingRequiredFields } from "@/lib/intake/profiles";
import { normalizeAdultDob } from "@/lib/person/adultDob";
import { isYouth } from "@/lib/time";
import { mintPersonId } from "@/lib/person/mintId";
import { nameWrite } from "@/lib/person/name";
import type { TxClient } from "@/lib/db-client";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { isDesignatedEmail, designatedEmailRefusalForBoard } from "@/lib/membership/volunteerDesignation";
import { LIVE_PERSON } from "@/lib/person/filters";
import { findSelfGrantRefusal, recordSelfGrantRefusal, type GrantSubject, type SelfGrantRefusal } from "@/lib/membership/selfGrantGuard";

/**
 * Membership intake service — the write/read model behind the "Join the
 * Treehouse" application flow. All mutations are scoped to the caller's own
 * household; callers must be a lead of that household (enforced here).
 *
 * Intake data lives in the real tables (Household + Participant), so the form
 * is naturally resumable: returning applicants are re-served their saved data.
 * A long-lived Membership (status NONE until paid) anchors the per-cycle
 * OrgMembershipProcess that tracks application progress.
 */

export class IntakeError extends Error {
    /**
     * @param fields  form field keys this error applies to, so the client can
     *                highlight the offending inputs (e.g. an `incomplete` submit).
     *                Keys match the intake form: "address", "emergencyContact",
     *                "primaryName".
     */
    constructor(
        public readonly code: "no_household" | "not_lead" | "already_member" | "denied" | "blocked" | "renewal_open" | "no_process" | "incomplete" | "lead_limit" | "name_required" | "email_designated" | "email_in_use",
        message: string,
        public readonly fields?: string[],
    ) {
        super(message);
        this.name = "IntakeError";
    }
}

/**
 * A non-fatal thing the save couldn't do, reported back to the form so it can
 * tell the applicant exactly what did and didn't happen. The rest of the save
 * still goes through — partial saves are fine as long as they're transparent.
 */
export type IntakeRejection = {
    section: "primaryParent" | "secondaryParent";
    code: "lead_limit" | "name_required" | "household_denied" | "not_lead" | "youth";
    message: string;
};

type ParentInput = { id?: number; name?: string; email?: string; dob?: string | null; over25?: boolean; allergies?: string | null };
type ChildInput = { id?: number; name?: string; email?: string | null; dob?: string | null; allergies?: string | null };

export interface IntakeSaveInput {
    household?: Partial<StructuredAddress> & { emergencyContactName?: string; emergencyContactPhone?: string; emergencyContactEmail?: string; notes?: string | null };
    primaryParent?: ParentInput;
    secondaryParent?: ParentInput | null;
    children?: ChildInput[];
}

async function loadUserWithHousehold(userId: number) {
    return prisma.person.findUnique({
        where: { id: userId },
        include: {
            household: {
                include: {
                    householdMembers: { where: LIVE_PERSON, orderBy: { id: "asc" } },
                    orgMembership: { include: { processes: true } },
                    emergencyContacts: { orderBy: [{ priority: "asc" }, { id: "asc" }] },
                },
            },
        },
    });
}

function assertLead(user: NonNullable<Awaited<ReturnType<typeof loadUserWithHousehold>>>) {
    if (!user.isHouseholdLead && !user.isSysadmin) throw new IntakeError("not_lead", "Only a household lead can manage the membership application.");
}

/** Read the caller's current membership/application state, prefilled for the form. */
export async function getIntakeState(userId: number) {
    const user = await loadUserWithHousehold(userId);
    if (!user) throw new IntakeError("no_household", "User not found.");

    const household = user.household;
    const membership = household?.orgMembership ?? null;
    // The current in-flight process of any kind (INITIAL or RENEWAL) — anything
    // not in a terminal status. During renewal the membership stays ACTIVE while
    // its RENEWAL process cycles, so we surface that here rather than the "you're
    // a member" card. ARCHIVED (board-disposed) is terminal like ACTIVE, so a
    // returning applicant sees a clean slate rather than resuming a ghost.
    const process = membership?.processes
        .filter((p) => p.status !== "ACTIVE" && p.status !== "ARCHIVED")
        .sort((a, b) => b.id - a.id)[0] ?? null;

    // Parents/guardians are the household leads; children are non-lead members.
    const members = household?.householdMembers ?? [];
    const leadIds = new Set(members.filter((p) => p.isHouseholdLead).map((p) => p.id));
    const parents = members.filter((p) => p.isHouseholdLead);
    const children = members.filter((p) => !p.isHouseholdLead);
    const primary = parents.find((p) => p.id === userId) ?? null;
    const secondary = parents.find((p) => p.id !== userId) ?? null;

    const shape = (p: { id: number; name: string | null; email: string | null; dateOfBirth: Date | null; isDeclaredAdult: boolean; allergies: string | null }) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        dob: p.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : null,
        over25: !p.dateOfBirth && !!p.isDeclaredAdult,
        allergies: p.allergies,
    });

    const canSeeNotes = leadIds.has(userId);
    const external = process ? await getExternalStatus(process) : null;

    // The caller's own individual agreement, if they have one open. Person-scoped,
    // so it never appears in membership.processes above (orgMembershipId is null) and is
    // independent of the household's own application state — an adult child in a settled
    // member household still has one to sign.
    const ownAgreement = await findOpenPersonAgreement(userId);
    const ownBackgroundCheck = await getOwnBackgroundCheck(user);

    return {
        hasHousehold: !!household,
        isLead: leadIds.has(userId),
        membershipStatus: membership?.status ?? null,
        process: process ? { id: process.id, kind: process.kind, status: process.status, isPaymentPlanRequested: process.isPaymentPlanRequested } : null,
        external,
        personAgreement: ownAgreement ? { id: ownAgreement.id, started: !!ownAgreement.zohoEnvelopeId } : null,
        ownBackgroundCheck,
        prefill: {
            household: household
                ? {
                      name: household.name,
                      // intakeNotes is the lead's free-text note TO the board
                      // (pii); household peers — including youth with their own
                      // logins — must not read it. Same lead gate as
                      // GET /api/household, and only a lead can write it back.
                      notes: canSeeNotes ? household.intakeNotes : null,
                      ...pickAddress(household),
                      // The primary (lowest-priority) contact backs the single-field
                      // form. Shown even when flagged invalid so the lead can fix it.
                      emergencyContactName: household.emergencyContacts[0]?.name ?? null,
                      emergencyContactPhone: household.emergencyContacts[0]?.phone ?? null,
                      emergencyContactEmail: household.emergencyContacts[0]?.email ?? null,
                  }
                : null,
            primaryParent: primary ? shape(primary) : null,
            secondaryParent: secondary ? shape(secondary) : null,
            children: children.map(shape),
        },
    };
}

/**
 * Begin (or resume) an INITIAL application for the caller's household. Anchors a
 * Membership (∅→NONE via ensureHouseholdMembership) and opens an
 * OrgMembershipProcess at INTAKE. Idempotent: an in-flight INITIAL is returned as-is.
 *
 * Refused when the household is DENIED (raised to the board), ACTIVE (renewals
 * only), has a BLOCKED application (only the board moves it on), or has an open
 * renewal (one open household application at a time; a REVOKED household
 * continues that renewal instead).
 *
 * Every check runs inside a transaction holding a `SELECT ... FOR UPDATE` lock on
 * the Membership row, so overlapping starts, renewal opens and status changes
 * serialize here. The partial unique index `membership_one_inflight_initial` is
 * defense-in-depth.
 */
export async function startIntake(userId: number) {
    const user = await loadUserWithHousehold(userId);
    if (!user) throw new IntakeError("no_household", "User not found.");

    assertLead(user);
    const householdId = user.householdId!;

    const membership = await ensureHouseholdMembership(prisma, householdId);

    try {
        const outcome = await prisma.$transaction(async (tx): Promise<{ process: OrgMembershipProcess } | { refuse: StartRefusal }> => {
            const [locked] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "OrgMembership" WHERE id = ${membership.id} FOR UPDATE`;
            if (locked?.status === "DENIED") return { refuse: "denied" };
            if (locked?.status === "ACTIVE") return { refuse: "already_member" };

            const open = await tx.orgMembershipProcess.findMany({
                where: { orgMembershipId: membership.id, ...householdApplicationOpenOrBlockedWhere },
                orderBy: { id: "desc" },
            });
            if (open.some((p) => p.status === "BLOCKED")) return { refuse: "blocked" };
            const existing = open.find((p) => p.kind === "INITIAL");
            if (existing) return { process: existing };
            if (open.length > 0) return { refuse: "renewal_open" };

            const process = await tx.orgMembershipProcess.create({
                data: { orgMembershipId: membership.id, kind: "INITIAL", status: "INTAKE" },
            });

            await tx.auditLog.create({
                data: {
                    actorId: userId,
                    action: "CREATE",
                    tableName: "OrgMembershipProcess",
                    affectedEntityId: process.id,
                    newData: { orgMembershipId: membership.id, kind: "INITIAL", status: "INTAKE" },
                },
            });

            return { process };
        });
        if ("process" in outcome) return outcome.process;
        throw await startRefusal(outcome.refuse, householdId, userId);
    } catch (e) {
        // An insert that didn't take this lock can race it — the
        // partial unique index then rejects the duplicate with P2002. Return the winner.
        if (isPrismaError(e, "P2002")) {
            const winner = await prisma.orgMembershipProcess.findFirst({
                where: { orgMembershipId: membership.id, kind: "INITIAL", status: { in: IN_FLIGHT_INITIAL_STATUSES } },
                orderBy: { id: "desc" },
            });
            if (winner) return winner;
        }
        throw e;
    }
}

type StartRefusal = "denied" | "already_member" | "blocked" | "renewal_open";

async function startRefusal(code: StartRefusal, householdId: number, userId: number) {
    switch (code) {
        case "denied":
            await raiseDeniedHouseholdActivity({ householdId, personId: userId, what: "startIntake refused" });
            return new IntakeError("denied", "Your household can't start a membership application. Please contact the board.");
        case "already_member":
            return new IntakeError("already_member", "Your household is already an active member.");
        case "blocked":
            return new IntakeError("blocked", "Your household's application is with the board. Please contact the board.");
        case "renewal_open":
            return new IntakeError("renewal_open", "Your household has a renewal open. Continue the renewal instead.");
    }
}

/**
 * Persist intake form data onto the caller's household + participants, all or
 * nothing: a thrown error means nothing was saved. Resumable; never deletes.
 * `state` is null when the save committed but re-reading the form's state failed.
 */
export async function saveIntake(userId: number, input: IntakeSaveInput) {
    const user = await loadUserWithHousehold(userId);
    if (!user) throw new IntakeError("no_household", "User not found.");
    assertLead(user);
    const householdId = user.householdId!;
    const householdMemberIds = new Set((user.household?.householdMembers ?? []).map((p) => p.id));

    // Only a newly created person takes an email here.
    const isNew = (p: { id?: number }) => !(p.id && householdMemberIds.has(p.id));
    const newPeople = [
        ...(input.secondaryParent && isNew(input.secondaryParent) ? [{ email: input.secondaryParent.email, field: "secondaryParent" }] : []),
        ...(input.children ?? []).filter(isNew).map((c) => ({ email: c.email, field: "children" })),
    ];
    for (const { email, field } of newPeople) {
        if (email && await isDesignatedEmail(prisma, email)) {
            throw new IntakeError("email_designated", await designatedEmailRefusalForBoard(), [field]);
        }
    }

    // Promote a guardian to household lead. The per-household cap is a
    // soft stop here, not a hard failure: the guardian's other details are still
    // saved (above), and the rest of the form (children) still saves below. We
    // collect the skipped promotion and hand it back so the form can say exactly
    // what happened, instead of failing the whole save with a single error.
    const rejections: IntakeRejection[] = [];
    const refusals: SelfGrantRefusal[] = [];
    const deniedPromotions: HouseholdLeadDeniedError[] = [];
    // A youth's own record is read-only, under whichever section of the form names it.
    const isYouthSelfEdit = (personId: number | undefined) => {
        if (personId !== userId || !isYouth(user.dateOfBirth)) return false;
        rejections.push({
            section: "primaryParent",
            code: "youth",
            message: "We saved the rest of the form, but someone under 18 can't change their own details, so yours were left as they were.",
        });
        return true;
    };
    const addLeadOrRecord = async (tx: TxClient, participantId: number, refusalSubject: GrantSubject) => {
        // A sysadmin manages their household's intake without leading it, so making
        // someone its lead that way is a grant to their own household.
        const alreadyLead = (user.household?.householdMembers ?? []).some((p) => p.id === participantId && p.isHouseholdLead);
        const refusal = !user.isHouseholdLead && !alreadyLead ? await findSelfGrantRefusal(tx, userId, refusalSubject, {
            table: "Person",
            attempted: { isHouseholdLead: true },
        }) : null;
        if (refusal) {
            refusals.push(refusal);
            rejections.push({
                section: "secondaryParent",
                code: "not_lead",
                message: "We saved this person's details, but only a lead of this household can add them as a parent/guardian.",
            });
            return;
        }
        try {
            await addHouseholdLead(tx, householdId, participantId);
        } catch (e) {
            if (e instanceof HouseholdLeadLimitError) {
                rejections.push({
                    section: "secondaryParent",
                    code: "lead_limit",
                    message: `We saved this person's details, but your household already lists the maximum of ${MAX_HOUSEHOLD_LEADS} parents/guardians, so they weren't added as a second guardian. Update or remove an existing parent/guardian to change that.`,
                });
                return;
            }
            if (e instanceof HouseholdLeadDeniedError) {
                deniedPromotions.push(e);
                rejections.push({ section: "secondaryParent", code: "household_denied", message: `We saved this person's details, but ${e.message.charAt(0).toLowerCase()}${e.message.slice(1)}` });
                return;
            }
            if (e instanceof HouseholdLeadYouthError) {
                rejections.push({
                    section: "secondaryParent",
                    code: "youth",
                    message: "We saved this person's details, but someone under 18 can't be a parent/guardian on the household, so they were added as a household member instead.",
                });
                return;
            }
            throw e;
        }
    };

    try {
        await prisma.$transaction(async (tx) => {
            // Lead promotion locks OrgMembership then Household, the order every
            // writer takes them in; the household update below would invert it.
            await lockAndFindDeniedHousehold(tx, [householdId]);

            if (input.household) {
                // Address + the optional "anything else we should know?" note share one
                // household.update. Note is trimmed to null so an empty box clears it.
                const householdData = {
                    ...normalizeAddressInput(input.household),
                    ...(input.household.notes !== undefined && { intakeNotes: input.household.notes?.trim() || null }),
                };
                if (Object.keys(householdData).length > 0) {
                    await tx.household.update({ where: { id: householdId }, data: householdData });
                }
                // Emergency contact lives in its own table; the single-field intake
                // form maps onto the household's primary contact. Tolerant of partial
                // saves; rejects a contact that is a household member.
                if (
                    input.household.emergencyContactName !== undefined ||
                    input.household.emergencyContactPhone !== undefined ||
                    input.household.emergencyContactEmail !== undefined
                ) {
                    await upsertPrimaryContact(tx, householdId, {
                        name: input.household.emergencyContactName,
                        phone: input.household.emergencyContactPhone,
                        email: input.household.emergencyContactEmail,
                    });
                }
            }

            // Primary parent is always the caller.
            if (input.primaryParent && !isYouthSelfEdit(userId)) {
                // A submitted-but-blank name is rejected rather than silently dropped
                // — this is the caller's own name, always required.
                if (input.primaryParent.name !== undefined && !nameWrite(input.primaryParent.name)) {
                    throw new IntakeError("name_required", "Your name is required.", ["primaryName"]);
                }
                // The primary applicant is already a household lead (set at startIntake).
                await tx.person.update({
                    where: { id: userId },
                    data: {
                        ...(input.primaryParent.name !== undefined && { name: nameWrite(input.primaryParent.name) }),
                        ...normalizeAdultDob(input.primaryParent.dob, input.primaryParent.over25, user.dateOfBirth),
                        ...(input.primaryParent.allergies !== undefined && { allergies: input.primaryParent.allergies }),
                    },
                });
            }

            // Secondary parent: update if it belongs to this household, else create.
            if (input.secondaryParent && !isYouthSelfEdit(input.secondaryParent.id)) {
                const sp = input.secondaryParent;
                let spName: string | undefined;
                if (sp.id && householdMemberIds.has(sp.id)) {
                    // A submitted (non-null) but blank name is rejected, not silently
                    // dropped — same rule as the primary parent/children
                    // updates. `null` stays a no-op.
                    if (sp.name !== undefined && sp.name !== null && !nameWrite(sp.name)) {
                        throw new IntakeError("name_required", "A name is required for the second parent / guardian.", ["secondaryParent"]);
                    }
                    await tx.person.update({
                        where: { id: sp.id },
                        data: {
                            ...(sp.name !== undefined && sp.name !== null && { name: nameWrite(sp.name) }),
                            ...normalizeAdultDob(sp.dob, sp.over25, user.household?.householdMembers.find((p) => p.id === sp.id)?.dateOfBirth),
                            ...(sp.allergies !== undefined && { allergies: sp.allergies }),
                        },
                    });
                    // A second guardian is a household lead (parent).
                    await addLeadOrRecord(tx, sp.id, { personId: sp.id, householdId });
                } else if ((spName = nameWrite(sp.name)) !== undefined) {
                    const newSpName: string = spName;
                    if (sp.email) await removeAliasesForSignInEmail(tx, sp.email, personActor(userId), "intake_add_member");
                    const created = await tx.person.create({
                        data: {
                            id: await mintPersonId(tx),
                            householdId,
                            name: newSpName,
                            ...(sp.email && { email: sp.email.toLowerCase() }),
                            ...normalizeAdultDob(sp.dob, sp.over25),
                            allergies: sp.allergies ?? null,
                        },
                    });
                    // A rollback returns this id for reuse, so the refusal row names the household.
                    await addLeadOrRecord(tx, created.id, { householdId });
                } else if (sp.email) {
                    rejections.push({
                        section: "secondaryParent",
                        code: "name_required",
                        message: "A name is required for the second parent / guardian.",
                    });
                }
            }

            // Children are non-lead household members. Update existing (own household
            // only), create the rest. Never delete; never add a HouseholdLead row.
            for (const child of input.children ?? []) {
                if (isYouthSelfEdit(child.id)) continue;
                let childName: string | undefined;
                if (child.id && householdMemberIds.has(child.id)) {
                    // Same rejection as the primary parent: an existing
                    // child's name can't be blanked through an update.
                    if (child.name !== undefined && !nameWrite(child.name)) {
                        throw new IntakeError("name_required", "A name is required for each child.", ["children"]);
                    }
                    await tx.person.update({
                        where: { id: child.id },
                        data: {
                            ...(child.name !== undefined && { name: nameWrite(child.name) }),
                            ...normalizeAdultDob(child.dob),
                            ...(child.allergies !== undefined && { allergies: child.allergies }),
                        },
                    });
                } else if ((childName = nameWrite(child.name)) !== undefined) {
                    const newChildName: string = childName;
                    if (child.email) await removeAliasesForSignInEmail(tx, child.email, personActor(userId), "intake_add_member");
                    await tx.person.create({
                        data: {
                            id: await mintPersonId(tx),
                            householdId,
                            name: newChildName,
                            ...(child.email && { email: child.email.toLowerCase() }),
                            ...normalizeAdultDob(child.dob),
                            allergies: child.allergies ?? null,
                        },
                    });
                }
            }

            // Members added in this save (children / second parent) may collide with an
            // existing emergency contact — re-evaluate and flag (direction B).
            await reconcileHouseholdConflicts(tx, householdId);
        }, { maxWait: 5_000, timeout: 15_000 });
    } catch (e) {
        // Which new person collided stays unsaid: every one given an email is marked.
        if (uniqueViolationFields(e)?.includes("email")) {
            const fields = [...new Set(newPeople.filter((p) => p.email).map((p) => p.field))];
            throw new IntakeError("email_in_use", EMAIL_IN_USE_REFUSAL, fields);
        }
        throw e;
    } finally {
        // A refused attempt stays on record even when the save rolls back.
        for (const refusal of refusals) await afterSaveSettled("self-grant refusal", refusal, () => recordSelfGrantRefusal(prisma, refusal));
    }

    invalidateAttendanceCache();
    // These write through the root client, so they wait for the commit: a person
    // created above isn't visible to another connection until then.
    for (const e of deniedPromotions) {
        const ref = { householdId: e.householdId, personId: e.personId, what: "intake lead promotion refused" };
        await afterSaveSettled("denied household raise", ref, () => raiseDeniedHouseholdActivity(ref));
    }

    return { state: await afterSaveSettled("state read", { userId }, () => getIntakeState(userId)), rejections };
}

/**
 * Runs a step whose failure must not change what saveIntake reports: the save's
 * outcome is already settled. Logs to the console too, because the error log's
 * own write loses `context` when the database is down.
 */
async function afterSaveSettled<T>(step: string, context: object, run: () => Promise<T>): Promise<T | null> {
    try {
        return await run();
    } catch (error) {
        logger.error(`saveIntake ${step} failed:`, context, error);
        await logBackendError(error, `saveIntake ${step}`, context);
        return null;
    }
}

/**
 * Submit a completed intake: validate the minimum required data and advance the
 * in-flight INITIAL process from INTAKE to EXTERNAL (contract + BG consent).
 */
export async function submitIntake(userId: number) {
    const user = await loadUserWithHousehold(userId);
    if (!user) throw new IntakeError("no_household", "User not found.");
    assertLead(user);

    const household = user.household!;
    const process = household.orgMembership?.processes
        .filter((p) => p.kind === "INITIAL" && p.status === "INTAKE")
        .sort((a, b) => b.id - a.id)[0];
    if (!process) throw new IntakeError("no_process", "No application is awaiting your information.");

    // Required-field validation is driven by the membership-initial profile (one
    // declarative source of truth shared across intake surfaces), not inline
    // literals.
    const primary = household.householdMembers.find((p) => p.id === userId);
    const missing = missingRequiredFields(INTAKE_PROFILES["membership-initial"], {
        addressLine1: household.line1,
        addressCity: household.city,
        addressState: household.state,
        addressPostalCode: household.postalCode,
        emergencyContacts: household.emergencyContacts,
        primaryName: primary?.name,
    });
    if (missing.length) {
        throw new IntakeError(
            "incomplete",
            `Please complete: ${missing.map((m) => m.label).join(", ")}.`,
            missing.map((m) => m.field),
        );
    }

    // If a household guardian already holds a still-valid background check (same
    // rule as renewals), auto-clear the BG requirement now — the applicant won't
    // need to consent to or wait on a new check, just sign + pay.
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    const boundary = settings?.orgMembershipYearBoundary ? nextBoundary(settings.orgMembershipYearBoundary, new Date()) : null;
    const bgFresh = await householdBgIsFresh(household.id, boundary, settings?.bgRecheckMonths);

    await prisma.$transaction(async (tx) => {
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: process.id, ...fromWhere("INTAKE") },
            data: {
                status: "PENDING_EXTERNAL_ACTION",
                stageEnteredAt: new Date(),
                ...(bgFresh ? { bgClearedAt: new Date() } : {}),
            },
        });
        if (count !== 1) throw new IntakeError("no_process", "No application is awaiting your information.");

        await tx.auditLog.create({
            data: {
                actorId: userId,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: process.id,
                oldData: { status: "INTAKE" },
                newData: { status: "PENDING_EXTERNAL_ACTION", ...(bgFresh ? { bgClearedAt: true } : {}) },
            },
        });

        // Fresh-check shortcut ⇒ clearBackgroundCheck never runs this cycle, so match
        // the volunteer-designation allowlist here or it would never be applied.
        if (bgFresh) await applyVolunteerFamilyStatus(tx, process.orgMembershipId!, household.id, false);
    });

    // The external actions (contract sign, BG consent) can already be satisfied the
    // moment we land at PENDING_EXTERNAL_ACTION: bgFresh stamps bgClearedAt above,
    // and the board can pre-mark contractSignedAt/bgConsentAt on the INTAKE row via
    // the ops API. advanceExternalIfComplete doesn't fire on those marks
    // (status isn't PENDING_EXTERNAL_ACTION yet), so without this the process would
    // strand here with its gate already met. Re-run the advance now — it's a no-op
    // (status guard, contract/BG checks) when the actions aren't actually done.
    return (await advanceExternalIfComplete(process.id)) ?? prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: process.id } });
}
