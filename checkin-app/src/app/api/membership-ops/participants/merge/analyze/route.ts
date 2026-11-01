import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { mergeBgNotice } from "@/lib/membership/mergeBgAdvance";
import { anyMergedAway } from "@/lib/person/archivedPeople";
import { bgSubjectKey, householdMembershipStatus, membershipMergeBlock } from "@/lib/person/merge/guard";

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
                        mergedIntoId: true,
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
                select: { householdId: true, isHouseholdLead: true, lastBackgroundCheck: true },
            });

            const [pA, pB, bgA, bgB] = await Promise.all([getParticipant(aId), getParticipant(bId), getBgSubject(aId), getBgSubject(bId)]);

            if (!pA || !pB || !bgA || !bgB) {
                if (await anyMergedAway(prisma, [aId, bId])) {
                    return apiError("Cannot analyze: one of these participants has already been merged.", 409);
                }
                return apiError("Participant not found", 404);
            }

            if (pA.mergedIntoId != null || pB.mergedIntoId != null) {
                return apiError("Cannot analyze: one of these participants has already been merged.", 409);
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
            const collisions: Array<{ type: string; message: string }> = [];
            const now = new Date();

            const [sharedPrograms, sharedTools, sharedFutureEvents, sharedBgProcessCount, subjectAttestations, aOpen, bOpen] = await Promise.all([
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
                prisma.orgMembershipProcess.count({
                    where: {
                        AND: [
                            { attestations: { some: { reviewerId: aId } } },
                            { attestations: { some: { reviewerId: bId } } },
                        ],
                    },
                }),
                // Subject side of @@unique([processId, reviewerId, subjectPersonId]):
                // a repoint collides only when ONE reviewer attested both records under
                // the same process, so the pairs are intersected below rather than
                // counted per process.
                prisma.backgroundCheckAttestation.findMany({
                    where: { subjectPersonId: { in: [aId, bId] } },
                    select: { processId: true, reviewerId: true, subjectPersonId: true },
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
            if (sharedBgProcessCount > 0) {
                collisions.push({ type: 'bgAttestation', message: `Both attested the same background check (${sharedBgProcessCount} shared review${sharedBgProcessCount > 1 ? 's' : ''}). Investigate before merging.` });
            }
            // Cross-role: one record reviewed an attestation naming the other as
            // subject. Only one row exists, so no unique fires — the repoint would
            // quietly turn it into a self-review that still counts toward clearance.
            const crossRoleCount = subjectAttestations.filter(x =>
                (x.subjectPersonId === aId && x.reviewerId === bId) || (x.subjectPersonId === bId && x.reviewerId === aId)
            ).length;
            if (crossRoleCount > 0) {
                collisions.push({ type: 'bgAttestationCrossRole', message: `One record reviewed a background check naming the other as its subject (${crossRoleCount} attestation${crossRoleCount > 1 ? 's' : ''}). Merging would make the survivor the reviewer of their own background check — investigate before merging.` });
            }
            const aSubjectKeys = new Set(subjectAttestations.filter(x => x.subjectPersonId === aId).map(bgSubjectKey));
            const sharedSubjectCount = subjectAttestations
                .filter(x => x.subjectPersonId === bId && aSubjectKeys.has(bgSubjectKey(x))).length;
            if (sharedSubjectCount > 0) {
                collisions.push({ type: 'bgAttestationSubject', message: `One reviewer attested both records as the subject of the same background check (${sharedSubjectCount} shared attestation${sharedSubjectCount > 1 ? 's' : ''}). Investigate before merging.` });
            }
            for (const e of sharedFutureEvents) {
                collisions.push({ type: 'rsvp', message: `Both RSVP'd to ${e.name}. Remove one RSVP first.` });
            }
            if (aOpen && bOpen) {
                collisions.push({ type: 'openVisit', message: 'Both have an open building visit. Close one visit first.' });
            }

            const [bgNoticeAKept, bgNoticeBKept] = await Promise.all([mergeBgNotice(bgA, bgB), mergeBgNotice(bgB, bgA)]);

            return NextResponse.json({
                participants: [pA, pB],
                membershipBlock: {
                    aAsKeeper: membershipMergeBlock(a, b),
                    bAsKeeper: membershipMergeBlock(b, a),
                },
                bgNotice: { aAsKeeper: bgNoticeAKept, bAsKeeper: bgNoticeBKept },
                collisions,
            });
        } catch (error) {
            logger.error("Failed to analyze participants:", error);
            return apiError("Server error", 500);
        }
    }
);
