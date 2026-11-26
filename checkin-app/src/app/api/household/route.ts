import prisma from "@/lib/prisma";
import { orgToday } from "@/lib/appSettings";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { ApiResponseError, badRequest, forbidden, handler, notFound, unauthorized } from "@/security/handler";
import { reconcileAndWarn } from "@/lib/emergencyContacts/service";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { isValidPhone, formatPhone, PHONE_ERROR } from "@/lib/phone";
import { isOrgAccount } from "@/lib/orgAccount";
import { HOUSEHOLD_PEER_SELECT, HOUSEHOLD_PEER_WITH_EMAIL_LOCK_SELECT } from "@/lib/household/participantProjection";
import { householdLeadship, setsHouseholdAges } from "@/lib/household/leads";
import { isEmailLocked } from "@/lib/person/emailLock";
import { EMAIL_IN_USE_REFUSAL } from "@/lib/household/emailInUse";
import { AGE_LEAD_ONLY_REFUSAL, normalizeAdultDob } from "@/lib/person/adultDob";
import { mintPersonId } from "@/lib/person/mintId";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { getEmailSenderIdentity } from "@/lib/emailIdentity";
import { membershipValidThrough } from "@/lib/orgMembership";
import { isDesignatedEmail, designatedEmailRefusalForBoard } from "@/lib/membership/volunteerDesignation";
import { removeAliasesForSignInEmail } from "@/lib/person/mailAliases";
import { personActor } from "@/lib/auditActor";
import { ArchivedHouseholdError, lockLiveHouseholds } from "@/lib/household/archiveGuard";
import { isYouth } from "@/lib/time";
import { noteStands } from "@/lib/membership/notRenewing";
import { bgStatus } from "@/lib/membership/bgStatus";
import { isRecheckPolicySet } from "@/lib/membership/bgRecheckPolicy";

export const GET = handler('GET /api/household', async ({ auth }) => {
    if (auth.type !== 'session') throw unauthorized();

    const user = await prisma.person.findUnique({
        where: { id: auth.user.id },
        select: {
            household: {
                select: {
                    id: true,
                    name: true,
                    line1: true,
                    line2: true,
                    city: true,
                    state: true,
                    postalCode: true,
                    householdMembers: { select: { ...HOUSEHOLD_PEER_WITH_EMAIL_LOCK_SELECT, householdId: true } },
                    orgMembership: { select: { status: true, memberSince: true, isVolunteerFamily: true, householdId: true, notRenewingYear: true } },
                }
            }
        }
    });

    if (!user) throw notFound("User not found");

    const now = new Date();
    const today = await orgToday(now);
    const settings = user.household
        ? await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true, bgRecheckMonths: true } })
        : null;
    const bgTracked = !!settings?.orgMembershipYearBoundary && isRecheckPolicySet(settings.bgRecheckMonths);
    const membership = user.household?.orgMembership;
    // A note for a year that has passed means nothing, so the page never sees it.
    if (membership?.notRenewingYear != null && !noteStands(membership.notRenewingYear, settings?.orgMembershipYearBoundary, now)) {
        membership.notRenewingYear = null;
    }

    const household = user.household && {
        ...user.household,
        // Only the lock's boolean leaves; its inputs are internal-tier.
        householdMembers: user.household.householdMembers.map((m) => {
            const {
                _count, budgetOwnersOwned, budgetOwnerTreasurerships, instancesLed,
                household: _household, lastBackgroundCheck, canAccessStaging, ...peer
            } = m;
            const isAdult = m.isDeclaredAdult || (!!m.dateOfBirth && !isYouth(m.dateOfBirth, today));
            // Every adult carries bgStatus while the policy is set, so its presence says nothing about a check
            // on file. Only the computed status leaves, never the date; the stripper keeps it for the person and their lead.
            if (!settings || !bgTracked || !isAdult) return { ...peer, emailLocked: isEmailLocked(m) };
            const status = bgStatus(lastBackgroundCheck, settings, now, today);
            return { ...peer, emailLocked: isEmailLocked(m), bgStatus: { personId: m.id, ...(status && { status }) } };
        }),
    };
    // Where the locked-email help text points members to change it.
    const { replyTo } = await getEmailSenderIdentity();

    // Same valid-until households-ops shows, so the family sees the lapse the board sees.
    const validUntil = household?.orgMembership?.status === "ACTIVE"
        ? await membershipValidThrough(household.id)
        : null;

    return { HouseholdPage: { household, boardReplyTo: replyTo?.[0] ?? null, validUntil } };
});

export const PATCH = handler('PATCH /api/household', async ({ req, auth }) => {
    if (auth.type !== 'session') throw unauthorized();
    const userId = auth.user.id;

    // A Treehouse account is not a member family, so its household holds only that account.
    if (isOrgAccount(auth.user)) {
        throw forbidden("Staff accounts cannot add household members.");
    }

    const body = (await req.json().catch(() => null)) ?? {};
    const { memberName, memberEmail, memberDob, memberPhone, memberOver25, memberAllergies } = body;

    const hh = await householdLeadship(userId);

    if (!hh) throw badRequest("You must create a household first");

    if (!hh.canManage) throw forbidden("Only household leads can add members");

    if (memberEmail && !isValidEmail(memberEmail)) throw badRequest("Invalid email format");

    if (memberEmail && await isDesignatedEmail(prisma, memberEmail)) {
        throw badRequest(await designatedEmailRefusalForBoard());
    }

    if (memberPhone && !isValidPhone(memberPhone)) throw badRequest(PHONE_ERROR);

    if (!memberName?.trim()) throw badRequest("Name is required");

    if (!memberDob && !memberOver25) {
        // A new member's age must be known: either a DoB, or an explicit
        // "25+" declaration (mirrors the client form's requirement).
        throw badRequest("Date of birth is required for anyone under 25.");
    }

    const householdId = hh.householdId;
    // Every new member carries an age, so adding one is an age write.
    if (!(await setsHouseholdAges(prisma, userId, householdId))) throw forbidden(AGE_LEAD_ONLY_REFUSAL);
    const today = await orgToday();

    try {
        const { member, warning } = await prisma.$transaction(async (tx) => {
            await lockLiveHouseholds(tx, [householdId]);
            if (memberEmail) await removeAliasesForSignInEmail(tx, memberEmail, personActor(userId), "household_add_member");
            // Always create a fresh member — never reparent an existing account by
            // email. Real account linking happens at Google sign-in via
            // allowDangerousEmailAccountLinking (see lib/auth-options.ts). Attaching
            // here would let any lead absorb a known/guessed email into their household.
            const member = await tx.person.create({
                data: {
                    id: await mintPersonId(tx),
                    name: memberName,
                    ...(memberEmail && { email: memberEmail.toLowerCase() }),
                    ...normalizeAdultDob(memberDob, today, memberOver25),
                    ...(memberPhone && { phone: formatPhone(memberPhone) }),
                    allergies: memberAllergies || null,
                    householdId,
                },
                select: { ...HOUSEHOLD_PEER_SELECT, householdId: true },
            });

            await tx.auditLog.create({
                data: {
                    actorId: userId,
                    action: "EDIT",
                    tableName: "Person",
                    affectedEntityId: member.id,
                    newData: { householdId, email: member.email, name: member.name }
                }
            });

            // A newly-added member may be an existing emergency contact (direction
            // B): flag the colliding contact and warn the lead to add a replacement.
            const warning = await reconcileAndWarn(tx, householdId);

            return { member, warning };
        });
        invalidateAttendanceCache();

        return { HouseholdMemberAdded: { member, warning } };
    } catch (error: unknown) {
        // P2002 = unique violation on Person.email: the provided email already
        // belongs to some account. Return a generic, non-confirming validation
        // error framed around login-time linking — do NOT attach the existing
        // account, and do NOT confirm it exists.
        if (isPrismaError(error, 'P2002')) throw badRequest(EMAIL_IN_USE_REFUSAL);
        if (error instanceof ArchivedHouseholdError) throw new ApiResponseError(error.status, error.message);
        throw error;
    }
});
