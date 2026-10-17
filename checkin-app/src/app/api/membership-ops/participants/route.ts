import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { logBackendError } from "@/lib/logger";
import { addHouseholdLead, HouseholdLeadLimitError } from "@/lib/household/leads";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { normalizeAdultDob } from "@/lib/person/adultDob";
import { mintPersonId } from "@/lib/person/mintId";
import { nameWrite } from "@/lib/person/name";
import { withTx } from "@/lib/db-client";
import { apiError } from "@/lib/api-response";

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
                where: { email }
            });

            if (existingUser) {
                return NextResponse.json({ error: "A participant with this email already exists", fields: ["email"] }, { status: 409 });
            }
        }

        // Every participant must belong to a household, so resolve it before
        // creating: parent's household > explicitly provided household > a new
        // household of their own.
        let householdIdToAssign: number | null = null;

        if (parentEmail) {
            let parent = await prisma.person.findUnique({
                where: { email: parentEmail }
            });

            if (!parent) {
                // #1688: validate before the transaction opens — a 400 must not
                // hold the counter row lock.
                if (!parentName?.trim()) {
                    return apiError("Parent name is required when creating a new parent", 400);
                }
                const trimmedParentName = parentName.trim();
                const parentLastName = trimmedParentName.split(/\s+/).pop() || "";
                // No transaction in this route, so the mint gets a minimal one
                // paired with its create — an id minted outside would be burned
                // if the create failed. The household is created as its own
                // statement rather than nested: an explicit `id` is only
                // accepted in Prisma's *unchecked* create input, which has no
                // room for a nested relation create.
                parent = await withTx(prisma, async (tx) => {
                    const household = await tx.household.create({
                        data: { name: parentLastName ? `${parentLastName} Household` : "Household" }
                    });
                    return tx.person.create({
                        data: {
                            id: await mintPersonId(tx),
                            email: parentEmail,
                            name: trimmedParentName,
                            householdId: household.id,
                        }
                    });
                });
                await addHouseholdLead(prisma, parent.householdId, parent.id);
            }

            householdIdToAssign = parent.householdId;
        } else if (householdId) {
            householdIdToAssign = householdId;
        }

        let newParticipant;
        if (householdIdToAssign) {
            newParticipant = await withTx(prisma, async (tx) => tx.person.create({
                data: {
                    id: await mintPersonId(tx),
                    name: nameWrite(name),
                    ...(email && { email }),
                    // #1165: 26+ participants are stored declared-adult with no DoB.
                    ...normalizeAdultDob(dob),
                    householdId: householdIdToAssign
                }
            }));
        } else {
            const lastName = (name || "").trim().split(/\s+/).pop() || "";
            newParticipant = await withTx(prisma, async (tx) => {
                const household = await tx.household.create({
                    data: { name: lastName ? `${lastName} Household` : "Household" }
                });
                return tx.person.create({
                    data: {
                        id: await mintPersonId(tx),
                        name: nameWrite(name),
                        ...(email && { email }),
                        // #1165: 26+ participants are stored declared-adult with no DoB.
                        ...normalizeAdultDob(dob),
                        householdId: household.id,
                    }
                });
            });

            await addHouseholdLead(prisma, newParticipant.householdId, newParticipant.id);
        }

        return NextResponse.json({ success: true, participant: newParticipant });
    } catch (error: unknown) {
        if (error instanceof HouseholdLeadLimitError) {
            return apiError(error.message, 400);
        }
        await logBackendError(error, "POST /api/membership-ops/participants");
        return apiError(`Failed to create participant`, 500);
    }
});
