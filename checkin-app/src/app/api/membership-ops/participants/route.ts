import { NextResponse } from "next/server";
import { orgToday } from "@/lib/appSettings";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { logBackendError } from "@/lib/logger";
import { HouseholdLeadLimitError } from "@/lib/household/leads";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { AGE_REQUIRED_REFUSAL, normalizeAdultDob } from "@/lib/person/adultDob";
import { mintPersonId } from "@/lib/person/mintId";
import { nameWrite } from "@/lib/person/name";
import { createInOwnHousehold } from "@/lib/person/ownHousehold";
import { removeAliasesForSignInEmail } from "@/lib/person/mailAliases";
import { personActor } from "@/lib/auditActor";
import { type DbClient, withTx } from "@/lib/db-client";
import { apiError } from "@/lib/api-response";
import { normalizeEmail } from "@/lib/prismaEmailNormalize";
import { findSelfGrantRefusal, recordSelfGrantRefusal, type SelfGrantRefusal } from "@/lib/membership/selfGrantGuard";
import { lockBoardRoles } from "@/lib/roles";
import { lockAndFindDeniedHousehold, raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";
import { ArchivedHouseholdError, lockLiveHouseholds } from "@/lib/household/archiveGuard";
import { TREEHOUSE_HOUSEHOLD_REFUSAL, TREEHOUSE_SIGN_IN_REFUSAL, TreehouseHouseholdError, isTreehouseHousehold, joinsWithTreehouseSignIn } from "@/lib/household/treehouseAccount";
import { isOrgAccount } from "@/lib/orgAccount";

/** The household the person would join is DENIED. */
class DeniedHouseholdAddError extends Error {
    constructor(public readonly householdId: number) {
        super(`household ${householdId} is denied`);
    }
}

/** The actor is in the household the person would join, found under its lock; recorded after the rollback. */
class SelfGrantAddError extends Error {
    constructor(public readonly refusal: SelfGrantRefusal) {
        super("own household");
    }
}

const OWN_HOUSEHOLD_ADD = "You cannot add someone to your own household — someone outside your household must.";

export const POST = withAuth({ roles: ['isSysadmin', 'isBoardMember'] }, async (req, auth) => {
    if (auth.type !== 'session') {
        return apiError("Unauthorized", 401);
    }

    try {
        const body = await req.json();
        const { name, email, parentEmail, parentName, parentDob, parentOver25, dob, over25, householdId } = body;

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

        if (!dob && !over25) {
            return NextResponse.json({ error: AGE_REQUIRED_REFUSAL, fields: ["dob"] }, { status: 400 });
        }

        // A Treehouse sign-in stays in a household of its own.
        if ((parentEmail || householdId) && joinsWithTreehouseSignIn(email)) {
            return NextResponse.json({ error: TREEHOUSE_SIGN_IN_REFUSAL, fields: ["email"] }, { status: 409 });
        }

        // A Treehouse account parent would make the participant a member of its household.
        if (parentEmail && isOrgAccount({ email: parentEmail })) {
            return NextResponse.json({ error: TREEHOUSE_HOUSEHOLD_REFUSAL, fields: ["parentEmail"] }, { status: 409 });
        }

        // Every participant must belong to a household, so resolve it before
        // creating: parent's household > explicitly provided household > a new
        // household of their own.
        let householdIdToAssign: number | null = null;
        // Set when the person joins a household that already existed before this request.
        let joinsExistingHousehold = false;

        const today = await orgToday();
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
                if (!parentDob && !parentOver25) {
                    return NextResponse.json({ error: AGE_REQUIRED_REFUSAL, fields: ["parentDob"] }, { status: 400 });
                }
                parent = await withTx(prisma, async (tx) => {
                    await removeAliasesForSignInEmail(tx, parentEmail, personActor(auth.user.id), "participant_add");
                    return createInOwnHousehold(tx, { email: parentEmail, name: parentName.trim(), ...normalizeAdultDob(parentDob, today, !!parentOver25) });
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
        const joinAttempt = { table: "Person" as const, attempted: { householdId: householdIdToAssign, name: nameWrite(name) ?? null } };
        const ownHouseholdRefusal = (db: DbClient, householdId: number) =>
            joinsExistingHousehold ? findSelfGrantRefusal(db, auth.user.id, { householdId }, joinAttempt) : Promise.resolve(null);
        const selfGrant = householdIdToAssign ? await ownHouseholdRefusal(prisma, householdIdToAssign) : null;
        if (selfGrant) {
            await recordSelfGrantRefusal(prisma, selfGrant);
            return apiError(OWN_HOUSEHOLD_ADD, 403);
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
                await lockLiveHouseholds(tx, [targetHouseholdId]);
                if (await isTreehouseHousehold(tx, targetHouseholdId)) throw new TreehouseHouseholdError();
                // Re-read under the Household lock, so an actor who joined the household since the check above is refused.
                const lockedRefusal = await ownHouseholdRefusal(tx, targetHouseholdId);
                if (lockedRefusal) throw new SelfGrantAddError(lockedRefusal);
                if (email) await removeAliasesForSignInEmail(tx, email, personActor(auth.user.id), "participant_add");
                return tx.person.create({
                    data: {
                        id: await mintPersonId(tx),
                        name: nameWrite(name),
                        ...(email && { email }),
                        ...normalizeAdultDob(dob, today, !!over25),
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
                    ...normalizeAdultDob(dob, today, !!over25),
                });
            });
        }

        return NextResponse.json({ success: true, participant: newParticipant });
    } catch (error: unknown) {
        if (error instanceof SelfGrantAddError) {
            await recordSelfGrantRefusal(prisma, error.refusal);
            return apiError(OWN_HOUSEHOLD_ADD, 403);
        }
        if (error instanceof HouseholdLeadLimitError) {
            return apiError(error.message, 400);
        }
        if (error instanceof ArchivedHouseholdError || error instanceof TreehouseHouseholdError) {
            return apiError(error.message, error.status);
        }
        if (error instanceof DeniedHouseholdAddError) {
            await raiseDeniedHouseholdActivity({ householdId: error.householdId, what: "participant add refused" });
            return apiError("This household has been denied membership, so no one can be added to it.", 409);
        }
        await logBackendError(error, "POST /api/membership-ops/participants");
        return apiError(`Failed to create participant`, 500);
    }
});
