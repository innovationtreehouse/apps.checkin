import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { isValidPhone, formatPhone, PHONE_ERROR } from "@/lib/phone";
import { nameWrite, nicknameWrite, isNicknameWrite } from "@/lib/person/name";
import { apiError } from "@/lib/api-response";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { refuseSelfGrant, SELF_GRANT_REFUSAL_MESSAGE } from "@/lib/membership/selfGrantGuard";
import { normalizeEmail } from "@/lib/prismaEmailNormalize";
import { withIntakeNotesFor } from "@/lib/household/intakeNotes";
import { removeAliasesForSignInEmail } from "@/lib/person/mailAliases";
import { personActor } from "@/lib/auditActor";
import { isYouth } from "@/lib/time";

export const PUT = withAuth<{ params: Promise<{ id: string }> }>(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (request: NextRequest, auth, { params }) => {
    if (auth.type !== 'session') {
        return apiError("Unauthorized", 401);
    }

    try {
        const resolvedParams = await params;
        const id = parseInt(resolvedParams.id, 10);
        if (isNaN(id)) {
            return apiError("Invalid participant ID", 400);
        }

        const body = await request.json();
        
        const updateData: Record<string, NonNullable<unknown> | null | string | number | boolean | Date> = {};
        if (body.name !== undefined) {
            const writtenName = nameWrite(body.name);
            if (!writtenName) {
                return apiError("Name cannot be blank", 400);
            }
            updateData.name = writtenName;
        }
        // The name this person goes by, printed on their badge in place of the first
        // name parsed out of `name`. Optional, so a blank clears it rather than being
        // rejected; `undefined` leaves the stored value alone.
        if (!isNicknameWrite(body.nickname)) {
            return apiError("Invalid nickname", 400);
        }
        const nickname = nicknameWrite(body.nickname);
        if (nickname !== undefined) updateData.nickname = nickname;
        if (body.email !== undefined) updateData.email = body.email;
        if (body.phone !== undefined) {
            if (body.phone !== "" && body.phone !== null && !isValidPhone(body.phone)) {
                return apiError(PHONE_ERROR, 400);
            }
            updateData.phone = body.phone === "" || body.phone === null ? null : formatPhone(body.phone);
        }
        if (body.isDeclaredAdult !== undefined) updateData.isDeclaredAdult = Boolean(body.isDeclaredAdult);

        if (Object.keys(updateData).length === 0) {
            return apiError("No fields to update provided", 400);
        }

        // dateOfBirth and householdId are read for the guards below but deliberately
        // kept out of the audit payload — this route neither ships nor writes them.
        const existing = await prisma.person.findUnique({
            where: { id },
            select: { name: true, nickname: true, email: true, phone: true, dateOfBirth: true, isDeclaredAdult: true, householdId: true },
        });
        if (!existing) {
            return apiError("Participant not found", 404);
        }
        const { dateOfBirth: priorDob, householdId, ...prior } = existing;

        // A date of birth on file supersedes the over-25 declaration (normalizeAdultDob):
        // a person has one or the other, never both. Coerced rather than refused so a row
        // that holds both is repaired on its next edit instead of being unsaveable, since
        // the edit form resubmits the whole record.
        if (updateData.isDeclaredAdult === true && priorDob) {
            updateData.isDeclaredAdult = false;
        }

        // A linked Google account signs in as whoever holds it, so a changed address
        // ends every existing link; the next sign-in must come from the new address.
        const emailChanged = body.email !== undefined
            && normalizeEmail(body.email ?? "") !== normalizeEmail(prior.email ?? "");
        let emailChangeReason: string | undefined;
        if (emailChanged) {
            // The email decides who signs in as this person, so only a board member
            // outside their household changes it, and says why.
            if (!auth.user.isBoardMember) {
                return apiError("Only a board member can change a person's email.", 403);
            }
            emailChangeReason = typeof body.emailChangeReason === "string" ? body.emailChangeReason.trim() : "";
            if (!emailChangeReason) {
                return apiError("Give a reason for changing this person's email.", 400);
            }
            if (await refuseSelfGrant(prisma, auth.user.id, { personId: id, householdId }, {
                table: "Person",
                attempted: { email: body.email ?? null },
            })) {
                return apiError(SELF_GRANT_REFUSAL_MESSAGE, 403);
            }
            updateData.emailVerified = null;
            updateData.googleId = null;
        }

        // A new address gets its own first sign-in, and a youth stays where they were added:
        // a Board edit closes a household question that the record's youth cannot answer.
        if (emailChanged || (auth.user.isBoardMember && isYouth(priorDob))) {
            updateData.householdJoinPending = false;
        }

        const updatedParticipant = await prisma.$transaction(async (tx) => {
            if (emailChanged && body.email) await removeAliasesForSignInEmail(tx, body.email, personActor(auth.user.id), "board_email_change");
            const unlinked = emailChanged ? (await tx.account.deleteMany({ where: { userId: id } })).count : 0;
            const updated = await tx.person.update({
                where: { id },
                data: updateData,
                include: {
                    household: true
                }
            });
            await tx.auditLog.create({
                data: {
                    actorId: auth.user.id,
                    action: "EDIT",
                    tableName: "Person",
                    affectedEntityId: id,
                    oldData: prior,
                    newData: {
                        ...updateData,
                        ...(emailChangeReason && { emailChangeReason }),
                    },
                },
            });
            if (unlinked > 0) {
                await tx.auditLog.create({
                    data: {
                        actorId: auth.user.id,
                        action: "DELETE",
                        tableName: "Account",
                        affectedEntityId: id,
                        oldData: { linkedAccounts: unlinked },
                        newData: { reason: "email changed" },
                    },
                });
            }
            return updated;
        });
        // Name, DOB/adult and keyholder fields all feed the live roster.
        invalidateAttendanceCache();

        const formatted = {
            id: updatedParticipant.id,
            name: updatedParticipant.name,
            nickname: updatedParticipant.nickname,
            email: updatedParticipant.email,
            phone: updatedParticipant.phone,
            dateOfBirth: updatedParticipant.dateOfBirth,
            isDeclaredAdult: updatedParticipant.isDeclaredAdult,
            lastBackgroundCheck: updatedParticipant.lastBackgroundCheck,
            isBoardMember: updatedParticipant.isBoardMember,
            isKeyholder: updatedParticipant.isKeyholder,
            household: updatedParticipant.household && withIntakeNotesFor(updatedParticipant.household, auth.user),
        };

        return NextResponse.json({ participant: formatted });
    } catch (error) {
        logger.error("Failed to update participant:", error);
        return apiError("Failed to update participant", 500);
    }
});
