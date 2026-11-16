import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { withAuth } from "@/lib/auth";
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
import { apiError } from "@/lib/api-response";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { getEmailSenderIdentity } from "@/lib/emailIdentity";
import { membershipValidThrough } from "@/lib/orgMembership";
import { isDesignatedEmail, designatedEmailRefusalForBoard } from "@/lib/membership/volunteerDesignation";
import { removeAliasesForSignInEmail } from "@/lib/person/mailAliases";
import { personActor } from "@/lib/auditActor";
import { ArchivedHouseholdError, lockLiveHouseholds } from "@/lib/household/archiveGuard";

export const GET = withAuth(
    {},
    async (_req, auth) => {
        try {
            if (auth.type !== 'session') return apiError("Unauthorized", 401);
            const userId = auth.user.id;

            const user = await prisma.person.findUnique({
                where: { id: userId },
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
                            householdMembers: { select: HOUSEHOLD_PEER_WITH_EMAIL_LOCK_SELECT },
                            orgMembership: { select: { status: true, memberSince: true, isVolunteerFamily: true } },
                        }
                    }
                }
            });

            if (!user) return apiError("User not found", 404);

            const household = user.household && {
                ...user.household,
                // Only the lock's boolean leaves; its inputs are internal-tier.
                householdMembers: user.household.householdMembers.map((m) => {
                    const {
                        _count, budgetOwnersOwned, budgetOwnerTreasurerships, instancesLed,
                        household: _household, lastBackgroundCheck, canAccessStaging, ...peer
                    } = m;
                    return { ...peer, emailLocked: isEmailLocked(m) };
                }),
            };
            // Where the locked-email help text points members to change it.
            const { replyTo } = await getEmailSenderIdentity();

            // Same valid-until households-ops shows, so the family sees the lapse the board sees.
            const validUntil = household?.orgMembership?.status === "ACTIVE"
                ? await membershipValidThrough(household.id)
                : null;

            return NextResponse.json({ household, boardReplyTo: replyTo?.[0] ?? null, validUntil }, { status: 200 });
        } catch (error: unknown) {
            logger.error("Household GET Error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);

export const PATCH = withAuth(
    {},
    async (req, auth) => {
        try {
            if (auth.type !== 'session') return apiError("Unauthorized", 401);
            const userId = auth.user.id;

            // Internal staff (@innovationtreehouse.org) accounts are not real member families,
            // so they may not build out a household with extra members via self-service. The
            // admin participant-add flow (isSysadmin/isBoardMember) is separate and stays open.
            if (isOrgAccount(auth.user)) {
                return apiError("Staff accounts cannot add household members. Use the membership-ops participant tools instead.", 403);
            }

            const body = await req.json();
            const { memberName, memberEmail, memberDob, memberPhone, memberOver25, memberAllergies } = body;

            const hh = await householdLeadship(userId);

            if (!hh) {
                return apiError("You must create a household first", 400);
            }

            if (!hh.canManage) {
                return apiError("Only household leads can add members", 403);
            }

            if (memberEmail && !isValidEmail(memberEmail)) {
                return apiError("Invalid email format", 400);
            }

            if (memberEmail && await isDesignatedEmail(prisma, memberEmail)) {
                return apiError(await designatedEmailRefusalForBoard(), 400);
            }

            if (memberPhone && !isValidPhone(memberPhone)) {
                return apiError(PHONE_ERROR, 400);
            }

            if (!memberName?.trim()) {
                return apiError("Name is required", 400);
            }

            if (!memberDob && !memberOver25) {
                // A new member's age must be known: either a DoB, or an explicit
                // "25+" declaration (mirrors the client form's requirement).
                return apiError("Date of birth is required for anyone under 25.", 400);
            }

            const householdId = hh.householdId;
            // Every new member carries an age, so adding one is an age write.
            if (!(await setsHouseholdAges(prisma, userId, householdId))) {
                return apiError(AGE_LEAD_ONLY_REFUSAL, 403);
            }

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
                        ...normalizeAdultDob(memberDob, memberOver25),
                        ...(memberPhone && { phone: formatPhone(memberPhone) }),
                        allergies: memberAllergies || null,
                        householdId,
                    },
                    select: HOUSEHOLD_PEER_SELECT,
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

            return NextResponse.json({ member, warning }, { status: 200 });
        } catch (error: unknown) {
            // P2002 = unique violation on Person.email: the provided email already
            // belongs to some account. Return a generic, non-confirming validation
            // error framed around login-time linking — do NOT attach the existing
            // account, and do NOT confirm it exists.
            if (isPrismaError(error, 'P2002')) {
                return apiError(EMAIL_IN_USE_REFUSAL, 400);
            }
            if (error instanceof ArchivedHouseholdError) return apiError(error.message, error.status);
            logger.error("Household PATCH Error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);
