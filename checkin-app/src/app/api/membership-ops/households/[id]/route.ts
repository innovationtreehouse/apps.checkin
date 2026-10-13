import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { upsertPrimaryContact, getPrimaryValidContact, EmergencyContactError } from "@/lib/emergencyContacts/service";
import { normalizeAddressInput, pickAddress, type StructuredAddress } from "@/lib/address";
import { apiError } from "@/lib/api-response";
import { refuseSelfGrant, SELF_GRANT_REFUSAL_MESSAGE } from "@/lib/membership/selfGrantGuard";

/**
 * Admin edit of a household's own info (name, address, emergency contact).
 *
 * Distinct from the participant-level "assign household" flow — this edits the
 * household record itself, on behalf of a member, using admin privileges. Gated
 * to isSysadmin + board, and every edit is written to the audit log with before/
 * after snapshots since the actor is not a member of the household they touch.
 */
export const PATCH = withAuth<{ params: Promise<{ id: string }> }>(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (request: NextRequest, auth, { params }) => {
    if (auth.type !== 'session') {
        return apiError("Unauthorized", 401);
    }

    try {
        const { id: idParam } = await params;
        const id = parseInt(idParam, 10);
        if (isNaN(id)) {
            return apiError("Invalid household ID", 400);
        }

        const existing = await prisma.household.findUnique({ where: { id } });
        if (!existing) {
            return apiError("Household not found", 404);
        }

        const body = await request.json();
        const data: { name?: string } & Partial<StructuredAddress> = {};
        if (body.name !== undefined) {
            if (typeof body.name !== "string" || !body.name.trim()) {
                return apiError("Household name cannot be empty", 400);
            }
            data.name = body.name.trim();
        }
        Object.assign(data, normalizeAddressInput(body));

        const editsContact = body.emergencyContactName !== undefined || body.emergencyContactPhone !== undefined;
        const editsHousehold = Object.keys(data).length > 0 || editsContact;

        // "Member since" lives on the household's Membership (1:1). Treat the date
        // as date-only: parse at UTC midnight and only act on a real change, so an
        // unchanged field re-sent by the form never writes a spurious audit row.
        // Both "member since" and the volunteer-only flag live on the household's
        // Membership (1:1); fetch it once if either is being edited.
        const editsMembership = (typeof body.memberSince === "string" && body.memberSince !== "") || typeof body.isVolunteer === "boolean";
        const membership = editsMembership ? await prisma.orgMembership.findUnique({ where: { householdId: id } }) : null;

        let memberSinceChange: { orgMembershipId: number; oldValue: Date; newValue: Date } | null = null;
        if (typeof body.memberSince === "string" && body.memberSince !== "") {
            const parsed = new Date(`${body.memberSince}T00:00:00.000Z`);
            if (isNaN(parsed.getTime())) {
                return apiError("Invalid member-since date", 400);
            }
            // Org didn't exist before this date, so no membership can predate it.
            if (parsed.getTime() < Date.UTC(2023, 10, 1)) {
                return apiError("Member-since cannot be before Nov 1, 2023", 400);
            }
            if (!membership) {
                return apiError("Household has no membership record", 400);
            }
            if (membership.memberSince.toISOString().slice(0, 10) !== body.memberSince) {
                memberSinceChange = { orgMembershipId: membership.id, oldValue: membership.memberSince, newValue: parsed };
            }
        }

        // Volunteer-only household: reduced-fee volunteer family, flagged on the membership.
        let isVolunteerChange: { orgMembershipId: number; oldValue: boolean; newValue: boolean } | null = null;
        if (typeof body.isVolunteer === "boolean") {
            if (!membership) {
                return apiError("Household has no membership record", 400);
            }
            if (membership.isVolunteer !== body.isVolunteer) {
                isVolunteerChange = { orgMembershipId: membership.id, oldValue: membership.isVolunteer, newValue: body.isVolunteer };
            }
        }

        // The volunteer flag discounts dues, so no actor may set it on their own household.
        if (isVolunteerChange && await refuseSelfGrant(prisma, auth.user.id, { householdId: id }, {
            table: "OrgMembership",
            attempted: { isVolunteer: isVolunteerChange.newValue },
        })) {
            return apiError(SELF_GRANT_REFUSAL_MESSAGE, 403);
        }

        if (!editsHousehold && !memberSinceChange && !isVolunteerChange) {
            return apiError("No fields to update provided", 400);
        }

        // Emergency contact is its own entity; the admin editor maps onto the
        // household's primary contact. Snapshot it before the change for the audit log.
        const priorContact = await getPrimaryValidContact(prisma, id);

        const updated = Object.keys(data).length > 0
            ? await prisma.household.update({ where: { id }, data })
            : existing;

        if (editsContact) {
            // Rejects (direction A) a contact who is a member of this household.
            await upsertPrimaryContact(prisma, id, { name: body.emergencyContactName, phone: body.emergencyContactPhone });
        }

        if (editsHousehold) {
            await prisma.auditLog.create({
                data: {
                    actorId: auth.user.id,
                    action: "EDIT",
                    tableName: "Household",
                    affectedEntityId: id,
                    oldData: {
                        name: existing.name,
                        ...pickAddress(existing),
                        emergencyContactName: priorContact?.name ?? null,
                        emergencyContactPhone: priorContact?.phone ?? null,
                    },
                    newData: { ...data, ...(editsContact && { emergencyContactName: body.emergencyContactName, emergencyContactPhone: body.emergencyContactPhone }) },
                }
            });
        }

        // Separate audit row for the membership edit — a legible before/after of the
        // join date on its own record, rather than folded into the Household row.
        if (memberSinceChange) {
            await prisma.orgMembership.update({
                where: { id: memberSinceChange.orgMembershipId },
                data: { memberSince: memberSinceChange.newValue },
            });
            await prisma.auditLog.create({
                data: {
                    actorId: auth.user.id,
                    action: "EDIT",
                    tableName: "OrgMembership",
                    affectedEntityId: memberSinceChange.orgMembershipId,
                    secondaryAffectedEntity: id,
                    oldData: { memberSince: memberSinceChange.oldValue },
                    newData: { memberSince: memberSinceChange.newValue },
                }
            });
        }

        if (isVolunteerChange) {
            await prisma.$transaction([
                prisma.orgMembership.update({
                    where: { id: isVolunteerChange.orgMembershipId },
                    data: { isVolunteer: isVolunteerChange.newValue },
                }),
                prisma.auditLog.create({
                    data: {
                        actorId: auth.user.id,
                        action: "EDIT",
                        tableName: "OrgMembership",
                        affectedEntityId: isVolunteerChange.orgMembershipId,
                        secondaryAffectedEntity: id,
                        oldData: { isVolunteer: isVolunteerChange.oldValue },
                        newData: { isVolunteer: isVolunteerChange.newValue },
                    }
                }),
            ]);
        }

        return NextResponse.json({ household: updated });
    } catch (error) {
        if (error instanceof EmergencyContactError) {
            return apiError(error.message, 400);
        }
        logger.error("Failed to update household:", error);
        return apiError("Failed to update household", 500);
    }
});
