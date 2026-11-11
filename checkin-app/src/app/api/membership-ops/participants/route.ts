import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { logBackendError } from "@/lib/logger";
import { HouseholdLeadLimitError } from "@/lib/household/leads";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { normalizeAdultDob } from "@/lib/person/adultDob";
import { mintPersonId } from "@/lib/person/mintId";
import { nameWrite } from "@/lib/person/name";
import { createInOwnHousehold } from "@/lib/person/ownHousehold";
import { removeAliasesForSignInEmail } from "@/lib/person/mailAliases";
import { personActor } from "@/lib/auditActor";
import { withTx } from "@/lib/db-client";
import { apiError } from "@/lib/api-response";
import { normalizeEmail } from "@/lib/prismaEmailNormalize";
import { refuseSelfGrant } from "@/lib/membership/selfGrantGuard";
import { lockBoardRoles } from "@/lib/roles";
import { lockAndFindDeniedHousehold, raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";

/** The household the person would join is DENIED. */
class DeniedHouseholdAddError extends Error {
    constructor(public readonly householdId: number) {
        super(`household ${householdId} is denied`);
    }
}

export const POST = withAuth({ roles: ['isSysadmin', 'isBoardMember'] }, async (req, auth) => {
    if (auth.type !== 'session') {
        return apiError("Unauthorized", 401);
    }

    try {
        const body = await req.json();
        const { name, email, parentEmail, parentName, dob, householdId } = body;

        // Creating a participant never creates an OrgMembership: membership comes
        // only from an application or a board Grant, both of which require a
        // background check.
        if (body.alreadyMember) {
            return apiError("alreadyMember is not supported; use Grant to give a household membership", 400);
        }

        if (!email && !parentEmail && !householdId) {
            return apiError("Email, Parent Email, or Household assignment is required", 400);
        }

        if (!nameWrite(name)) {
            return apiError("Name is required", 400);
        }

        if (email && !isValidEmail(email)) {
             return apiError("Invalid email format", 400);
        }

        if (parentEmail && !isValidEmail(parentEmail)) {
             return apiError("Invalid parent email format", 400);
        }

        if (email) {
            const existingUser = await prisma.person.findUnique({
                where: { email: normalizeEmail(email) }
            });

            if (existingUser) {
                return NextResponse.json({ error: "A participant with this email already exists", fields: ["email"] }, { status: 409 });
            }
        }

        // Every participant must belong to a household, so resolve it before
        // creating: parent's household > explicitly provided household > a new
        // household of their own.
        let householdIdToAssign: number | null = null;
        // Set when the person joins a household that already existed before this request.
        let joinsExistingHousehold = false;

        if (parentEmail) {
            // Reads are not normalized by the client extension, so a case variant of a
            // stored address must still find that parent and their household.
            let parent = await prisma.person.findUnique({
                where: { email: normalizeEmail(parentEmail) }
            });

            if (!parent) {
                // Validate before the transaction opens — a 400 must not
                // hold the counter row lock.
                if (!parentName?.trim()) {
                    return apiError("Parent name is required when creating a new parent", 400);
                }
                parent = await withTx(prisma, async (tx) => {
                    await removeAliasesForSignInEmail(tx, parentEmail, personActor(auth.user.id), "participant_add");
                    return createInOwnHousehold(tx, { email: parentEmail, name: parentName.trim() });
                });
            } else {
                joinsExistingHousehold = true;
            }

            householdIdToAssign = parent.householdId;
        } else if (householdId) {
            householdIdToAssign = householdId;
            joinsExistingHousehold = true;
        }

        // Adding someone to the actor's own household would get around the own-household
        // rule on grants, since an active household's members are members.
        if (joinsExistingHousehold && householdIdToAssign && await refuseSelfGrant(prisma, auth.user.id, { householdId: householdIdToAssign }, {
            table: "Person",
            attempted: { householdId: householdIdToAssign, name: nameWrite(name) ?? null },
        })) {
            return apiError("You cannot add someone to your own household — someone outside your household must.", 403);
        }

        let newParticipant;
        if (householdIdToAssign) {
            const targetHouseholdId = householdIdToAssign;
            newParticipant = await withTx(prisma, async (tx) => {
                // Nobody joins a DENIED household. The BOARD lock comes first, as a deny
                // takes it, so a deny of this household serializes with the add.
                await lockBoardRoles(tx);
                if (await lockAndFindDeniedHousehold(tx, [targetHouseholdId]) !== null) {
                    throw new DeniedHouseholdAddError(targetHouseholdId);
                }
                if (email) await removeAliasesForSignInEmail(tx, email, personActor(auth.user.id), "participant_add");
                return tx.person.create({
                    data: {
                        id: await mintPersonId(tx),
                        name: nameWrite(name),
                        ...(email && { email }),
                        ...normalizeAdultDob(dob),
                        householdId: targetHouseholdId
                    }
                });
            });
        } else {
            newParticipant = await withTx(prisma, async (tx) => {
                if (email) await removeAliasesForSignInEmail(tx, email, personActor(auth.user.id), "participant_add");
                return createInOwnHousehold(tx, {
                    name: nameWrite(name)!,
                    ...(email && { email }),
                    ...normalizeAdultDob(dob),
                });
            });
        }

        return NextResponse.json({ success: true, participant: newParticipant });
    } catch (error: unknown) {
        if (error instanceof HouseholdLeadLimitError) {
            return apiError(error.message, 400);
        }
        if (error instanceof DeniedHouseholdAddError) {
            await raiseDeniedHouseholdActivity({ householdId: error.householdId, what: "participant add refused" });
            return apiError("This household has been denied membership, so no one can be added to it.", 409);
        }
        await logBackendError(error, "POST /api/membership-ops/participants");
        return apiError(`Failed to create participant`, 500);
    }
});
