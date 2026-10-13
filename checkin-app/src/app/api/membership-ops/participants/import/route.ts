import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import * as xlsx from "xlsx";
import { logBackendError, logger } from "@/lib/logger";
import { addHouseholdLead, HouseholdLeadLimitError, MAX_HOUSEHOLD_LEADS } from "@/lib/household/leads";
import { parseImportDob } from "@/lib/importDob";
import { calculateAge } from "@/lib/time";
import { withTx, type DbClient } from "@/lib/db-client";
import { apiError } from "@/lib/api-response";
import { LIVE_PERSON } from "@/lib/person/filters";
import { mintPersonId } from "@/lib/person/mintId";
import { resolveActorHouseholdId, sharesHousehold } from "@/lib/conflictOfInterest";

export const POST = withAuth({ roles: ['isSysadmin', 'isBoardMember'] }, async (req: NextRequest, auth) => {
    try {
        if (auth.type !== 'session') {
            return apiError("Unauthorized", 401);
        }

        // Household merges below may not touch the actor's own household (see the
        // own-household rule in lib/roles.ts); resolved once, fail closed.
        const actorHouseholdId = await resolveActorHouseholdId(prisma, auth.user.id);
        if (actorHouseholdId === null) {
            return apiError("Forbidden", 403);
        }

        const formData = await req.formData();
        const file = formData.get("file") as File;

        if (!file) {
            return apiError("No file provided", 400);
        }

        const buffer = await file.arrayBuffer();
        const workbook = xlsx.read(buffer, { type: "buffer" });

        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        const rawData = xlsx.utils.sheet_to_json(worksheet, { header: 1 }) as unknown[][];

        if (rawData.length < 2) {
            return apiError("Empty spreadsheet or no data rows found", 400);
        }

        const headers = rawData[0].map((h: unknown) => String(h).trim().toLowerCase());
        const rows = rawData.slice(1);

        const emailIndex = headers.findIndex(h => h.includes("email") && !h.includes("parent") && !h.includes("household"));
        const parentEmailIndex = headers.findIndex(h => h.includes("parent email"));
        const firstNameIndex = headers.findIndex(h => h.includes("first name"));
        const lastNameIndex = headers.findIndex(h => h.includes("last name"));
        const dobIndex = headers.findIndex(h => h.includes("dob") || h.includes("date of birth"));
        const addressIndex = headers.findIndex(h => h.includes("address"));
        const sameHouseholdIndex = headers.findIndex(h => h.includes("same household as"));

        if (firstNameIndex === -1 || lastNameIndex === -1) {
            return apiError("Missing required 'First Name' or 'Last Name' columns.", 400);
        }

        let insertedOrUpdatedCount = 0;
        const errors: string[] = [];

        // Helper: look up a participant's household. Every participant has one
        // (householdId is a required FK).
        const ensureHousehold = async (participantId: number, db: DbClient = prisma): Promise<number> => {
            const participant = await db.person.findUnique({ where: { id: participantId } });
            if (!participant) throw new Error(`Participant ${participantId} not found`);
            return participant.householdId;
        };

        // Helper: create a participant together with their own new household.
        // Adults (no DOB, or 18+) lead the household.
        const createParticipantWithHousehold = async (data: {
            email?: string;
            name: string;
            dob?: Date;
            address?: string;
        }, db: DbClient = prisma) => {
            const isAdult = !data.dob || calculateAge(data.dob) >= 18;
            // withTx joins the caller's transaction when `db` is one (pass 1) and
            // opens its own when it's the root client, so the mint and the create
            // are always in the same transaction either way. The household is its
            // own statement rather than a nested create: an explicit `id` is only
            // accepted in Prisma's *unchecked* create input, which has no room
            // for a nested relation create.
            const participant = await withTx(db, async (tx) => {
                const household = await tx.household.create({
                    data: {
                        name: `${data.name}'s Household`,
                        ...(data.address && { address: data.address }),
                    }
                });
                return tx.person.create({
                    data: {
                        id: await mintPersonId(tx),
                        ...(data.email && { email: data.email }),
                        name: data.name,
                        dateOfBirth: data.dob,
                        householdId: household.id,
                    }
                });
            });
            if (isAdult) {
                await addHouseholdLead(db, participant.householdId, participant.id);
            }
            return participant;
        };

        // Helper: addresses live on the household, not the participant.
        // A CSV address overwrites the row's household address when provided.
        // ponytail: legacy CSV has one free-text address column → goes to line1
        // verbatim. Bulk import is being redone; structured columns land then.
        const applyAddressToHousehold = async (householdId: number, address: string, db: DbClient = prisma) => {
            if (!address) return;
            await db.household.update({
                where: { id: householdId },
                data: { line1: address }
            });
        };

        // Helper: ensure an active household membership exists for a household
        const ensureHouseholdMembership = async (
            householdId: number,
            db: DbClient = prisma,
        ) => {
            await db.orgMembership.upsert({
                where: { householdId },
                create: { householdId, status: 'ACTIVE' },
                update: { status: 'ACTIVE' },
            });
        };

        // Parse all rows first
        interface ParsedRow {
            index: number;
            firstName: string;
            lastName: string;
            fullName: string;
            email: string;
            parentEmail: string;
            parsedDob?: Date;
            address: string;
            sameHouseholdAs: string;
        }

        const parsedRows: ParsedRow[] = [];
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const firstName = row[firstNameIndex]?.toString().trim() || "";
            const lastName = row[lastNameIndex]?.toString().trim() || "";
            const email = emailIndex !== -1 ? row[emailIndex]?.toString().trim() : "";
            const parentEmail = parentEmailIndex !== -1 ? row[parentEmailIndex]?.toString().trim() : "";
            const dobString = dobIndex !== -1 ? row[dobIndex]?.toString().trim() : "";
            const address = addressIndex !== -1 ? row[addressIndex]?.toString().trim() : "";
            const sameHouseholdAs = sameHouseholdIndex !== -1 ? row[sameHouseholdIndex]?.toString().trim() : "";

            if (!firstName && !lastName) continue;

            if (email && !emailRegex.test(email)) {
                errors.push(`Row ${i + 2} (${firstName} ${lastName}): Invalid email format`);
                continue;
            }

            if (parentEmail && !emailRegex.test(parentEmail)) {
                errors.push(`Row ${i + 2} (${firstName} ${lastName}): Invalid parent email format`);
                continue;
            }

            const parsedDob = parseImportDob(dobString);

            parsedRows.push({
                index: i,
                firstName,
                lastName,
                fullName: `${firstName} ${lastName}`.trim(),
                email: email || "",
                parentEmail: parentEmail || "",
                parsedDob,
                address: address || "",
                sameHouseholdAs: sameHouseholdAs || "",
            });
        }

        // ===== PASS 1: Create/update all participants (no household linking yet) =====
        // Track created participant IDs by email and name for pass 2
        const participantByEmail = new Map<string, number>(); // email -> participantId
        const participantByName = new Map<string, number>(); // lowercase name -> participantId

        for (const pr of parsedRows) {
            try {
                // Each row's writes run in one transaction so a row either fully
                // lands or fully rolls back — no half-linked participants left behind.
                const participantId = await prisma.$transaction(async (tx) => {
                    let participantId: number;

                    if (pr.email) {
                        let participant = await tx.person.findUnique({ where: { email: pr.email } });
                        if (participant) {
                            participant = await tx.person.update({
                                where: { id: participant.id },
                                data: {
                                    name: pr.fullName,
                                    dateOfBirth: pr.parsedDob ?? participant.dateOfBirth,
                                }
                            });
                            await applyAddressToHousehold(participant.householdId, pr.address, tx);
                        } else {
                            participant = await createParticipantWithHousehold({
                                email: pr.email,
                                name: pr.fullName,
                                dob: pr.parsedDob,
                                address: pr.address,
                            }, tx);
                        }
                        participantId = participant.id;
                        participantByEmail.set(pr.email.toLowerCase(), participantId);
                    } else if (pr.parentEmail) {
                        // Ensure parent exists (new parents get their own household)
                        let parent = await tx.person.findUnique({ where: { email: pr.parentEmail } });
                        if (!parent) {
                            parent = await createParticipantWithHousehold({
                                email: pr.parentEmail,
                                name: pr.parentEmail.split('@')[0],
                            }, tx);
                            participantByEmail.set(pr.parentEmail.toLowerCase(), parent.id);
                        }

                        const parentHouseholdId = await ensureHousehold(parent.id, tx);

                        // Find or create child in that household
                        let participant = await tx.person.findFirst({
                            where: { householdId: parentHouseholdId, name: pr.fullName, ...LIVE_PERSON }
                        });
                        if (participant) {
                            participant = await tx.person.update({
                                where: { id: participant.id },
                                data: {
                                    dateOfBirth: pr.parsedDob ?? participant.dateOfBirth,
                                }
                            });
                        } else {
                            participant = await tx.person.create({
                                data: {
                                    id: await mintPersonId(tx),
                                    name: pr.fullName,
                                    dateOfBirth: pr.parsedDob,
                                    householdId: parentHouseholdId
                                }
                            });
                        }
                        participantId = participant.id;
                        await applyAddressToHousehold(parentHouseholdId, pr.address, tx);

                        // Ensure membership
                        await ensureHouseholdMembership(parentHouseholdId, tx);
                    } else {
                        // No email, no parent email — find by name/DOB
                        const matchQuery: { name: string; dateOfBirth?: Date } = { name: pr.fullName };
                        if (pr.parsedDob) matchQuery.dateOfBirth = pr.parsedDob;

                        let participant = await tx.person.findFirst({ where: { ...matchQuery, ...LIVE_PERSON } });
                        if (participant) {
                            await applyAddressToHousehold(participant.householdId, pr.address, tx);
                        } else {
                            participant = await createParticipantWithHousehold({
                                name: pr.fullName,
                                dob: pr.parsedDob,
                                address: pr.address,
                            }, tx);
                        }
                        participantId = participant.id;
                    }

                    return participantId;
                });

                participantByName.set(pr.fullName.toLowerCase(), participantId);
                insertedOrUpdatedCount++;

            } catch (err: unknown) {
                logger.error(`Error processing row ${pr.index + 2}:`, err);
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';
                errors.push(`Row ${pr.index + 2} (${pr.fullName || 'Unknown'}): ${errorMessage}`);
            }
        }

        // ===== PASS 2: Resolve households =====
        // Helper to resolve a "Same Household As" reference (checks DB + this import batch)
        const resolveHouseholdRef = async (ref: string): Promise<{ householdId: number; refParticipantId: number } | null> => {
            const trimmed = ref.trim();
            if (!trimmed) return null;

            // Try by email (check batch first, then DB)
            if (trimmed.includes('@')) {
                const batchId = participantByEmail.get(trimmed.toLowerCase());
                if (batchId) {
                    const hhId = await ensureHousehold(batchId);
                    return { householdId: hhId, refParticipantId: batchId };
                }
                const byEmail = await prisma.person.findUnique({
                    where: { email: trimmed },
                    select: { id: true, householdId: true }
                });
                if (byEmail) {
                    return { householdId: byEmail.householdId, refParticipantId: byEmail.id };
                }
            }

            // Try by name (check batch first, then DB)
            const batchId = participantByName.get(trimmed.toLowerCase());
            if (batchId) {
                const hhId = await ensureHousehold(batchId);
                return { householdId: hhId, refParticipantId: batchId };
            }

            const byName = await prisma.person.findFirst({
                where: { name: { equals: trimmed, mode: 'insensitive' }, ...LIVE_PERSON },
                select: { id: true, householdId: true }
            });
            if (byName) {
                return { householdId: byName.householdId, refParticipantId: byName.id };
            }

            return null;
        };

        for (const pr of parsedRows) {
            try {
                // Get participant ID from our tracking maps
                const participantId = pr.email
                    ? participantByEmail.get(pr.email.toLowerCase())
                    : participantByName.get(pr.fullName.toLowerCase());

                if (!participantId) continue;

                // Handle "Same Household As"
                if (pr.sameHouseholdAs) {
                    const resolved = await resolveHouseholdRef(pr.sameHouseholdAs);
                    if (resolved) {
                        const targetHouseholdId = resolved.householdId;
                        
                        // Get the participant's current household (might have just been created in Pass 1)
                        const participant = await prisma.person.findUnique({
                            where: { id: participantId },
                            select: { householdId: true }
                        });

                        const sourceHouseholdId = participant?.householdId;

                        // If they are already in the target household, do nothing
                        if (sourceHouseholdId === targetHouseholdId || !sourceHouseholdId) {
                            continue;
                        }

                        if (sharesHousehold(actorHouseholdId, sourceHouseholdId) || sharesHousehold(actorHouseholdId, targetHouseholdId)) {
                            errors.push(`Row ${pr.index + 2} (${pr.fullName}): You cannot merge your own household — someone outside your household must.`);
                            continue;
                        }

                        // Merge the ENTIRE source household into the target.
                        const sourceLeads = await prisma.person.findMany({
                            where: { householdId: sourceHouseholdId, isHouseholdLead: true, ...LIVE_PERSON },
                            select: { id: true }
                        });

                        // Enforce the 2-lead cap (#269) BEFORE mutating: reject
                        // the merge up front rather than start a doomed transaction.
                        const projectedLeadIds = new Set(
                            (await prisma.person.findMany({
                                where: { householdId: targetHouseholdId, isHouseholdLead: true, ...LIVE_PERSON },
                                select: { id: true }
                            })).map((l) => l.id)
                        );
                        for (const l of sourceLeads) projectedLeadIds.add(l.id);
                        if (pr.email) projectedLeadIds.add(participantId);
                        if (projectedLeadIds.size > MAX_HOUSEHOLD_LEADS) {
                            throw new HouseholdLeadLimitError(targetHouseholdId);
                        }

                        // Atomic: if any step throws, the whole merge rolls back so
                        // participants are never left half-moved between households.
                        await prisma.$transaction(async (tx) => {
                            // Move all participants from source to target. Their
                            // isHouseholdLead flag travels with them (a1), so source
                            // leads become target leads automatically — no re-add.
                            await tx.person.updateMany({
                                where: { householdId: sourceHouseholdId },
                                data: { householdId: targetHouseholdId }
                            });

                            // Authoritative cap re-check UNDER the household lock. The
                            // pre-check above runs outside the tx with no lock, so a
                            // concurrent merge/promote could push target over the cap in
                            // between; the moved-in source leads carry their flag, so
                            // count target's flagged members directly and roll back if
                            // over. (The pr.email add below re-checks its own add too.)
                            await tx.$queryRaw`SELECT id FROM "Household" WHERE id = ${targetHouseholdId} FOR UPDATE`;
                            const targetLeadCount = await tx.person.count({
                                where: { householdId: targetHouseholdId, isHouseholdLead: true, ...LIVE_PERSON }
                            });
                            if (targetLeadCount > MAX_HOUSEHOLD_LEADS) {
                                throw new HouseholdLeadLimitError(targetHouseholdId);
                            }

                            // Pre-image of everything this merge destroys, read before the
                            // deletes: the household row and any OrgMembership on it.
                            const sourceHousehold = await tx.household.findUnique({ where: { id: sourceHouseholdId } });
                            const sourceMemberships = await tx.orgMembership.findMany({ where: { householdId: sourceHouseholdId } });

                            // Delete memberships from the old source household
                            await tx.orgMembership.deleteMany({ where: { householdId: sourceHouseholdId } });

                            // Finally delete the source household (empty now, so the
                            // RESTRICT FK allows it)
                            await tx.household.delete({ where: { id: sourceHouseholdId } });

                            await tx.auditLog.create({
                                data: {
                                    actorId: auth.user.id,
                                    action: "DELETE",
                                    tableName: "Household",
                                    affectedEntityId: sourceHouseholdId,
                                    secondaryAffectedEntity: targetHouseholdId,
                                    oldData: { household: sourceHousehold, orgMemberships: sourceMemberships },
                                    newData: { mergedIntoHouseholdId: targetHouseholdId, movedByImportOfPersonId: participantId },
                                },
                            });

                            // If the row that initiated the merge is an adult with an email, ensure they are a lead
                            if (pr.email) {
                                await addHouseholdLead(tx, targetHouseholdId, participantId);
                            }

                            await ensureHouseholdMembership(targetHouseholdId, tx);
                        });
                    } else {
                        errors.push(`Row ${pr.index + 2} (${pr.fullName}): Could not find participant "${pr.sameHouseholdAs}" for household association`);
                    }
                }
                // Every participant got a household in pass 1 (or already had
                // one) — just make sure the membership exists.
                else {
                    const participant = await prisma.person.findUnique({ where: { id: participantId } });
                    if (participant) {
                        await ensureHouseholdMembership(participant.householdId);
                    }
                }
            } catch (err: unknown) {
                logger.error(`Error in pass 2 for row ${pr.index + 2}:`, err);
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';
                errors.push(`Row ${pr.index + 2} (${pr.fullName}): Household linking error: ${errorMessage}`);
            }
        }

        return NextResponse.json({
            success: true,
            message: `Successfully imported or updated ${insertedOrUpdatedCount} participants.`,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error: unknown) {
        if (error instanceof HouseholdLeadLimitError) {
            return apiError(error.message, 400);
        }
        await logBackendError(error, "POST /api/membership-ops/participants/import");
        return apiError(`Internal server error`, 500);
    }
});
