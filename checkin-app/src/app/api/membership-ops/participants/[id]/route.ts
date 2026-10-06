import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { isValidPhone, formatPhone, PHONE_ERROR } from "@/lib/phone";
import { nameWrite, nicknameWrite, isNicknameWrite } from "@/lib/person/name";
import { apiError } from "@/lib/api-response";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";

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
        if (body.lastBackgroundCheck !== undefined) {
            // "" or null clears the date; otherwise expect a YYYY-MM-DD string
            const raw = body.lastBackgroundCheck;
            if (raw === "" || raw === null) {
                updateData.lastBackgroundCheck = null;
            } else {
                const d = new Date(raw);
                if (isNaN(d.getTime())) {
                    return apiError("Invalid background check review date", 400);
                }
                updateData.lastBackgroundCheck = d;
            }
        }

        if (Object.keys(updateData).length === 0) {
            return apiError("No fields to update provided", 400);
        }

        // dateOfBirth is read for the guard below but deliberately kept out of the
        // audit payload — this route neither ships nor writes it.
        const { dateOfBirth: priorDob, ...prior } = (await prisma.person.findUnique({
            where: { id },
            select: { name: true, nickname: true, email: true, phone: true, dateOfBirth: true, isDeclaredAdult: true, lastBackgroundCheck: true },
        })) ?? {};

        // A date of birth on file supersedes the over-25 declaration (normalizeAdultDob):
        // a person has one or the other, never both. Coerced rather than refused so a row
        // that holds both — bulk import writes a DOB without touching the flag — is
        // repaired on its next edit instead of being unsaveable, since the edit form
        // resubmits the whole record.
        if (updateData.isDeclaredAdult === true && priorDob) {
            updateData.isDeclaredAdult = false;
        }

        const updatedParticipant = await prisma.person.update({
            where: { id },
            data: updateData,
            include: {
                household: true
            }
        });
        // Name, DOB/adult and keyholder fields all feed the live roster.
        invalidateAttendanceCache();

        await prisma.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: "EDIT",
                tableName: "Person",
                affectedEntityId: id,
                oldData: prior,
                newData: updateData,
            },
        });

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
