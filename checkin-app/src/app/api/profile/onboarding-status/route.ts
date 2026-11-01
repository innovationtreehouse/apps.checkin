import { NextResponse } from 'next/server';
import { logger } from "@/lib/logger";
import prisma from '@/lib/prisma';
import { withAuth } from "@/lib/auth";
import { isYouth } from "@/lib/time";
import { apiError } from "@/lib/api-response";

export const GET = withAuth(
    {},
    async (_req, auth) => {
        if (auth.type !== 'session') return apiError("Unauthorized", 401);
        const userId = auth.user.id;

        try {
            const user = await prisma.person.findUnique({
                where: { id: userId },
                include: {
                    household: {
                        include: { emergencyContacts: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
                    },
                }
            });

            if (!user) {
                return apiError("Participant not found", 404);
            }

            // Youth are never required to provide a phone number
            const needsPhone = !user.phone && !isYouth(user.dateOfBirth);
            const isLead = user.isHouseholdLead;

            // A lead needs a contact when no valid (non-member, complete) one exists.
            const validContact = user.household?.emergencyContacts.find(
                (c) => c.conflictParticipantId === null && c.name.trim() && c.phone.trim(),
            );
            const primaryContact = user.household?.emergencyContacts[0];
            const needsEmergencyContact = isLead && !validContact;

            return NextResponse.json({
                phone: user.phone || "",
                needsPhone,
                isLead: Boolean(isLead),
                needsEmergencyContact: Boolean(needsEmergencyContact),
                emergencyContactName: primaryContact?.name || "",
                emergencyContactPhone: primaryContact?.phone || ""
            });
        } catch (error) {
            logger.error("Error checking onboarding status:", error);
            return apiError("Failed to check status", 500);
        }
    }
);
