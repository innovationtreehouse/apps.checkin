import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { anyMergedAway } from "@/lib/person/archivedPeople";
import { bgSubjectKey, householdMembershipStatus, membershipMergeBlock } from "@/lib/person/merge/guard";
import { carriedComplianceDate } from "@/lib/person/merge/plan";

export const dynamic = 'force-dynamic';

export const GET = withAuth(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (req) => {
        try {
            const url = new URL(req.url);
            const aId = parseInt(url.searchParams.get('a') || '0');
            const bId = parseInt(url.searchParams.get('b') || '0');

            if (!aId || !bId) {
                return apiError("Missing IDs", 400);
            }

            const getParticipant = async (id: number) => {
                const p = await prisma.person.findUnique({
                    where: { id },
                    // Explicit select, not a bare include — an include returns the whole
                    // Person row (allergies, notificationSettings, emailVerified,
                    // lastBackgroundCheck, waiverSignedBy, ...) plus the whole Household
                    // (intakeNotes, line1/city/state/postalCode), and a plain
                    // `householdMembers: true` returns full Person rows one level down for
                    // people who aren't even being merged.
                    // googleId/dateOfBirth ARE deliberately kept on the two merge subjects:
                    // the merge field-picker compares dateOfBirth and the googleId identity
                    // (see @/lib/person/merge/plan.ts), and googleIdIdentity() renders the account behind a
                    // googleId conflict. Stripping them silently breaks the picker.
                    // Household members get only id/name/isHouseholdLead — all the merge page
                    // renders (name, "(This)" self-marker, [Lead] marker, isLeadWithOthers
                    // guard and others-count).
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        phone: true,
                        googleId: true,
                        // Lets the merge picker label which side's identity is
                        // verified/controlled (the login identity resolves as one
                        // unit — see @/lib/person/merge/plan.ts). Kept explicit, not a bare include.
                        emailVerified: true,
                        dateOfBirth: true,
                        household: {
                            select: {
                                id: true,
                                name: true,
                                // Public-tier; feeds the membership warning the POST guard
                                // enforces (see @/lib/person/merge/guard.ts).
                                orgMembership: { select: { status: true } },
                                householdMembers: {
                                    // Tombstones are not members: the page's
                                    // isLeadWithOthers guard must match the POST's, and
                                    // the membership block counts live members only.
                                    select: { id: true, name: true, isHouseholdLead: true }
                                }
                            }
                        },
                        _count: {
                            select: {
                                rawBadgeLogs: true,
                                visits: true,
                                programParticipants: true,
                                programVolunteers: true
                            }
                        }
                    }
                });
                return p;
            };

            // Read apart from the select above, so the raw dates stay out of `participants`
            // and only a date the survivor would adopt leaves this route.
            const getBgSubject = (id: number) => prisma.person.findUnique({
                where: { id },
                select: { lastBackgroundCheck: true },
            });

            const [pA, pB, bgA, bgB] = await Promise.all([getParticipant(aId), getParticipant(bId), getBgSubject(aId), getBgSubject(bId)]);

            if (!pA || !pB || !bgA || !bgB) {
                if (await anyMergedAway(prisma, [aId, bId])) {
                    return apiError("Cannot analyze: one of these participants has already been merged.", 409);
                }
                return apiError("Participant not found", 404);
            }

            // Mirrors the POST guard so the picker warns before the operator commits.
            // The rule is asymmetric (it turns on which record is merged away) and the
            // keeper isn't fixed until the UI scores and the operator swaps, so both
            // directions are reported and the page applies the live one.
            // "others" is every household member but the subject.
            const subject = (p: typeof pA) => ({
                status: householdMembershipStatus(p.household),
                liveOthers: p.household?.householdMembers.filter(m => m.id !== p.id).length ?? 0,
            });
            const a = subject(pA);
            const b = subject(pB);

            // Collision detection — direction-independent (collisions block either way).
            // A background-check collision names its attestation ids so a sysadmin can find the rows.
            const collisions: Array<{ type: string; message: string; attestationIds?: number[] }> = [];
            const now = new Date();

            const [sharedPrograms, sharedTools, sharedFutureEvents, attestations, aOpen, bOpen] = await Promise.all([
                prisma.program.findMany({
                    where: {
                        AND: [
                            { participants: { some: { personId: aId } } },
                            { participants: { some: { personId: bId } } },
                        ],
                    },
                    select: { name: true },
                }),
                prisma.tool.findMany({
                    where: {
                        AND: [
                            { toolStatuses: { some: { personId: aId } } },
                            { toolStatuses: { some: { personId: bId } } },
                        ],
                    },
                    select: { name: true },
                }),
                prisma.event.findMany({
                    where: {
                        startAt: { gt: now },
                        AND: [
                            { rsvps: { some: { personId: aId } } },
                            { rsvps: { some: { personId: bId } } },
                        ],
                    },
                    select: { name: true },
                }),
                prisma.backgroundCheckAttestation.findMany({
                    where: { OR: [{ reviewerId: { in: [aId, bId] } }, { subjectPersonId: { in: [aId, bId] } }] },
                    select: { id: true, processId: true, reviewerId: true, subjectPersonId: true },
                    orderBy: { id: 'asc' },
                }),
                prisma.visit.findFirst({ where: { personId: aId, departedAt: null, deletedAt: null }, select: { id: true } }),
                prisma.visit.findFirst({ where: { personId: bId, departedAt: null, deletedAt: null }, select: { id: true } }),
            ]);

            for (const p of sharedPrograms) {
                collisions.push({ type: 'programParticipant', message: `Both enrolled in ${p.name}. Unenroll one first.` });
            }
            for (const t of sharedTools) {
                collisions.push({ type: 'toolStatus', message: `Both hold a ${t.name} certification. Remove one first.` });
            }
            // Reviewer side: both records attested under the same process.
            const aReviewedProcesses = new Set(attestations.filter(x => x.reviewerId === aId).map(x => x.processId));
            const sharedProcesses = new Set(attestations.filter(x => x.reviewerId === bId && aReviewedProcesses.has(x.processId)).map(x => x.processId));
            if (sharedProcesses.size > 0) {
                const n = sharedProcesses.size;
                collisions.push({
                    type: 'bgAttestation',
                    message: `Both attested the same background check (${n} shared review${n > 1 ? 's' : ''}). Investigate before merging.`,
                    attestationIds: attestations.filter(x => (x.reviewerId === aId || x.reviewerId === bId) && sharedProcesses.has(x.processId)).map(x => x.id),
                });
            }
            // Cross-role: one record reviewed an attestation naming the other as
            // subject. Only one row exists, so no unique fires — the repoint would
            // quietly turn it into a self-review that still counts toward clearance.
            const crossRole = attestations.filter(x =>
                (x.subjectPersonId === aId && x.reviewerId === bId) || (x.subjectPersonId === bId && x.reviewerId === aId)
            );
            if (crossRole.length > 0) {
                const n = crossRole.length;
                collisions.push({
                    type: 'bgAttestationCrossRole',
                    message: `One record reviewed a background check naming the other as its subject (${n} attestation${n > 1 ? 's' : ''}). Merging would make the survivor the reviewer of their own background check — investigate before merging.`,
                    attestationIds: crossRole.map(x => x.id),
                });
            }
            // Subject side of @@unique([processId, reviewerId, subjectPersonId]): a repoint
            // collides only when ONE reviewer attested both records under the same process.
            const aSubjectKeys = new Set(attestations.filter(x => x.subjectPersonId === aId).map(bgSubjectKey));
            const sharedSubjectKeys = new Set(attestations.filter(x => x.subjectPersonId === bId && aSubjectKeys.has(bgSubjectKey(x))).map(bgSubjectKey));
            if (sharedSubjectKeys.size > 0) {
                const n = sharedSubjectKeys.size;
                collisions.push({
                    type: 'bgAttestationSubject',
                    message: `One reviewer attested both records as the subject of the same background check (${n} shared attestation${n > 1 ? 's' : ''}). Investigate before merging.`,
                    attestationIds: attestations.filter(x => (x.subjectPersonId === aId || x.subjectPersonId === bId) && sharedSubjectKeys.has(bgSubjectKey(x))).map(x => x.id),
                });
            }
            for (const e of sharedFutureEvents) {
                collisions.push({ type: 'rsvp', message: `Both RSVP'd to ${e.name}. Remove one RSVP first.` });
            }
            if (aOpen && bOpen) {
                collisions.push({ type: 'openVisit', message: 'Both have an open building visit. Close one visit first.' });
            }

            // The date the keeper would adopt; whether the household then qualifies is settled after the merge.
            const bgNotice = (keep: typeof bgA, merged: typeof bgB) => {
                const date = carriedComplianceDate(keep.lastBackgroundCheck, merged.lastBackgroundCheck);
                return date ? { date } : null;
            };

            return NextResponse.json({
                participants: [pA, pB],
                membershipBlock: {
                    aAsKeeper: membershipMergeBlock(a, b),
                    bAsKeeper: membershipMergeBlock(b, a),
                },
                bgNotice: { aAsKeeper: bgNotice(bgA, bgB), bAsKeeper: bgNotice(bgB, bgA) },
                collisions,
            });
        } catch (error) {
            logger.error("Failed to analyze participants:", error);
            return apiError("Server error", 500);
        }
    }
);
