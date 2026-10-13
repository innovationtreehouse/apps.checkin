import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { handler, notFound, unauthorized } from "@/security/handler";
import { isValidPhone, formatPhone, PHONE_ERROR } from "@/lib/phone";
import { isYouth } from "@/lib/time";
import { normalizeAdultDob } from "@/lib/person/adultDob";
import { nameWrite, nicknameWrite, isNicknameWrite } from "@/lib/person/name";
import { apiError } from "@/lib/api-response";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";

export const GET = handler('GET /api/profile', async ({ auth }) => {
    if (auth.type !== 'session') throw unauthorized();
    const profile = await prisma.person.findUnique({
        where: { id: auth.user.id },
        include: {
            visits: {
                where: { deletedAt: null },
                orderBy: { arrivedAt: 'desc' },
                take: 50,
                include: { event: true },
            },
        },
    });
    if (!profile) throw notFound('Profile not found');
    return { Person: profile };
});

export const PATCH = withAuth(
    {},
    async (req, auth) => {
        try {
            if (auth.type !== 'session') return apiError("Unauthorized", 401);
            const userId = auth.user.id;

            const me = await prisma.person.findUnique({
                where: { id: userId },
                select: { dateOfBirth: true },
            });
            if (isYouth(me?.dateOfBirth)) {
                return apiError("Youth profiles are read-only.", 403);
            }

            const body = await req.json();
            const { name, nickname, phone, dob, over25, notificationSettings, emailSuppressed } = body;

            if (phone !== undefined && phone !== "" && !isValidPhone(phone)) {
                return apiError(PHONE_ERROR, 400);
            }

            // A submitted-but-blank name is rejected, not silently dropped (Decision 5).
            if (name !== undefined && !nameWrite(name)) {
                return apiError("Name cannot be blank", 400);
            }

            if (!isNicknameWrite(nickname)) {
                return apiError("Invalid nickname", 400);
            }

            const updatedProfile = await prisma.person.update({
                where: { id: userId },
                data: {
                    name: nameWrite(name),
                    nickname: nicknameWrite(nickname),
                    phone: phone !== undefined ? (phone === "" ? null : formatPhone(phone)) : undefined,
                    // #1165: a self-entered DoB for a 26+ member is stripped and the
                    // over-25 flag set instead; with no DoB the over-25 checkbox owns
                    // the flag. Only touched when the profile form submits age fields,
                    // so notification-only PATCHes leave DoB/flag unchanged.
                    ...(dob !== undefined || over25 !== undefined
                        ? { ...normalizeAdultDob(dob || null), ...(dob ? {} : { isDeclaredAdult: !!over25 }) }
                        : {}),
                    notificationSettings: notificationSettings !== undefined ? notificationSettings : undefined,
                    emailSuppressed: emailSuppressed !== undefined ? !!emailSuppressed : undefined,
                },
                select: {
                    name: true,
                    nickname: true,
                    email: true,
                    phone: true,
                    dateOfBirth: true,
                    notificationSettings: true,
                    emailSuppressed: true,
                }
            });
            invalidateAttendanceCache();

            await prisma.auditLog.create({
                data: {
                    actorId: userId,
                    action: "EDIT",
                    tableName: "Person",
                    affectedEntityId: userId,
                    newData: updatedProfile,
                }
            });

            return NextResponse.json({ profile: updatedProfile }, { status: 200 });

        } catch (error) {
            logger.error("Profile PATCH Error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);
