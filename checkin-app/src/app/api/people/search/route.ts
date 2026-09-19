import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { ACTIVE_ORG_MEMBER_PERSON_WHERE, personRecordIsActiveOrgMember } from "@/lib/orgMembership";
import { apiError } from "@/lib/api-response";
import { rolesToFlags } from "@/lib/roles";
import { LIVE_PERSON } from "@/lib/person/filters";
import { searchId } from "@/lib/searchId";
import { leaderAgeCutoff } from "@/lib/programAge";
import { membershipYearCycle, membershipYearCycleForLabel, MAX_DATE } from "@/lib/membership/renewal";

export const dynamic = 'force-dynamic';

export const GET = withAuth(
    { roles: ['isSysadmin', 'isBoardMember', 'isOperations'] },
    async (req, auth) => {
        try {
            const url = new URL(req.url);

            // Roster mode: every ACTIVE member org-wide, ignoring `q` and the 200-row cap.
            // Badge display names have to disambiguate against the whole membership, not
            // against whichever rows the search box happened to return (#1625). A mode on
            // this route rather than a new one: `GET /api/people/search` is already on the
            // legacy-authz baseline, so no new method key and no registry change, and the
            // shape here is a strict subset of what the search below already returns.
            // ponytail: unbounded — ACTIVE members only (hundreds). Paginate if that changes.
            // Roster years: the distinct membership years that have at least one
            // settled process. Drives the badge page's year picklist.
            if (url.searchParams.get('roster') === 'years') {
                const settings = await prisma.boardSettings.findUnique({
                    where: { id: 1 },
                    select: { orgMembershipYearBoundary: true },
                });
                if (!settings?.orgMembershipYearBoundary) {
                    return NextResponse.json({ years: [], current: null });
                }
                const boundary = settings.orgMembershipYearBoundary;
                const current = membershipYearCycle(boundary, new Date());
                // Look back 5 years from the current cycle.
                const currentEndYear = parseInt(current.label.split('-')[1], 10);
                const years: string[] = [];
                for (let end = currentEndYear; end >= currentEndYear - 5; end--) {
                    const label = `${end - 1}-${end}`;
                    const cycle = membershipYearCycleForLabel(boundary, label);
                    if (!cycle) continue;
                    const count = await prisma.orgMembershipProcess.count({
                        where: {
                            status: 'ACTIVE',
                            stageEnteredAt: { gte: cycle.settledSince, lt: cycle.settledBefore },
                        },
                    });
                    if (count > 0) years.push(label);
                }
                // Always include the current label even with 0 settled, so
                // the picklist has a sensible default for fresh orgs.
                if (!years.includes(current.label)) years.unshift(current.label);
                return NextResponse.json({ years, current: current.label });
            }

            if (url.searchParams.get('roster') === 'active') {
                const settings = await prisma.boardSettings.findUnique({
                    where: { id: 1 },
                    select: { orgMembershipYearBoundary: true },
                });
                if (!settings?.orgMembershipYearBoundary) {
                    logger.warn('No membership-year boundary configured — badges will print no year (#1628)');
                }
                const requestedYear = url.searchParams.get('year');
                const cycle = settings?.orgMembershipYearBoundary
                    ? (requestedYear
                        ? membershipYearCycleForLabel(settings.orgMembershipYearBoundary, requestedYear)
                        : membershipYearCycle(settings.orgMembershipYearBoundary, new Date()))
                    : null;
                // A household earns `year` by settling THIS cycle, not by being ACTIVE —
                // nothing revokes a membership at the boundary, so ACTIVE outlives the
                // year it paid for. No `kind` filter (an INITIAL settled this cycle has
                // paid for it too) and no ARCHIVED, matching lib/outreach/recipients.
                // No boundary ⇒ the sentinel matches nothing, so nobody gets a year.
                const settledBefore = cycle && 'settledBefore' in cycle ? cycle.settledBefore as Date : undefined;
                const stageFilter: { gte: Date; lt?: Date } = { gte: cycle?.settledSince ?? MAX_DATE };
                if (settledBefore) stageFilter.lt = settledBefore;
                const members = await prisma.person.findMany({
                    // No sysadmin logins: those exist for remote system management and
                    // never wear a badge, so they neither print by default nor count
                    // toward printed-name disambiguation. Role table, not the legacy
                    // mirror column — PersonRole is the source of truth.
                    where: { ...LIVE_PERSON, ...ACTIVE_ORG_MEMBER_PERSON_WHERE, roles: { none: { role: 'SYSADMIN' } } },
                    select: {
                        id: true,
                        name: true,
                        nickname: true,
                        household: {
                            select: {
                                orgMembership: {
                                    select: {
                                        processes: {
                                            where: {
                                                status: 'ACTIVE',
                                                stageEnteredAt: stageFilter,
                                            },
                                            select: { id: true },
                                            take: 1,
                                        },
                                    },
                                },
                            },
                        },
                    },
                });
                // Ops sees `year`: Operations prints badges (#1623), so it has to see which
                // households renewed. It derives from OrgMembershipProcess.status and
                // stageEnteredAt (both @sensitivity:internal) but exposes only the printed
                // year string — no process row, no dates, no payment detail.
                return NextResponse.json({
                    people: members.map(m => ({
                        id: m.id,
                        name: m.name ?? '',
                        nickname: m.nickname,
                        year: cycle && m.household?.orgMembership?.processes.length ? cycle.label : null,
                    })),
                });
            }

            const q = url.searchParams.get('q') || '';
            // Only `adults` is recognized; any other value (or none) filters by age not at all.
            const adultsOnly = url.searchParams.get('filter') === 'adults';

            // The only callers are the lead-mentor pickers, so "adults" means
            // leader-eligible: 23+ by DOB, or isDeclaredAdult (marked 25+).
            const ageCutoff = leaderAgeCutoff();

            // The Participants directory prints the id column, so a bare number is
            // also an id lookup — OR'd with the text match, since "42" can equally
            // be part of a name or email.
            const idQuery = searchId(q);

            const people = await prisma.person.findMany({
                // Both clauses below are ORs, so they go in an AND array rather than as
                // two `OR:` keys — a second top-level OR would silently overwrite the
                // first, and Prisma's recursive WhereInput accepts that without a type
                // error. `?q=x&filter=adults` must apply both.
                where: {
                    ...LIVE_PERSON,
                    AND: [
                        ...(q ? [{
                            OR: [
                                { name: { contains: q, mode: 'insensitive' as const } },
                                { email: { contains: q, mode: 'insensitive' as const } },
                                ...(idQuery !== null ? [{ id: idQuery }] : []),
                            ]
                        }] : []),
                        ...(adultsOnly ? [{
                            OR: [
                                { dateOfBirth: { lte: ageCutoff } },
                                { isDeclaredAdult: true },
                            ]
                        }] : []),
                    ],
                },
                take: 200,
                orderBy: { id: 'desc' },
                include: {
                    household: {
                        include: {
                            // Explicit select, not `true` — a plain include returns full
                            // Person rows one level down (lastBackgroundCheck, googleId,
                            // emailVerified, emailUndeliverableAt, ...), leaking every
                            // household member's sensitive fields regardless of the
                            // opsOnly strip below, which only touches the top-level person.
                            // id/name/email/isHouseholdLead is exactly what every consumer of
                            // this endpoint's household.householdMembers reads: the
                            // Assign-household picker and its household-member list, and the
                            // participant-merge page (isLeadWithOthers guard + [Lead] marker).
                            // isHouseholdLead is @sensitivity:public, so ops sees it too.
                            householdMembers: { select: { id: true, name: true, email: true, isHouseholdLead: true } },
                            orgMembership: true,
                        }
                    },
                    // isOperations has no column — every flag derives through this one
                    // relation so there's a single code path (rolesToFlags), not four
                    // mirror reads plus one table read.
                    roles: { select: { role: true } },
                }
            });

            // Operations holds the Participants directory (contacts) view only:
            // names, contact info (email/phone), and role pills (isBoardMember etc.
            // are @sensitivity:public org structure, not PII — not stripped). It is
            // denied background-check compliance dates (lastBackgroundCheck),
            // date of birth, and every non-contact field on a household's OTHER
            // members (see the explicit householdMembers select above). Household
            // orgMembership (and isMember, derived from it) IS shown to ops: every
            // field on that row — memberSince/status/isVolunteer — is
            // @sensitivity:public, so it is standing, not finance detail. The
            // household itself is an explicit projection, not a row spread, so the
            // Household's own home address (line1/line2/city/state/postalCode) and
            // free-text intakeNotes (hardship/medical/family disclosures) reach
            // nobody through this route — no consumer reads them off it. Board/
            // sysadmin keep the full shape.
            // See membership-ops/layout.tsx's Participants-only nav gate for ops.
            const opsOnly = auth.type === 'session' && auth.user.isOperations
                && !auth.user.isSysadmin && !auth.user.isBoardMember;

            const formatted = people.map(p => ({
                id: p.id,
                name: p.name,
                nickname: p.nickname,
                email: p.email,
                phone: p.phone,
                // `undefined` drops the key on JSON serialization — a stripped
                // response, not a null/zeroed one.
                dateOfBirth: opsOnly ? undefined : p.dateOfBirth,
                isDeclaredAdult: opsOnly ? undefined : p.isDeclaredAdult,
                lastBackgroundCheck: opsOnly ? undefined : p.lastBackgroundCheck,
                isMember: personRecordIsActiveOrgMember(p),
                ...rolesToFlags(p.roles),
                emailSuppressed: p.emailSuppressed,
                household: p.household ? {
                    id: p.household.id,
                    name: p.household.name,
                    householdMembers: p.household.householdMembers,
                    // Every OrgMembership field is @sensitivity:public — ops sees it.
                    orgMembership: p.household.orgMembership,
                } : null,
            }));

            return NextResponse.json({ people: formatted });
        } catch (error) {
            logger.error("Failed to fetch people:", error);
            return apiError("Failed to fetch people", 500);
        }
    }
);
