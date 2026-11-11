import { NextResponse } from 'next/server';
import { logger } from "@/lib/logger";
import prisma from '@/lib/prisma';
import { withAuth } from "@/lib/auth";
import { upsertPrimaryContact, EmergencyContactError } from "@/lib/emergencyContacts/service";
import { isValidPhone, formatPhone, PHONE_ERROR } from "@/lib/phone";
import { apiError } from "@/lib/api-response";
import { isYouth } from "@/lib/time";

export const POST = withAuth(
    {},
    async (req, auth) => {
        if (auth.type !== 'session') return apiError("Unauthorized", 401);
        const userId = auth.user.id;

        try {
            const body = await req.json();
            const { phone, emergencyContactName, emergencyContactPhone, emergencyContactEmail } = body;

            const user = await prisma.person.findUnique({
                where: { id: userId },
                select: { householdId: true, isHouseholdLead: true, dateOfBirth: true }
            });

            if (!user) {
                return apiError("User not found", 404);
            }
            if (phone !== undefined) {
                if (isYouth(user.dateOfBirth)) {
                    return apiError("Youth profiles are read-only.", 403);
                }
                if (phone !== "" && !isValidPhone(phone)) {
                    return apiError(PHONE_ERROR, 400);
                }
                await prisma.person.update({
                    where: { id: userId },
                    data: { phone: phone === "" ? null : formatPhone(phone) }
                });
            }

            const isLead = user.isHouseholdLead;
            if (isLead && user.householdId && (emergencyContactName !== undefined || emergencyContactPhone !== undefined || emergencyContactEmail !== undefined)) {
                // Emergency contact is a separate entity; onboarding edits the
                // household's primary contact. Rejects a member as the contact.
                await upsertPrimaryContact(prisma, user.householdId, {
                    name: emergencyContactName,
                    phone: emergencyContactPhone,
                    email: emergencyContactEmail,
                });
            }

            return NextResponse.json({ success: true });
        } catch (error) {
            if (error instanceof EmergencyContactError) {
                return apiError(error.message, 400);
            }
            logger.error("Error saving onboarding details:", error);
            return apiError("Failed to save data", 500);
        }
    }
);
