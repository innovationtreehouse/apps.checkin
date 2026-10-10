import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { reconcileAndWarn } from "@/lib/emergencyContacts/service";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { isValidPhone, formatPhone, PHONE_ERROR } from "@/lib/phone";
import { isOrgAccount } from "@/lib/orgAccount";
import { HOUSEHOLD_PEER_SELECT, HOUSEHOLD_PEER_WITH_SIGN_IN_SELECT } from "@/lib/household/participantProjection";
import { householdLeadship } from "@/lib/household/leads";
import { normalizeAdultDob } from "@/lib/person/adultDob";
import { LIVE_PERSON } from "@/lib/person/filters";
import { mintPersonId } from "@/lib/person/mintId";
import { apiError } from "@/lib/api-response";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { getEmailSenderIdentity } from "@/lib/emailIdentity";

export const GET = withAuth(
    {},
    async (_req, auth) => {
        try {
            if (auth.type !== 'session') return apiError("Unauthorized", 401);
            const userId = auth.user.id;

            const user = await prisma.person.findUnique({
                where: { id: userId },
                include: {
                    household: {
                        include: {
                            householdMembers: { where: LIVE_PERSON, select: HOUSEHOLD_PEER_WITH_SIGN_IN_SELECT },
                            orgMembership: true,
                        }
                    }
                }
            });

            if (!user) return apiError("User not found", 404);

            // intakeNotes is the family's free-text "anything else we should know?"
            // note written BY the lead TO the board/BG reviewers — schema classifies
            // it 'pii' for the reviewer queue, and guards against it reaching any
            // other household-scoped view. Household peers (incl. youth with their
            // own logins) have no business reading a note a parent wrote about them.
            // Only the lead sees it, matching the lead-gated editor on /my-household
            // and the 403 on PATCH /api/household/settings. Address stays: shared
            // household data the family authored.
            const canSeeNotes = user.isHouseholdLead || user.isSysadmin;
            const household = user.household && {
                ...user.household,
                ...(canSeeNotes ? {} : { intakeNotes: null }),
                // A linked sign-in locks the member's email on the household card;
                // only the boolean leaves, never Account data.
                householdMembers: user.household.householdMembers.map(({ _count, ...m }) => ({
                    ...m,
                    hasSignIn: _count.accounts > 0,
                })),
            };
            // Where the locked-email help text points members to change it.
            const { replyTo } = await getEmailSenderIdentity();

            return NextResponse.json({ household, boardReplyTo: replyTo?.[0] ?? null }, { status: 200 });
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

            const { member, warning } = await prisma.$transaction(async (tx) => {
                // Always create a fresh member — never reparent an existing account by
                // email. Real account linking happens at Google sign-in via
                // allowDangerousEmailAccountLinking (see lib/auth-options.ts). Attaching
                // here would let any lead absorb a known/guessed email into their household.
                const member = await tx.person.create({
                    data: {
                        id: await mintPersonId(tx),
                        name: memberName,
                        ...(memberEmail && { email: memberEmail.toLowerCase() }),
                        // #1165: strip DoB + declare adult when the entered date is 26+.
                        // When no DoB is given, the over-25 checkbox owns the flag.
                        ...normalizeAdultDob(memberDob || null),
                        ...(memberPhone && { phone: formatPhone(memberPhone) }),
                        ...(memberDob ? {} : { isDeclaredAdult: !!memberOver25 }),
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
                return apiError("We couldn't add this member with that email. If they already have an account, they'll be linked automatically when they first sign in with Google using that email.", 400);
            }
            logger.error("Household PATCH Error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);

// Prisma known-request errors carry a string `code`. Duck-typed so we don't
// pull in the generated Prisma namespace just for one check.
function isPrismaError(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error
        && (error as { code: unknown }).code === code;
}
