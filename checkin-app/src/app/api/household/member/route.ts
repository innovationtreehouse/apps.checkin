import { NextResponse } from "next/server";
import { logger, logBackendError } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { addHouseholdLead, removeHouseholdLead, HouseholdLeadLimitError, HouseholdLeadDeniedError } from "@/lib/household/leads";
import { reconcileAndWarn } from "@/lib/emergencyContacts/service";
import { isValidPhone, formatPhone, PHONE_ERROR } from "@/lib/phone";
import { HOUSEHOLD_PEER_SELECT } from "@/lib/household/participantProjection";
import { householdLeadship } from "@/lib/household/leads";
import { normalizeAdultDob, replacesUnder18Date, UNDER_18_DECLARATION_REFUSAL } from "@/lib/person/adultDob";
import { nameWrite, nicknameWrite, isNicknameWrite } from "@/lib/person/name";
import { isYouth } from "@/lib/time";
import { apiError } from "@/lib/api-response";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { getEmailSenderIdentity } from "@/lib/emailIdentity";
import { signInEmailHelp, grantedAuthorityEmailHelp } from "@/lib/person/signInEmail";
import { isDesignatedEmail, designatedEmailRefusalForBoard } from "@/lib/membership/volunteerDesignation";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import { refuseSelfGrant } from "@/lib/membership/selfGrantGuard";
import { trustStatus } from "@/lib/roles";
import { raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";
import { removeAliasesForSignInEmail } from "@/lib/person/mailAliases";
import { personActor } from "@/lib/auditActor";

class BecameTrustedError extends Error {}

export const PATCH = withAuth(
    {},
    async (req, auth) => {
        try {
            if (auth.type !== 'session') return apiError("Unauthorized", 401);
            const userId = auth.user.id;

            const body = await req.json();
            const { participantId, name, nickname, email, dob, phone, isLead, over25, allergies } = body;

            if (!participantId) {
                return apiError("Participant ID is required", 400);
            }

            // Phone is optional for a member, but if supplied it must be valid.
            if (phone !== undefined && phone !== "" && !isValidPhone(phone)) {
                return apiError(PHONE_ERROR, 400);
            }

            // A submitted-but-blank name is rejected, not silently dropped.
            if (name !== undefined && !nameWrite(name)) {
                return apiError("Name cannot be blank", 400);
            }

            if (!isNicknameWrite(nickname)) {
                return apiError("Invalid nickname", 400);
            }

            const hh = await householdLeadship(userId);

            if (!hh) {
                return apiError("You must create a household first", 400);
            }
            const householdId = hh.householdId;

            // Leads/sysadmins edit anyone; anyone may edit their own record.
            if (!hh.canManage && participantId !== userId) {
                return apiError("Only household leads can edit household members", 403);
            }

            const targetHouseholdMember = await prisma.person.findUnique({
                where: { id: participantId },
                include: {
                    _count: {
                        select: {
                            accounts: true,
                            roles: true,
                            programsLed: true,
                            programVolunteers: true,
                            bgAttestationsAsSubject: true,
                            personBgProcesses: true,
                            toolStatuses: true,
                        },
                    },
                    household: { select: { orgMembership: { select: { isVolunteerFamily: true } } } },
                },
            });
            if (!targetHouseholdMember || targetHouseholdMember.householdId !== householdId) {
                return apiError("That household member was not found", 404);
            }

            if (participantId === userId && isYouth(targetHouseholdMember.dateOfBirth)) {
                return apiError("Youth profiles are read-only.", 403);
            }

            if (replacesUnder18Date(dob, over25, targetHouseholdMember.dateOfBirth)) {
                return apiError(UNDER_18_DECLARATION_REFUSAL, 400);
            }

            // A sysadmin manages their own household without leading it, so making
            // someone its lead that way is a grant to their own household.
            if (isLead === true && participantId !== userId && !targetHouseholdMember.isHouseholdLead) {
                const actor = await prisma.person.findUnique({ where: { id: userId }, select: { isHouseholdLead: true } });
                if (!actor?.isHouseholdLead && await refuseSelfGrant(prisma, userId, { personId: participantId, householdId }, {
                    table: "Person",
                    attempted: { isHouseholdLead: true },
                })) {
                    return apiError("Only a lead of this household can make someone else its lead.", 403);
                }
            }

            // A linked sign-in's email is its sign-in address; only the board changes it.
            if (email !== undefined && targetHouseholdMember._count.accounts > 0) {
                const { replyTo } = await getEmailSenderIdentity();
                return apiError(signInEmailHelp(replyTo?.[0]), 400);
            }

            // The email is the sign-in key, so a member holding board-granted authority keeps
            // the address the board granted it to. The form resends it on every save, so an
            // equivalent address passes the check but is never written over the stored one.
            const { _count: held } = targetHouseholdMember;
            const holdsGrant = held.roles + held.programsLed + held.programVolunteers
                + held.bgAttestationsAsSubject + held.personBgProcesses + held.toolStatuses > 0
                || Boolean(targetHouseholdMember.lastBackgroundCheck)
                || targetHouseholdMember.canAccessStaging
                || Boolean(targetHouseholdMember.household.orgMembership?.isVolunteerFamily)
                || (email !== undefined && (await trustStatus(prisma, participantId)).isTrusted);
            if (holdsGrant && email !== undefined && canonicalizeEmail(email ?? "") !== canonicalizeEmail(targetHouseholdMember.email ?? "")) {
                const { replyTo } = await getEmailSenderIdentity();
                return apiError(grantedAuthorityEmailHelp(replyTo?.[0]), 400);
            }

            // The form resends an unchanged email on every save; only a change is refused.
            const emailChanged = email && canonicalizeEmail(email) !== canonicalizeEmail(targetHouseholdMember.email ?? "");
            if (emailChanged && await isDesignatedEmail(prisma, email)) {
                return apiError(await designatedEmailRefusalForBoard(), 400);
            }

            const { updatedHouseholdMember, leadRejection, deniedLead, warning } = await prisma.$transaction(async (tx) => {
                if (email && !holdsGrant && email.toLowerCase() !== targetHouseholdMember.email?.toLowerCase()) {
                    await removeAliasesForSignInEmail(tx, email, personActor(userId), "household_card_edit");
                }
                const updatedHouseholdMember = await tx.person.update({
                    where: { id: participantId },
                    data: {
                        name: nameWrite(name),
                        nickname: nicknameWrite(nickname),
                        email: email !== undefined && !holdsGrant ? (email === "" ? null : email.toLowerCase()) : undefined,
                        phone: phone !== undefined ? (phone === "" ? null : formatPhone(phone)) : undefined,
                        ...normalizeAdultDob(dob, over25, targetHouseholdMember.dateOfBirth),
                        allergies: allergies !== undefined ? (allergies === "" ? null : allergies) : undefined,
                    },
                    select: HOUSEHOLD_PEER_SELECT,
                });

                // Read after the write and roll back: a grant this misses commits after
                // the edit, so it lands on the new address rather than being changed under.
                if (email !== undefined && !holdsGrant && (await trustStatus(tx, participantId)).isTrusted) {
                    throw new BecameTrustedError();
                }

                // Set when the field edits saved but the requested promotion to lead
                // was declined by the per-household cap. We report this back
                // rather than 400 the whole edit, so the form can say the member's
                // details were saved even though they weren't made a lead.
                let leadRejection: string | null = null;
                let deniedLead: HouseholdLeadDeniedError | null = null;

                if (isLead !== undefined && participantId !== userId) {
                    const currentTarget = await tx.person.findUnique({
                        where: { id: participantId },
                        select: { isHouseholdLead: true }
                    });
                    const currentLead = !!currentTarget?.isHouseholdLead;

                    if (isLead && !currentLead) {
                        try {
                            await addHouseholdLead(tx, householdId, participantId);
                            await tx.auditLog.create({
                                data: {
                                    actorId: userId,
                                    action: "CREATE",
                                    tableName: "Person",
                                    affectedEntityId: participantId,
                                    secondaryAffectedEntity: householdId
                                }
                            });
                        } catch (e) {
                            if (e instanceof HouseholdLeadLimitError) {
                                leadRejection = e.message;
                            } else if (e instanceof HouseholdLeadDeniedError) {
                                leadRejection = e.message;
                                deniedLead = e;
                            } else {
                                throw e;
                            }
                        }
                    } else if (!isLead && currentLead) {
                        // Locked demote (shared with the lead route). Silently a
                        // no-op if this is the household's last lead — the member
                        // edit still saves; leadership just isn't dropped.
                        const result = await removeHouseholdLead(tx, householdId, participantId);
                        if (result.removed) {
                            await tx.auditLog.create({
                                data: {
                                    actorId: userId,
                                    action: "DELETE",
                                    tableName: "Person",
                                    affectedEntityId: participantId,
                                    secondaryAffectedEntity: householdId
                                }
                            });
                        }
                    }
                }

                await tx.auditLog.create({
                    data: {
                        actorId: userId,
                        action: "EDIT",
                        tableName: "Person",
                        affectedEntityId: targetHouseholdMember.id,
                        newData: updatedHouseholdMember
                    }
                });

                // Edits to a member's name/phone/email can make them match an
                // emergency contact (direction B): re-evaluate and warn if so.
                const warning = await reconcileAndWarn(tx, householdId);

                return { updatedHouseholdMember, leadRejection, deniedLead, warning };
            });
            invalidateAttendanceCache();
            if (deniedLead) {
                const ref = { householdId: deniedLead.householdId, personId: deniedLead.personId };
                try {
                    await raiseDeniedHouseholdActivity({ ...ref, what: "household lead promotion refused" });
                } catch (error) {
                    // The edit has committed, so this failure must not read as a failed save.
                    logger.error("Household Member PATCH denied household raise failed:", ref, error);
                    await logBackendError(error, "PATCH /api/household/member denied household raise", ref);
                }
            }

            return NextResponse.json({
                householdMember: updatedHouseholdMember,
                message: leadRejection ? "Household member updated, but not added as a lead." : "Household member updated successfully.",
                leadRejection,
                warning,
            }, { status: 200 });

        } catch (error: unknown) {
            if (error instanceof HouseholdLeadLimitError) {
                return apiError(error.message, 400);
            }
            if (error instanceof BecameTrustedError) {
                const { replyTo } = await getEmailSenderIdentity();
                return apiError(grantedAuthorityEmailHelp(replyTo?.[0]), 400);
            }
            logger.error("Household Member PATCH Error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);
