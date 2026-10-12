import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { IN_FLIGHT_INITIAL_STATUSES } from "@/lib/membership/phases";
import { getExternalStatus, advanceExternalIfComplete } from "@/lib/membership/external";
import { householdBgIsFresh, nextBoundary } from "@/lib/membership/renewal";
import { findOpenPersonAgreement } from "@/lib/membership/personAgreementTriggers";
import { applyVolunteerStatus } from "@/lib/membership/review";
import { addHouseholdLead, HouseholdLeadLimitError, MAX_HOUSEHOLD_LEADS } from "@/lib/household/leads";
import { upsertPrimaryContact, reconcileHouseholdConflicts } from "@/lib/emergencyContacts/service";
import { normalizeAddressInput, pickAddress, type StructuredAddress } from "@/lib/address";
import { INTAKE_PROFILES, missingRequiredFields } from "@/lib/intake/profiles";
import { normalizeAdultDob } from "@/lib/person/adultDob";
import { mintPersonId } from "@/lib/person/mintId";
import { nameWrite } from "@/lib/person/name";
import { withTx } from "@/lib/db-client";
import { isDesignatedEmail, designatedEmailRefusalForBoard } from "@/lib/membership/volunteerDesignation";

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
        public readonly code: "no_household" | "not_lead" | "already_member" | "no_process" | "incomplete" | "lead_limit" | "name_required" | "email_designated",
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
    section: "secondaryParent";
    code: "lead_limit" | "name_required";
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
                    householdMembers: { orderBy: { id: "asc" } },
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

    const canSeeNotes = leadIds.has(userId) || user.isSysadmin;
    const external = process ? await getExternalStatus(process) : null;

    // The caller's own individual agreement, if they have one open. Person-scoped,
    // so it never appears in membership.processes above (orgMembershipId is null) and is
    // independent of the household's own application state — an adult child in a settled
    // member household still has one to sign.
    const ownAgreement = await findOpenPersonAgreement(userId);

    return {
        hasHousehold: !!household,
        isLead: leadIds.has(userId),
        membershipStatus: membership?.status ?? null,
        process: process ? { id: process.id, kind: process.kind, status: process.status, isPaymentPlanRequested: process.isPaymentPlanRequested } : null,
        external,
        personAgreement: ownAgreement ? { id: ownAgreement.id, started: !!ownAgreement.zohoEnvelopeId } : null,
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
 * Begin (or resume) an INITIAL application for the caller's household. Ensures a
 * household exists, anchors a Membership (status NONE), and opens a
 * OrgMembershipProcess at INTAKE. Idempotent: an in-flight process is returned as-is.
 *
 * The caller's own read of `user.household.orgMembership.processes` (above) is stale
 * the instant it's read, so a double-click or two tabs can both pass it and both
 * reach the create. Mirrors renewal's createRenewalProcess: the check+create is
 * re-run inside a transaction holding a `SELECT ... FOR UPDATE` lock on the
 * Membership row, so a concurrent caller blocks until the winner commits, then
 * sees the winner's in-flight process instead of inserting a duplicate. The
 * partial unique index `membership_one_inflight_initial` is defense-in-depth.
 */
export async function startIntake(userId: number) {
    const user = await loadUserWithHousehold(userId);
    if (!user) throw new IntakeError("no_household", "User not found.");

    assertLead(user);
    const householdId = user.householdId!;

    if (user.household?.orgMembership?.status === "ACTIVE") {
        throw new IntakeError("already_member", "Your household is already an active member.");
    }

    const membership = await prisma.orgMembership.upsert({
        where: { householdId },
        create: { householdId, status: "NONE" },
        update: {},
    });

    try {
        return await prisma.$transaction(async (tx) => {
            // Lock the membership row so overlapping starts serialize here, not at the INSERT.
            await tx.$queryRaw`SELECT id FROM "OrgMembership" WHERE id = ${membership.id} FOR UPDATE`;
            const existing = await tx.orgMembershipProcess.findFirst({
                where: { orgMembershipId: membership.id, kind: "INITIAL", status: { in: IN_FLIGHT_INITIAL_STATUSES } },
                orderBy: { id: "desc" },
            });
            if (existing) return existing;

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

            return process;
        });
    } catch (e) {
        // The FOR UPDATE lock serializes same-version callers, but a rolling deploy can
        // leave a pre-fix instance (no lock) inserting concurrently — the partial unique
        // index membership_one_inflight_initial then rejects the duplicate with P2002.
        // Return the winner instead of surfacing a 500 to the applicant (mirrors renewal).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
            const winner = await prisma.orgMembershipProcess.findFirst({
                where: { orgMembershipId: membership.id, kind: "INITIAL", status: { in: IN_FLIGHT_INITIAL_STATUSES } },
                orderBy: { id: "desc" },
            });
            if (winner) return winner;
        }
        throw e;
    }
}

/** Persist intake form data onto the caller's household + participants. Resumable; never deletes. */
export async function saveIntake(userId: number, input: IntakeSaveInput) {
    const user = await loadUserWithHousehold(userId);
    if (!user) throw new IntakeError("no_household", "User not found.");
    assertLead(user);
    const householdId = user.householdId!;
    const householdMemberIds = new Set((user.household?.householdMembers ?? []).map((p) => p.id));

    // Checked before any write: the save is a sequence of autocommit statements.
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

    // Promote a guardian to household lead. The per-household cap (#269) is a
    // soft stop here, not a hard failure: the guardian's other details are still
    // saved (above), and the rest of the form (children) still saves below. We
    // collect the skipped promotion and hand it back so the form can say exactly
    // what happened, instead of failing the whole save with a single error.
    const rejections: IntakeRejection[] = [];
    const addLeadOrRecord = async (participantId: number) => {
        try {
            await addHouseholdLead(prisma, householdId, participantId);
        } catch (e) {
            if (e instanceof HouseholdLeadLimitError) {
                rejections.push({
                    section: "secondaryParent",
                    code: "lead_limit",
                    message: `We saved this person's details, but your household already lists the maximum of ${MAX_HOUSEHOLD_LEADS} parents/guardians, so they weren't added as a second guardian. Update or remove an existing parent/guardian to change that.`,
                });
                return;
            }
            throw e;
        }
    };

    if (input.household) {
        // Address + the optional "anything else we should know?" note share one
        // household.update. Note is trimmed to null so an empty box clears it.
        const householdData = {
            ...normalizeAddressInput(input.household),
            ...(input.household.notes !== undefined && { intakeNotes: input.household.notes?.trim() || null }),
        };
        if (Object.keys(householdData).length > 0) {
            await prisma.household.update({ where: { id: householdId }, data: householdData });
        }
        // Emergency contact lives in its own table now; the single-field intake
        // form maps onto the household's primary contact. Tolerant of partial
        // saves; rejects (direction A) a contact that is a household member.
        if (
            input.household.emergencyContactName !== undefined ||
            input.household.emergencyContactPhone !== undefined ||
            input.household.emergencyContactEmail !== undefined
        ) {
            await upsertPrimaryContact(prisma, householdId, {
                name: input.household.emergencyContactName,
                phone: input.household.emergencyContactPhone,
                email: input.household.emergencyContactEmail,
            });
        }
    }

    // Primary parent is always the caller.
    if (input.primaryParent) {
        // A submitted-but-blank name is rejected rather than silently dropped
        // (Decision 5) — this is the caller's own name, always required.
        if (input.primaryParent.name !== undefined && !nameWrite(input.primaryParent.name)) {
            throw new IntakeError("name_required", "Your name is required.", ["primaryName"]);
        }
        // The primary applicant is already a household lead (set at startIntake).
        await prisma.person.update({
            where: { id: userId },
            data: {
                ...(input.primaryParent.name !== undefined && { name: nameWrite(input.primaryParent.name) }),
                // #1165: a real sub-26 DoB is kept and supersedes the 25+ flag; a
                // 26+ DoB is stripped and forces the flag on; an empty DoB honors
                // the checkbox.
                ...(input.primaryParent.dob !== undefined && normalizeAdultDob(input.primaryParent.dob)),
                ...(input.primaryParent.over25 !== undefined && !input.primaryParent.dob && { isDeclaredAdult: !!input.primaryParent.over25 }),
                ...(input.primaryParent.allergies !== undefined && { allergies: input.primaryParent.allergies }),
            },
        });
    }

    // Secondary parent: update if it belongs to this household, else create.
    if (input.secondaryParent) {
        const sp = input.secondaryParent;
        let spName: string | undefined;
        if (sp.id && householdMemberIds.has(sp.id)) {
            // A submitted (non-null) but blank name is rejected, not silently
            // dropped (Decision 5) — same rule as the primary parent/children
            // updates. `null` stays a no-op (#1688's existing carve-out).
            if (sp.name !== undefined && sp.name !== null && !nameWrite(sp.name)) {
                throw new IntakeError("name_required", "A name is required for the second parent / guardian.", ["secondaryParent"]);
            }
            await prisma.person.update({
                where: { id: sp.id },
                data: {
                    ...(sp.name !== undefined && sp.name !== null && { name: nameWrite(sp.name) }),
                    ...(sp.dob !== undefined && normalizeAdultDob(sp.dob)),
                    ...(sp.over25 !== undefined && !sp.dob && { isDeclaredAdult: !!sp.over25 }),
                    ...(sp.allergies !== undefined && { allergies: sp.allergies }),
                },
            });
            // A second guardian is a household lead (parent).
            await addLeadOrRecord(sp.id);
        } else if ((spName = nameWrite(sp.name)) !== undefined) {
            const newSpName: string = spName;
            // saveIntake is a bare sequence of autocommit statements, so the mint
            // gets its own two-statement transaction — an id minted outside one
            // would be burned if the create failed. #1688's name_required
            // rejection is the sibling branch below, so a nameless (or
            // whitespace-only) second parent never opens a transaction at all.
            const created = await withTx(prisma, async (tx) =>
                tx.person.create({
                    data: {
                        id: await mintPersonId(tx),
                        householdId,
                        name: newSpName,
                        ...(sp.email && { email: sp.email.toLowerCase() }),
                        ...normalizeAdultDob(sp.dob),
                        ...(!sp.dob && { isDeclaredAdult: !!sp.over25 }),
                        allergies: sp.allergies ?? null,
                    },
                }),
            );
            await addLeadOrRecord(created.id);
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
        let childName: string | undefined;
        if (child.id && householdMemberIds.has(child.id)) {
            // Same rejection as the primary parent (Decision 5): an existing
            // child's name can't be blanked through an update.
            if (child.name !== undefined && !nameWrite(child.name)) {
                throw new IntakeError("name_required", "A name is required for each child.", ["children"]);
            }
            await prisma.person.update({
                where: { id: child.id },
                data: {
                    ...(child.name !== undefined && { name: nameWrite(child.name) }),
                    ...(child.dob !== undefined && normalizeAdultDob(child.dob)),
                    ...(child.allergies !== undefined && { allergies: child.allergies }),
                },
            });
        } else if ((childName = nameWrite(child.name)) !== undefined) {
            const newChildName: string = childName;
            await withTx(prisma, async (tx) =>
                tx.person.create({
                    data: {
                        id: await mintPersonId(tx),
                        householdId,
                        name: newChildName,
                        ...(child.email && { email: child.email.toLowerCase() }),
                        ...normalizeAdultDob(child.dob),
                        allergies: child.allergies ?? null,
                    },
                }),
            );
        }
    }

    // Members added in this save (children / second parent) may collide with an
    // existing emergency contact — re-evaluate and flag (direction B).
    await reconcileHouseholdConflicts(prisma, householdId);

    return { state: await getIntakeState(userId), rejections };
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
    // literals. Field keys + labels + order are unchanged from the hardcoded set.
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
    const bgFresh = await householdBgIsFresh(household.id, boundary, settings?.bgRecheckMonths ?? 0);

    const advanced = await prisma.orgMembershipProcess.update({
        where: { id: process.id },
        data: {
            status: "PENDING_EXTERNAL_ACTION",
            stageEnteredAt: new Date(),
            ...(bgFresh ? { bgClearedAt: new Date() } : {}),
        },
    });

    await prisma.auditLog.create({
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
    // the volunteer-designation allowlist here or it would never be applied (#874).
    if (bgFresh) await applyVolunteerStatus(prisma, process.orgMembershipId!, household.id, false);

    // The external actions (contract sign, BG consent) can already be satisfied the
    // moment we land at PENDING_EXTERNAL_ACTION: bgFresh stamps bgClearedAt above,
    // and the board can pre-mark contractSignedAt/bgConsentAt on the INTAKE row via
    // the ops API (#878). advanceExternalIfComplete didn't re-fire on those marks
    // (status wasn't PENDING_EXTERNAL_ACTION yet), so without this the process would
    // strand here with its gate already met. Re-run the advance now — it's a no-op
    // (status guard, contract/BG checks) when the actions aren't actually done.
    return (await advanceExternalIfComplete(process.id)) ?? advanced;
}
