import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { updateContact, deleteContact, present, EmergencyContactError } from "@/lib/emergencyContacts/service";
import { leadHousehold } from "@/lib/household/leads";
import { apiError } from "@/lib/api-response";
import { ArchivedHouseholdError } from "@/lib/household/archiveGuard";

export const PATCH = withAuth({}, async (req, auth, { params }: { params: Promise<{ contactId: string }> }) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const hh = await leadHousehold(auth.user.id);
    if (typeof hh !== "number") return apiError(hh.error, hh.status);
    const contactId = parseInt((await params).contactId, 10);
    if (isNaN(contactId)) return apiError("Invalid contact id", 400);

    try {
        const { name, phone, email, relationship, priority } = await req.json();
        const contact = await updateContact(prisma, hh, contactId, { name, phone, email, relationship, priority });
        await prisma.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: "EDIT",
                tableName: "EmergencyContact",
                affectedEntityId: contact.id,
                secondaryAffectedEntity: hh,
                newData: { name: contact.name, phone: contact.phone },
            },
        });
        // present(): same wire shape as GET/POST — never the raw row (internal
        // createdAt/updatedAt + conflict bookkeeping don't belong on the wire).
        return NextResponse.json({ contact: present(contact) });
    } catch (error) {
        if (error instanceof ArchivedHouseholdError) return apiError(error.message, error.status);
        if (error instanceof EmergencyContactError) {
            return apiError(error.message, error.code === "not_found" ? 404 : 400);
        }
        logger.error("Emergency contact PATCH error:", error);
        return apiError("Internal Server Error", 500);
    }
});

export const DELETE = withAuth({}, async (_req, auth, { params }: { params: Promise<{ contactId: string }> }) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const hh = await leadHousehold(auth.user.id);
    if (typeof hh !== "number") return apiError(hh.error, hh.status);
    const contactId = parseInt((await params).contactId, 10);
    if (isNaN(contactId)) return apiError("Invalid contact id", 400);

    try {
        // A household must never be left without a valid emergency contact: block
        // removing a valid contact unless another valid one is already on file.
        // (Removing an already-invalid contact is always allowed — it doesn't drop
        // the valid count, and lets a household clean up a flagged row.)
        const target = await prisma.emergencyContact.findFirst({ where: { id: contactId, householdId: hh } });
        if (!target) return apiError("Emergency contact not found.", 404);
        const targetIsValid = target.conflictParticipantId === null && !!target.name.trim() && !!target.phone.trim();
        if (targetIsValid) {
            const otherValid = await prisma.emergencyContact.count({
                where: { householdId: hh, id: { not: contactId }, conflictParticipantId: null, name: { not: "" }, phone: { not: "" } },
            });
            if (otherValid === 0) {
                return apiError("Add a second emergency contact before removing this one — your household must always have at least one valid emergency contact.", 400);
            }
        }

        await deleteContact(prisma, hh, contactId);
        await prisma.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: "DELETE",
                tableName: "EmergencyContact",
                affectedEntityId: contactId,
                secondaryAffectedEntity: hh,
            },
        });
        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof ArchivedHouseholdError) return apiError(error.message, error.status);
        if (error instanceof EmergencyContactError) {
            return apiError(error.message, error.code === "not_found" ? 404 : 400);
        }
        logger.error("Emergency contact DELETE error:", error);
        return apiError("Internal Server Error", 500);
    }
});
