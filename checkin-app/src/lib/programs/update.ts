import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { maybeAnnounceOnOpen } from "@/lib/programAnnounce";
import { adjustProgramInventory, setProgramInventory, STOCK_BOOKKEEPING_RESET, syncProgramPrice } from "@/lib/shopify/stock";
import { dollarsToCentsOrNull } from "@checkin/money";
import { LIVE_PERSON, ENROLLED_PARTICIPANT } from "@/lib/person/filters";
import { validateProgramAgeBounds, isLeaderAgeEligible, checkProgramAge } from "@/lib/programAge";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { emailBoardMembers } from "@/lib/emailRecipients";
import { config } from "@/lib/config";
import { escapeHtml } from "@/lib/email-templates/base";
import { parseDateOnly } from "@/lib/time";
import { isSaleEnded, saleStockDelta } from "@/lib/programs/saleState";
import { countStockTakenSeats } from "@/lib/program/capacity";
import { membershipYearLabel, programYearsTouched } from "@/lib/programYear";
import { ProgramPhase, EnrollmentStatus, type Program } from "@/generated/prisma/client";

export interface ProgramEditor {
    id: number;
    isSysadmin: boolean;
    isBoardMember: boolean;
}

/** The PATCH body as the edit form sends it; every field is optional. */
export interface ProgramPatch {
    name?: string;
    leadMentorId?: unknown;
    startAt?: unknown;
    endAt?: unknown;
    appliesToYear?: unknown;
    offSaleAt?: unknown;
    orgMemberOnly?: boolean;
    publiclyVisible?: unknown;
    announceOnOpen?: unknown;
    phase?: ProgramPhase;
    enrollmentStatus?: EnrollmentStatus;
    minAge?: number | null;
    maxAge?: number | null;
    maxParticipants?: unknown;
    leadMentorNotificationSettings?: unknown;
    memberPrice?: unknown;
    nonMemberPrice?: unknown;
    shopifyProductId?: string | null;
    shopifyVariantId?: string | null;
}

export type ProgramRefusal = "invalid" | "forbidden" | "not_found" | "conflict";

export type ProgramEditAccess =
    | { ok: true; program: Program }
    | { ok: false; refusal: ProgramRefusal; message: string };

export type ProgramUpdateResult =
    | {
        ok: true;
        program: Program;
        /** A Shopify stock or price sync that did not land; the save stands. */
        warning?: string;
        /** The sale reopened but the public product stays hidden. */
        notice?: string;
    }
    | { ok: false; refusal: ProgramRefusal; message: string };

const refuse = (refusal: ProgramRefusal, message: string) => ({ ok: false as const, refusal, message });

export type ProgramYearResult =
    | { ok: true; appliesToYear: number }
    | { ok: false; refusal: ProgramRefusal; message: string };

/**
 * The membership year a program with these dates runs in. Derived when the
 * dates fall inside one year; otherwise the supplied year, or a still-valid
 * stated one, must be one the dates touch. A current year counts as stated only
 * when the current dates already crossed; a derived year is never carried into
 * a crossing. Only a Board member supplies or changes a stated year, because it
 * is copied from the Board's budget approval.
 */
export async function resolveProgramYear(input: {
    startAt: Date;
    endAt: Date;
    supplied: unknown;
    current: { appliesToYear: number; startAt: Date; endAt: Date } | null;
    isBoardMember: boolean;
}): Promise<ProgramYearResult> {
    const { startAt, endAt, supplied, current, isBoardMember } = input;
    if (supplied != null && !Number.isInteger(supplied)) {
        return refuse("invalid", "appliesToYear must be a whole year");
    }
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    const boundary = settings?.orgMembershipYearBoundary;
    if (!boundary) {
        return refuse("invalid", "Set the membership year boundary in Board settings before creating or re-dating a program.");
    }
    const years = programYearsTouched(boundary, startAt, endAt);
    if (years.length === 1) return { ok: true, appliesToYear: years[0] };

    const askTheBoard = refuse("forbidden", "These dates cross the membership year boundary, so the program's membership year comes from its budget approval. Ask the Board to set it.");
    const keptYear = current && years.includes(current.appliesToYear)
        && programYearsTouched(boundary, current.startAt, current.endAt).length > 1 ? current.appliesToYear : null;
    const stated = supplied as number | null | undefined;
    if (stated != null && stated !== keptYear) {
        if (!isBoardMember) return askTheBoard;
        if (!years.includes(stated)) {
            return refuse("invalid", `The membership year must be one these dates touch: ${years.map(membershipYearLabel).join(" or ")}.`);
        }
        return { ok: true, appliesToYear: stated };
    }
    if (keptYear != null) return { ok: true, appliesToYear: keptYear };
    if (!isBoardMember) return askTheBoard;
    return refuse("invalid", `These dates cross the membership year boundary. Choose the membership year from the budget approval: ${years.map(membershipYearLabel).join(" or ")}.`);
}

/** Only the program's lead mentor, a sysadmin or a board member edits it. */
export async function authorizeProgramEdit(programId: number, actor: ProgramEditor): Promise<ProgramEditAccess> {
    const program = await prisma.program.findUnique({ where: { id: programId } });
    if (!program) return refuse("not_found", "Program not found");

    const isLeadMentor = program.leadMentorId === actor.id;
    const isSysAdminOrBoard = actor.isSysadmin || actor.isBoardMember;
    if (!isLeadMentor && !isSysAdminOrBoard) {
        return refuse("forbidden", "Forbidden: Only Admin, Board Members, or Lead Mentors can edit");
    }
    return { ok: true, program };
}

/**
 * Apply an edit to a program the actor may edit (see authorizeProgramEdit),
 * then propagate it: audit row, age re-check board email, announce-on-open,
 * Shopify stock and price.
 */
export async function updateProgram(currentProgram: Program, patch: ProgramPatch, actor: ProgramEditor): Promise<ProgramUpdateResult> {
    const programId = currentProgram.id;
    const isSysAdminOrBoard = actor.isSysadmin || actor.isBoardMember;

    const { name, startAt, endAt, orgMemberOnly, publiclyVisible, announceOnOpen, phase, enrollmentStatus, minAge, maxAge, maxParticipants, leadMentorNotificationSettings, memberPrice, nonMemberPrice, shopifyProductId, shopifyVariantId } = patch;
    let leadMentorId: number | undefined;

    if (announceOnOpen !== undefined && typeof announceOnOpen !== "boolean") {
        return refuse("invalid", "announceOnOpen must be a boolean");
    }
    if (publiclyVisible !== undefined && typeof publiclyVisible !== "boolean") {
        return refuse("invalid", "publiclyVisible must be a boolean");
    }
    if (phase !== undefined && !Object.values(ProgramPhase).includes(phase)) {
        return refuse("invalid", "Invalid phase");
    }
    if (enrollmentStatus !== undefined && !Object.values(EnrollmentStatus).includes(enrollmentStatus)) {
        return refuse("invalid", "Invalid enrollmentStatus");
    }

    // Age range sanity — effective values (body overrides current) so a
    // one-sided edit can't leave minAge > maxAge.
    const effMinAge = minAge !== undefined ? minAge : currentProgram.minAge;
    const effMaxAge = maxAge !== undefined ? maxAge : currentProgram.maxAge;
    const ageErr = validateProgramAgeBounds(effMinAge, effMaxAge);
    if (ageErr) {
        return refuse("invalid", ageErr);
    }

    // maxParticipants: null = uncapped (allowed). Otherwise must be a
    // positive int and not below current enrollment.
    if (maxParticipants !== undefined && maxParticipants !== null) {
        if (typeof maxParticipants !== "number" || !Number.isInteger(maxParticipants) || maxParticipants <= 0) {
            return refuse("invalid", "maxParticipants must be a positive integer");
        }
        const enrolled = await prisma.programParticipant.count({ where: { programId, person: LIVE_PERSON, ...ENROLLED_PARTICIPANT } });
        if (maxParticipants < enrolled) {
            return refuse("invalid", `maxParticipants cannot be set below the current enrollment of ${enrolled}`);
        }
    }

    if (patch.hasOwnProperty('leadMentorId')) {
        if (!patch.leadMentorId) {
            return refuse("invalid", "Lead Mentor is required");
        }
        leadMentorId = parseInt(String(patch.leadMentorId));
        if (isNaN(leadMentorId)) {
            return refuse("invalid", "Invalid lead mentor");
        }
        if (!isSysAdminOrBoard && leadMentorId !== currentProgram.leadMentorId) {
            return refuse("forbidden", "Forbidden: Only administrators can reassign lead mentors");
        }
        const mentor = await prisma.person.findUnique({
            where: { id: leadMentorId },
            select: { dateOfBirth: true, isDeclaredAdult: true, householdId: true },
        });
        if (!mentor) {
            return refuse("invalid", "Lead mentor not found");
        }
        if (!isLeaderAgeEligible(mentor)) {
            return refuse("invalid", "Lead mentor must be at least 23 years old");
        }
        // Nobody names themself or their household as a program's leader (Ethics
        // Policy III.5). The edit form resends the current lead on every save, so
        // only a change is refused.
        if (leadMentorId !== currentProgram.leadMentorId && (
            leadMentorId === actor.id || await hasHouseholdConflict(prisma, actor.id, mentor.householdId)
        )) {
            return refuse("forbidden", "Forbidden: You cannot make yourself or a member of your household a program lead");
        }
    }

    // Publish guards: transitioning to UPCOMING requires a lead mentor and
    // at least one scheduled event. Re-publishing a RUNNING or FINISHED
    // program is rejected — prevents silently resurrecting a terminal program.
    if (phase === 'UPCOMING' && currentProgram.phase !== 'UPCOMING') {
        if (currentProgram.phase === 'RUNNING' || currentProgram.phase === 'FINISHED') {
            return refuse("conflict", `Cannot publish a program that is already ${currentProgram.phase.toLowerCase()}.`);
        }
        const effLeadMentorId = leadMentorId !== undefined ? leadMentorId : currentProgram.leadMentorId;
        if (!effLeadMentorId) {
            return refuse("invalid", "Cannot publish a program without a Lead Mentor assigned");
        }
        const eventCount = await prisma.event.count({ where: { programId } });
        if (eventCount === 0) {
            return refuse("invalid", "Cannot publish a program without any scheduled events");
        }
    }

    if (startAt !== undefined && !startAt) {
        return refuse("invalid", "Start date is required");
    }
    if (endAt !== undefined && !endAt) {
        return refuse("invalid", "End date is required");
    }
    const newStartAt = typeof startAt === "string" ? parseDateOnly(startAt) : undefined;
    const newEndAt = typeof endAt === "string" ? parseDateOnly(endAt) : undefined;
    if ((startAt !== undefined && typeof startAt !== "string") || (newStartAt && isNaN(newStartAt.getTime()))) {
        return refuse("invalid", "Invalid start date");
    }
    if ((endAt !== undefined && typeof endAt !== "string") || (newEndAt && isNaN(newEndAt.getTime()))) {
        return refuse("invalid", "Invalid end date");
    }
    // Effective values (body overrides current) so a one-sided edit can't invert the range.
    const effStartAt = newStartAt ?? currentProgram.startAt;
    const effEndAt = newEndAt ?? currentProgram.endAt;
    if (effStartAt > effEndAt) {
        return refuse("invalid", "Start date must be on or before the end date");
    }

    // Off-sale date: board-only. null follows the start date. An untouched
    // date still equal to the start date moves with it, unless the sale has
    // ended: then moving the start leaves the sale ended.
    const { offSaleAt } = patch;
    if (offSaleAt !== undefined && !actor.isBoardMember) {
        return refuse("forbidden", "Forbidden: Only the board can change the off-sale date");
    }
    if (offSaleAt != null && (typeof offSaleAt !== "string" || isNaN(Date.parse(offSaleAt)))) {
        return refuse("invalid", "Invalid off-sale date");
    }
    const saleEndedNow = isSaleEnded(currentProgram);
    const followsStart = currentProgram.offSaleAt == null
        || currentProgram.offSaleAt.getTime() === currentProgram.startAt.getTime();
    const newOffSaleAt = offSaleAt !== undefined
        ? parseDateOnly(offSaleAt)
        : !newStartAt || !followsStart ? undefined
        : saleEndedNow ? currentProgram.offSaleAt ?? currentProgram.startAt
        : newStartAt;
    // Only the board reopens an ended sale, by moving the off-sale date itself
    // later: that re-arms the sweep. Enrollment stays closed unless this save opens it.
    const rearmSale = actor.isBoardMember && saleEndedNow && offSaleAt !== undefined
        && !isSaleEnded({ startAt: newStartAt ?? currentProgram.startAt, offSaleAt: newOffSaleAt ?? null, saleEndedAt: null });
    if (enrollmentStatus === 'OPEN' && currentProgram.enrollmentStatus !== 'OPEN' && saleEndedNow && !rearmSale) {
        return refuse("conflict", "Sales for this program have ended. To reopen enrollment, move the off-sale date later.");
    }

    // Variant⟺price invariant: a program has a Shopify variant iff it
    // has a price on some tier — the capacity/oversell math assumes this
    // everywhere. Compute the post-PATCH EFFECTIVE values (current row + body
    // deltas, undefined = "field not touched") and reject both illegal
    // directions on the merged result: wiring a variant onto a price-null
    // program, and nulling both prices out from under an existing variant.
    // One check on the effective state covers both — guarding only one
    // direction is a false sense of safety.
    const newOrgMemberPriceCents = memberPrice !== undefined
        ? dollarsToCentsOrNull(memberPrice != null ? String(memberPrice) : undefined)
        : undefined;
    const newNonOrgMemberPriceCents = nonMemberPrice !== undefined
        ? dollarsToCentsOrNull(nonMemberPrice != null ? String(nonMemberPrice) : undefined)
        : undefined;
    // Prices are sysadmin/board-only. The edit page echoes the current prices on
    // every save, so only a value that differs from the stored one is rejected.
    if (!isSysAdminOrBoard && (
        (newOrgMemberPriceCents !== undefined && newOrgMemberPriceCents !== currentProgram.orgMemberPriceCents) ||
        (newNonOrgMemberPriceCents !== undefined && newNonOrgMemberPriceCents !== currentProgram.nonOrgMemberPriceCents)
    )) {
        return refuse("forbidden", "Forbidden: Only administrators can change program prices");
    }
    // Shopify identifiers are sysadmin/board-only, so a non-privileged caller's
    // effective variant is always the current one regardless of what's in body.
    const newShopifyVariantId = (isSysAdminOrBoard && shopifyVariantId !== undefined)
        ? (shopifyVariantId || null)
        : undefined;
    const effOrgMemberPriceCents = newOrgMemberPriceCents !== undefined ? newOrgMemberPriceCents : currentProgram.orgMemberPriceCents;
    const effNonOrgMemberPriceCents = newNonOrgMemberPriceCents !== undefined ? newNonOrgMemberPriceCents : currentProgram.nonOrgMemberPriceCents;
    const effShopifyVariantId = newShopifyVariantId !== undefined ? newShopifyVariantId : currentProgram.shopifyVariantId;
    if (effShopifyVariantId && effOrgMemberPriceCents == null && effNonOrgMemberPriceCents == null) {
        return refuse("invalid", "A program cannot have a Shopify variant without a price on at least one tier");
    }

    // Re-dating re-derives the membership year; a stated year is only supplied by the Board.
    const datesMoved = effStartAt.getTime() !== currentProgram.startAt.getTime() || effEndAt.getTime() !== currentProgram.endAt.getTime();
    const yearSupplied = patch.appliesToYear != null && patch.appliesToYear !== currentProgram.appliesToYear;
    let newAppliesToYear: number | undefined;
    if (datesMoved || yearSupplied) {
        const year = await resolveProgramYear({
            startAt: effStartAt,
            endAt: effEndAt,
            supplied: patch.appliesToYear,
            current: currentProgram,
            isBoardMember: actor.isBoardMember,
        });
        if (!year.ok) return year;
        if (year.appliesToYear !== currentProgram.appliesToYear) newAppliesToYear = year.appliesToYear;
    }

    const updateData: Record<string, unknown> = {
        ...(name !== undefined && { name }),
        ...(leadMentorId !== undefined && { leadMentorId }),
        ...(newStartAt !== undefined && { startAt: newStartAt }),
        ...(newEndAt !== undefined && { endAt: newEndAt }),
        ...(newAppliesToYear !== undefined && { appliesToYear: newAppliesToYear }),
        ...(newOffSaleAt !== undefined && { offSaleAt: newOffSaleAt }),
        ...(rearmSale && { saleEndedAt: null, unpaidClaimsNotifiedAt: null, productHiddenAt: null }),
        ...(orgMemberOnly !== undefined && { orgMemberOnly }),
        // publiclyVisible only has meaning for a members-only program. Recompute
        // it on the POST-PATCH effective state so neither flipping orgMemberOnly
        // off (leaving a stale publiclyVisible) nor setting publiclyVisible on a
        // public program can store the nonsense "public-but-publiclyVisible" row.
        ...((orgMemberOnly !== undefined || publiclyVisible !== undefined) && {
            publiclyVisible:
                (orgMemberOnly !== undefined ? orgMemberOnly : currentProgram.orgMemberOnly) &&
                (publiclyVisible !== undefined ? publiclyVisible : currentProgram.publiclyVisible),
        }),
        ...(announceOnOpen !== undefined && { announceOnOpen }),
        ...(phase !== undefined && { phase }),
        ...(enrollmentStatus !== undefined && { enrollmentStatus }),
        ...(minAge !== undefined && { minAge }),
        ...(maxAge !== undefined && { maxAge }),
        ...(maxParticipants !== undefined && { maxParticipants }),
        ...(leadMentorNotificationSettings !== undefined && { leadMentorNotificationSettings }),
        ...(newOrgMemberPriceCents !== undefined && { orgMemberPriceCents: newOrgMemberPriceCents }),
        ...(newNonOrgMemberPriceCents !== undefined && { nonOrgMemberPriceCents: newNonOrgMemberPriceCents }),
        // Shopify identifiers are sysadmin/board-only — a lead mentor's PATCH can't
        // touch them (they can break checkout, so they stay off the lead surface).
        // Empty string clears the field. This is the manual repair path when there's
        // no live Shopify to sync against (local/testing).
        ...(isSysAdminOrBoard && shopifyProductId !== undefined && { shopifyProductId: shopifyProductId || null }),
        ...(newShopifyVariantId !== undefined && { shopifyVariantId: newShopifyVariantId }),
        // What was owed or in flight belongs to the old variant's stock, not the new one's.
        ...(newShopifyVariantId !== undefined && newShopifyVariantId !== currentProgram.shopifyVariantId && STOCK_BOOKKEEPING_RESET),
    };

    const updatedProgram = await prisma.program.update({
        where: { id: programId },
        data: updateData
    });

    await prisma.auditLog.create({
        data: {
            actorId: actor.id,
            action: 'EDIT',
            tableName: 'Program',
            affectedEntityId: updatedProgram.id,
            oldData: currentProgram,
            newData: updatedProgram
        }
    });

    // The edit has landed; a failed re-check is logged, not reported as a failed save.
    await flagEnrollmentsNoLongerFitting(currentProgram, updatedProgram)
        .catch(e => logger.error("Program age re-check failed:", e));

    // Announce trigger — transition rule, once-per-lifetime claim, audit row,
    // and fire-without-await all live in the helper. Never throws.
    await maybeAnnounceOnOpen({
        programId: updatedProgram.id,
        before: currentProgram,
        after: updatedProgram,
        actorId: actor.id,
    });

    // Cap edits move public stock by the cap change, until the sale has ended.
    // Only fires when the program already has Shopify checkout wired up;
    // creation and sync-shopify set the initial stock themselves.
    let warning: string | undefined;
    const oldMax = currentProgram.maxParticipants;
    const newMax = updatedProgram.maxParticipants;
    const hasShopifyVariant = !!updatedProgram.shopifyVariantId;

    if (rearmSale && hasShopifyVariant && newMax !== null) {
        // Changes skipped while the sale was ended are lost to a relative push;
        // set the absolute stock instead: capacity minus seats Shopify counts
        // as taken. Not clamped: an overfilled program keeps its shortfall owed.
        if (!(await setProgramInventory(updatedProgram, async (db) => newMax - await countStockTakenSeats(programId, db), "re-arm"))) {
            warning = "Program updated, but setting the Shopify inventory failed. Capacity may be out of sync — check System Status > Link Status.";
        }
    } else if (oldMax !== newMax && hasShopifyVariant) {
        if (oldMax !== null && newMax !== null) {
            // After the sale ends a cut still goes through; a raise does not.
            const delta = saleStockDelta(updatedProgram, newMax - oldMax);
            if (delta !== 0 && !(await adjustProgramInventory(updatedProgram, delta, "capacity-edit", { inRequest: true }))) {
                warning = "Program updated, but the Shopify inventory adjustment failed. Capacity may be out of sync — check System Status > Link Status.";
            }
        } else if (!isSaleEnded(updatedProgram)) {
            // Null transition (capped <-> uncapped): a relative adjust can't express
            // "start/stop tracking inventory" — that needs an inventory_management
            // flip on the variant, which is not attempted here.
            logger.warn(`[SHOPIFY] Program ${updatedProgram.id} maxParticipants transitioned ${oldMax} -> ${newMax} (capped/uncapped); inventory not adjusted automatically.`);
            warning = "Capacity changed between capped and uncapped. Shopify inventory was not updated automatically — run Sync to Shopify or edit inventory directly in Shopify.";
        }
    }

    // Both Shopify variants carry the full price (members pay via a discount code),
    // so only a full-price change is pushed. The member price is never sent to the
    // store: a cleared or $0 full price is reported to admins and Shopify keeps its
    // old price. Only admin/board can change prices.
    const newBase = updatedProgram.nonOrgMemberPriceCents;
    if (newBase !== currentProgram.nonOrgMemberPriceCents) {
        const ok = await syncProgramPrice(updatedProgram, newBase);
        if (!ok) {
            const priceWarning = "Program saved, but the Shopify price is out of date — admins have been emailed. Set the price by hand in Shopify on both the public and reserved-seat products.";
            warning = warning ? `${warning} ${priceWarning}` : priceWarning;
        }
    }

    // The sweep hid the public product; reopening never re-lists it (automatic changes only reduce visibility).
    const notice = rearmSale && currentProgram.productHiddenAt
        ? "Sale reopened. The public store product stays hidden: re-list it in Shopify by hand if it should sell again."
        : undefined;
    return { ok: true, program: updatedProgram, warning, notice };
}

// A start-date or age-bound edit can leave enrolled people outside the program's
// ages (measured at the start date). The Board is told who; enrollments are
// never changed. Only people who fitted before the edit are named, so a re-save
// doesn't repeat old news.
async function flagEnrollmentsNoLongerFitting(before: Program, after: Program): Promise<void> {
    if (before.minAge === after.minAge && before.maxAge === after.maxAge && before.startAt.getTime() === after.startAt.getTime()) return;
    const rule = (p: Program) => ({ minAge: p.minAge, maxAge: p.maxAge, asOf: p.startAt });
    const enrolled = await prisma.programParticipant.findMany({
        where: { programId: after.id, person: LIVE_PERSON, ...ENROLLED_PARTICIPANT },
        select: { status: true, person: { select: { name: true, dateOfBirth: true, isDeclaredAdult: true } } },
    });
    const misfits = enrolled.flatMap(({ status, person }) => {
        const now = checkProgramAge(person, rule(after));
        return !now.ok && checkProgramAge(person, rule(before)).ok ? [{ name: person.name, status, label: now.label }] : [];
    });
    if (misfits.length === 0) return;

    const rows = misfits.map(m => `<li>${escapeHtml(m.name ?? "Unnamed")}: ${m.label} (${m.status === "ACTIVE" ? "paid" : "not paid yet"})</li>`).join("");
    await emailBoardMembers(
        `Program "${after.name}": ${misfits.length} enrolled no longer fit its ages`,
        `<p>An edit to the dates or age limits of <strong>${escapeHtml(after.name)}</strong> leaves these enrolled people outside its ages at the start date. Nothing was changed; please decide with the program leader and the families.</p><ul>${rows}</ul><p><a href="${config.baseUrl()}/program-ops/programs/${after.id}">Open the program</a></p>`,
        "Program age re-check board alert failed:",
    );
}
