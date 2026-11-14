import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { createContact, listContacts, present, EmergencyContactError } from "@/lib/emergencyContacts/service";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { leadHousehold } from "@/lib/household/leads";
import { apiError } from "@/lib/api-response";
import { ArchivedHouseholdError } from "@/lib/household/archiveGuard";

export const GET = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const hh = await leadHousehold(auth.user.id);
    if (typeof hh !== "number") return apiError(hh.error, hh.status);
    const contacts = await listContacts(prisma, hh);
    return NextResponse.json({ contacts: contacts.map(present) });
});

export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const hh = await leadHousehold(auth.user.id);
    if (typeof hh !== "number") return apiError(hh.error, hh.status);

    try {
        const { name, phone, email, relationship, priority } = await req.json();
        if (email && !isValidEmail(email)) {
            return apiError("Invalid email format", 400);
        }
        const contact = await createContact(prisma, hh, { name, phone, email, relationship, priority });
        await prisma.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: "CREATE",
                tableName: "EmergencyContact",
                affectedEntityId: contact.id,
                secondaryAffectedEntity: hh,
                newData: { name: contact.name, phone: contact.phone },
            },
        });
        return NextResponse.json({ contact: present(contact) }, { status: 201 });
    } catch (error) {
        if (error instanceof EmergencyContactError) return apiError(error.message, 400);
        if (error instanceof ArchivedHouseholdError) return apiError(error.message, error.status);
        logger.error("Emergency contact POST error:", error);
        return apiError("Internal Server Error", 500);
    }
});
