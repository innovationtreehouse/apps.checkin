import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { upsertPrimaryContact, EmergencyContactError } from "@/lib/emergencyContacts/service";
import { normalizeAddressInput, pickAddress, assertValidAddress, AddressValidationError } from "@/lib/address";
import { apiError } from "@/lib/api-response";

export const PATCH = withAuth(
    {},
    async (req, auth) => {
        try {
            if (auth.type !== 'session') return apiError("Unauthorized", 401);
            const userId = auth.user.id;

            const body = await req.json();
            const { emergencyContactName, emergencyContactPhone, notes } = body;
            const addressData = normalizeAddressInput(body);
            // Address is optional on this route (emergency-contact-only PATCHes
            // send no address keys); when any address field is supplied, the
            // whole address must be complete + valid.
            if (Object.keys(addressData).length > 0) assertValidAddress(addressData);
            // Optional "anything else we should know?" note rides along on the same
            // household.update. Trimmed to null so an emptied box clears it; only
            // touched when the key is present.
            const householdData = {
                ...addressData,
                ...(notes !== undefined && { intakeNotes: typeof notes === "string" && notes.trim() ? notes.trim() : null }),
            };

            const user = await prisma.person.findUnique({
                where: { id: userId },
                select: { householdId: true, isHouseholdLead: true, isSysadmin: true }
            });

            if (!user || !user.householdId) {
                return apiError("Household not found", 404);
            }

            if (!user.isHouseholdLead && !user.isSysadmin) {
                return apiError("Only household leads can edit household settings", 403);
            }

            const updatedHousehold = await prisma.household.update({
                where: { id: user.householdId },
                data: householdData,
            });

            // Emergency contact is a separate entity; the settings form edits the
            // household's primary contact. Rejects a contact who is a member.
            if (emergencyContactName !== undefined || emergencyContactPhone !== undefined) {
                await upsertPrimaryContact(prisma, user.householdId, {
                    name: emergencyContactName,
                    phone: emergencyContactPhone,
                });
            }

            await prisma.auditLog.create({
                data: {
                    actorId: userId,
                    action: "EDIT",
                    tableName: "Household",
                    affectedEntityId: user.householdId,
                    newData: { emergencyContactName, emergencyContactPhone, ...pickAddress(updatedHousehold) }
                }
            });

            // Only a lead reads the note back, matching GET /api/household.
            const household = user.isHouseholdLead ? updatedHousehold : { ...updatedHousehold, intakeNotes: null };
            return NextResponse.json({ household }, { status: 200 });

        } catch (error: unknown) {
            if (error instanceof EmergencyContactError || error instanceof AddressValidationError) {
                return apiError(error.message, 400);
            }
            logger.error("Household Settings PATCH Error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);
