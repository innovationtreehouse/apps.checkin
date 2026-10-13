import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { isValidPhone, formatPhone, PHONE_ERROR } from "@/lib/phone";
import { nameWrite, nicknameWrite, isNicknameWrite } from "@/lib/person/name";
import { apiError, apiJson } from "@/lib/api-response";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { refuseSelfGrant, SELF_GRANT_REFUSAL_MESSAGE } from "@/lib/membership/selfGrantGuard";
import { monthsBefore, nextBoundary } from "@/lib/membership/renewal";

/**
 * Whether a check dated `date` covers the coming membership year — the per-lead
 * form of householdBgIsFresh's rule. Unset policy means nothing is fresh.
 */
async function bgCoversComingYear(date: Date | null): Promise<{ fresh: boolean; boundary: Date | null }> {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true, bgRecheckMonths: true } });
    const recheckMonths = settings?.bgRecheckMonths ?? 0;
    const boundary = settings?.orgMembershipYearBoundary ? nextBoundary(settings.orgMembershipYearBoundary, new Date()) : null;
    if (!date || !boundary || recheckMonths <= 0) return { fresh: false, boundary };
    return { fresh: date.getTime() >= monthsBefore(boundary, recheckMonths).getTime(), boundary };
}

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
        let lastBackgroundCheck: Date | null | undefined;
        if (body.lastBackgroundCheck !== undefined) {
            // "" or null clears the date; otherwise expect a YYYY-MM-DD string
            const raw = body.lastBackgroundCheck;
            if (raw === "" || raw === null) {
                lastBackgroundCheck = null;
            } else {
                lastBackgroundCheck = new Date(raw);
                if (isNaN(lastBackgroundCheck.getTime())) {
                    return apiError("Invalid background check review date", 400);
                }
            }
            updateData.lastBackgroundCheck = lastBackgroundCheck;
        }

        if (Object.keys(updateData).length === 0) {
            return apiError("No fields to update provided", 400);
        }

        // dateOfBirth, householdId and isHouseholdLead are read for the guards below but deliberately
        // kept out of the audit payload — this route neither ships nor writes them.
        const existing = await prisma.person.findUnique({
            where: { id },
            select: { name: true, nickname: true, email: true, phone: true, dateOfBirth: true, isDeclaredAdult: true, lastBackgroundCheck: true, householdId: true, isHouseholdLead: true },
        });
        if (!existing) {
            return apiError("Participant not found", 404);
        }
        const { dateOfBirth: priorDob, householdId, isHouseholdLead, ...prior } = existing;

        // A background-check date clears a person, so no actor may change it for
        // themselves or their own household. Compared by value because the edit form
        // resubmits the unchanged date with every save.
        let bgStaleWarning: string | undefined;
        if (lastBackgroundCheck !== undefined) {
            const changed = (prior.lastBackgroundCheck?.getTime() ?? null) !== (lastBackgroundCheck?.getTime() ?? null);
            if (changed && await refuseSelfGrant(prisma, auth.user.id, { personId: id, householdId }, {
                table: "Person",
                attempted: { lastBackgroundCheck },
            })) {
                return apiError(SELF_GRANT_REFUSAL_MESSAGE, 403);
            }

            // A lead's check going from covering the coming year to not covering it can
            // affect the household's membership, so the board confirms before it saves.
            if (changed && isHouseholdLead) {
                const before = await bgCoversComingYear(prior.lastBackgroundCheck);
                if (before.fresh && !(await bgCoversComingYear(lastBackgroundCheck)).fresh) {
                    bgStaleWarning = `${prior.name}'s background check covers the membership year starting ${before.boundary?.toISOString().slice(0, 10)}, and will not after this change. This could affect their household's membership.`;
                    if (body.confirmBgStale !== true) {
                        return apiJson({ error: bgStaleWarning, warning: bgStaleWarning, requiresConfirmation: true }, 409);
                    }
                }
            }
        }

        // A date of birth on file supersedes the over-25 declaration (normalizeAdultDob):
        // a person has one or the other, never both. Coerced rather than refused so a row
        // that holds both — bulk import writes a DOB without touching the flag — is
        // repaired on its next edit instead of being unsaveable, since the edit form
        // resubmits the whole record.
        if (updateData.isDeclaredAdult === true && priorDob) {
            updateData.isDeclaredAdult = false;
        }

        const [updatedParticipant] = await prisma.$transaction([
            prisma.person.update({
                where: { id },
                data: updateData,
                include: {
                    household: true
                }
            }),
            prisma.auditLog.create({
                data: {
                    actorId: auth.user.id,
                    action: "EDIT",
                    tableName: "Person",
                    affectedEntityId: id,
                    oldData: prior,
                    newData: { ...updateData, ...(bgStaleWarning && { bgStaleWarning }) },
                },
            }),
        ]);
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
            household: updatedParticipant.household,
        };

        return NextResponse.json({ participant: formatted });
    } catch (error) {
        logger.error("Failed to update participant:", error);
        return apiError("Failed to update participant", 500);
    }
});
