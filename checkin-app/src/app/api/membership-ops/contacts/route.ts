import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { withAuth } from "@/lib/auth";
import { createParticipantWithHousehold } from "@/lib/auth-options";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { normalizeEmail } from "@/lib/prismaEmailNormalize";
import { LIVE_PERSON } from "@/lib/person/filters";
import { logBackendError } from "@/lib/logger";
import { apiError } from "@/lib/api-response";

// Email-only contact creation for Board + Operations. Sysadmin is deliberately
// EXCLUDED (Jeff's decision; same board-only shape as Finance Ops #1083) — do
// NOT add 'isSysadmin' here.
export const POST = withAuth({ roles: ['isBoardMember', 'isOperations'] }, async (req, auth) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    try {
        const { name, email } = await req.json();

        if (!name || typeof name !== 'string' || !name.trim()) return apiError("Name is required", 400);
        if (!email || !isValidEmail(email)) return apiError("A valid email is required", 400);

        // Dup check MUST normalize the key the same way the write extension lowercases
        // (prismaEmailNormalize.ts) — else a case-variant misses here and 500s on the
        // @unique constraint instead of returning this owner-named 409.
        const existing = await prisma.person.findUnique({
            where: { email: normalizeEmail(email) },
            select: { name: true },
        });
        // Deliberate, not a leak: every caller role here (board + operations) is
        // already trusted with a people/search view that includes name+email —
        // board sees the full directory, and ops's stripped view (no background-check
        // dates, no membership/finance standing) still surfaces name+email for every
        // record. The 409 reveals nothing either caller couldn't already query.
        // Flagged for future audits — do not redact.
        if (existing) {
            return NextResponse.json(
                { error: `This email already belongs to ${existing.name ?? 'an existing account'}`, fields: ["email"] },
                { status: 409 },
            );
        }

        const person = await createParticipantWithHousehold({ name: name.trim(), email });

        await prisma.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: "CREATE",
                tableName: "Person",
                affectedEntityId: person.id,
                secondaryAffectedEntity: person.householdId,
                newData: { name: person.name, email: person.email },
            },
        });

        // Re-fetch with household (+ its members) included so the client's
        // optimistic prepend can render immediately, without a full-list refetch.
        // The client's HouseholdRef type requires householdMembers — a bare
        // `include: { household: true }` returns household scalars only and
        // TypeErrors the Assign-household render path on the new row.
        const participant = await prisma.person.findUnique({
            where: { id: person.id },
            include: { household: { include: { householdMembers: { where: LIVE_PERSON, select: { id: true, name: true, email: true } } } } },
        });

        return NextResponse.json({ success: true, participant });
    } catch (error) {
        // The dup check above is TOCTOU-racy (two concurrent creates for the same
        // email can both pass it); the @unique constraint is the real guard, so a
        // P2002 here gets the same owner-named-style 409 as the pre-check catch,
        // not a generic 500.
        if (isPrismaError(error, "P2002")) {
            return NextResponse.json(
                { error: "This email already belongs to an existing account", fields: ["email"] },
                { status: 409 },
            );
        }
        await logBackendError(error, "POST /api/membership-ops/contacts");
        return apiError("Failed to create contact", 500);
    }
});
