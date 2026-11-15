import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { updateContact, deleteContact, present, EmergencyContactError } from "@/lib/emergencyContacts/service";
import { leadHousehold } from "@/lib/household/leads";
import { apiError } from "@/lib/api-response";

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
        if (error instanceof EmergencyContactError) {
            return apiError(error.message, error.code === "not_found" ? 404 : 400);
        }
        logger.error("Emergency contact DELETE error:", error);
        return apiError("Internal Server Error", 500);
    }
});
