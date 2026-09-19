import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import type { OrgMembershipProcessStatus, TrustedAdultReviewStatus } from "@/generated/prisma/client";
import { countHouseholdsMissingValidContact } from "@/lib/emergencyContacts/service";
import { canReviewBackgroundChecks, reviewQueueCounts } from "@/lib/membership/review";
import { getLeadConflicts } from "@/lib/attendanceConflicts";
import { pickAddress, validateAddress } from "@/lib/address";
import { openConfigIssues } from "@/lib/configHealth";
import { countUnhealthyCronJobs } from "@/lib/cronRuns";
import { PROGRAM_CHECKOUT_BROKEN_WHERE } from "@/lib/programCheckout";
import { apiError } from "@/lib/api-response";
import { BROKEN_HOUSEHOLD_WHERE, UNCLAIMED_OR_BROKEN_HOUSEHOLD_WHERE } from "@/lib/household/filters";
import { LIVE_PERSON } from "@/lib/person/filters";
import { expiringApprovals } from "@/lib/trusted-adult/filters";

/**
 * Aggregate "things to do" counts for the left-nav badges. Every count is scoped
 * to what the *viewer can actually resolve* — see docs/plan: member keys count
 * only member/household actions, the admin block only the board's own queue.
 * Items blocked on someone else are deliberately excluded (they'd be noise).
 *
 * Predicates are composed from the existing domain modules rather than re-derived:
 *   - membership phases   -> src/lib/membership/phases.ts (member-actionable set)
 *   - renewal             -> PENDING_RENEWAL (member clicks "begin renewal")
 *   - trusted-adult expiry  -> src/lib/trusted-adult/service.ts (WARN_LEAD_DAYS = 30)
 *   - emergency contact   -> same gap the onboarding-status route reports
 */

// Membership process statuses the household itself must act on. Mirrors
// IN_FLIGHT_INITIAL_STATUSES minus the reviewer/board states, plus the
// member-driven PENDING_RENEWAL.
const MEMBER_ACTIONABLE_MEMBERSHIP: OrgMembershipProcessStatus[] = ["INTAKE", "PENDING_EXTERNAL_ACTION", "PENDING_PAYMENT", "PENDING_RENEWAL"];

// Membership statuses the board itself can act on. The board's only
// membership-queue action is overriding/resetting a BLOCKED application
// (governance escape hatch — see overrideBlocked in src/lib/membership/review.ts).
// PENDING_BG_REVIEW / RENEWAL_PENDING_BG are background-check-reviewer (RBAC,
// role isBackgroundCheckReviewer) work, surfaced by the reviewer notifications
// badge (src/lib/membership/notifications.ts) — NOT the board. The board can
// still SEE those in the applications list, but they don't count here.
const BOARD_ACTIONABLE_MEMBERSHIP: OrgMembershipProcessStatus[] = ["BLOCKED"];

const APPROVED_STATUSES: TrustedAdultReviewStatus[] = ["APPROVED"];

// Same warning lead as runExpirySweep (src/lib/trusted-adult/service.ts).
const WARN_LEAD_DAYS = 30;

/** A single actionable item: what to do, and where to go to do it. */
export type TodoItem = { key: string; label: string; href: string };

export type TodoCounts = {
    // Member buckets are itemized so the UI can show *what* is due, not just a number.
    // `programs` = enrollments the household must still pay for (actionable, green).
    // `programsAwaitingFinance` = enrollments whose payment plan was sent to finance
    // and not yet approved — blocked on the board, so a gray informational count, not a todo.
    member: { household: TodoItem[]; programs: TodoItem[]; programsAwaitingFinance: number };
    // Informational gray badges (not action items): live building occupancy and
    // how many programs are currently running.
    building: number;
    // Of the people currently in the building, how many belong to the caller's
    // household — lets the Attendance badge show "mine" (green) vs "others" (gray).
    buildingHousehold: number;
    activePrograms: number;
    // Admin keys stay numeric — each admin nav link already deep-links to a page
    // that lists its own queue, so the number is enough.
    // `membership` = board-actionable (BLOCKED, green). `applicationsTotal` =
    // every in-flight (non-ACTIVE) application, the gray count shown on the
    // Applications tab — mirrors what /api/admin/membership lists.
    // `brokenEmails` = people whose email Resend has reported as undeliverable
    // (bounce/complaint) and no later delivery has cleared — see webhooks/resend.
    // Red pill on the Membership Ops nav item + the Manage Memberships (households) tab.
    // `brokenHouseholds` = households with no lead at all (red — blocking board action).
    // `settingsMisconfig` = how many required Shopify-checkout board settings are still
    // unset (0–2): the membership variant ID and the volunteer discount code. Red pill on
    // the Settings nav + Membership Settings tab — checkout is broken until both are set.
    // `programsMisconfig` = how many programs have a price but no matching Shopify variant
    // (paid enrollment silently can't check out). Red pill on the Program Ops Programs tab.
    // `openPaymentExceptions` = reconciler-detected payment problems (OPEN or
    // ACKNOWLEDGED) awaiting board action — green pill on the Finance Ops Payment
    // problems tab. Same count as getMembershipNotifications.openPaymentExceptions.
    admin?: { membership: number; applicationsTotal: number; paymentPlanPending: number; membershipPaymentPlanPending: number; trustedAdults: number; householdsMissingContact: number; unclaimedHouseholds: number; brokenHouseholds: number; brokenEmails: number; settingsMisconfig: number; programsMisconfig: number; openPaymentExceptions: number };
    // Infra-health gaps (admins + board only). Both halves drive the ONE red System
    // Status nav badge; the full detail lives at /api/system-status/config-health.
    // `openIssues` = failing system-config checks (e.g. Zoho e-sign unconfigured) —
    // synchronous env presence checks, see lib/configHealth.ts.
    // `unhealthyCronJobs` = cron sweeps that have stopped running (no completed run
    // inside CRON_STALE_AFTER_MS) OR whose latest run could not process every row.
    // Both mean "go look at Scheduled Jobs"; the panel says which. Computed here
    // rather than in getConfigHealth() because it needs a DB read and that function
    // is deliberately synchronous. See lib/cronRuns.ts.
    configHealth?: { openIssues: number; unhealthyCronJobs: number };
    // Background-check reviewer surface (reviewers + board, per-viewer). `canActOn`
    // = applications this reviewer may attest now (green). `approvedAwaitingSecond`
    // = ones they approved that still need a second reviewer (gray).
    review?: { canActOn: number; approvedAwaitingSecond: number };
    // Lead surface: programs the caller runs (program.leadMentorId). Present only
    // when they lead ≥1 program — drives the "My Programs (as Volunteer)" nav item's
    // visibility and its green badge (sum of pending attendance to confirm).
    // `pending` mirrors the post-event email's targets (ended events not yet
    // confirmed), deep-linked to the existing confirm screen. No new capability.
    // `conflicts` = overlapping-visit conflicts across the caller's led programs;
    // drives the red badge on the "My Programs" nav item and the Conflicts subtab.
    lead?: { programs: LedProgram[]; conflicts?: number };
};

/** RSVP tally (Yes/Maybe/No; NO_RESPONSE omitted). */
export type RsvpTally = { yes: number; maybe: number; no: number };

/** One upcoming session, with RSVP tallies split by roster role. */
export type UpcomingSession = { eventId: number; name: string; startAt: string; participants: RsvpTally; volunteers: RsvpTally };

export type LedProgram = {
    id: number;
    name: string;
    totalEnrolled: number;
    pending: TodoItem[];
    upcoming: UpcomingSession[];
};

// What a member-actionable membership process means, in plain terms.
const MEMBERSHIP_TODO_LABEL: Record<string, string> = {
    INTAKE: "Finish your membership application",
    PENDING_EXTERNAL_ACTION: "Sign your membership contract and background-check consent",
    PENDING_PAYMENT: "Pay your membership dues",
    PENDING_RENEWAL: "Confirm your membership renewal",
};

export const GET = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") {
        return apiError("Unauthorized", 401);
    }
    const user = auth.user;

    const now = new Date();
    const warnThreshold = new Date(now);
    warnThreshold.setUTCDate(warnThreshold.getUTCDate() + WARN_LEAD_DAYS);

    // ---- Member surface (scoped to the caller's household) ----
    const householdTodos: TodoItem[] = [];
    const programTodos: TodoItem[] = [];
    // PENDING enrollments whose payment plan is awaiting finance approval — not the
    // household's action, so counted (gray) rather than listed as a todo.
    let programsAwaitingFinance = 0;

    if (user.householdId) {
        const householdId = user.householdId;
        const members = await prisma.person.findMany({
            where: { householdId, ...LIVE_PERSON },
            select: { id: true },
        });
        const memberIds = members.map((m) => m.id);

        const isLead =
            user.householdLead ??
            (await prisma.person.findFirst({
                where: { id: user.id, householdId, isHouseholdLead: true },
                select: { id: true },
            })) !== null;

        const [hh, leadsMissingPhone, membersMissingAge, membershipProcs, trustedAdultAction, trustedAdultApprovals, pendingPrograms] = await Promise.all([
            isLead
                ? prisma.household.findUnique({
                      where: { id: householdId },
                      select: {
                          // Address fields: a missing/invalid address (per validateAddress,
                          // the same check the household form runs) is a lead-actionable todo.
                          line1: true,
                          line2: true,
                          city: true,
                          state: true,
                          postalCode: true,
                          // A household needs the todo when it has no valid (non-member,
                          // complete) emergency contact. Emergency contacts are their own entity.
                          emergencyContacts: {
                              where: { conflictParticipantId: null, name: { not: "" }, phone: { not: "" } },
                              select: { id: true },
                              take: 1,
                          },
                      },
                  })
                : Promise.resolve(null),
            // A household lead with no phone on file is an actionable gap — the
            // page highlights the member box; this drives the nav badge count.
            isLead
                ? prisma.person.findMany({
                      where: { householdId, isHouseholdLead: true, OR: [{ phone: null }, { phone: "" }], ...LIVE_PERSON },
                      select: { id: true, name: true },
                  })
                : Promise.resolve([]),
            // A member with no DoB and no 25+ declaration shows "Age Unavailable"
            // on the household page; the lead must add one or the other.
            isLead
                ? prisma.person.findMany({
                      where: { householdId, dateOfBirth: null, isDeclaredAdult: false, ...LIVE_PERSON },
                      select: { id: true, name: true },
                  })
                : Promise.resolve([]),
            prisma.orgMembershipProcess.findMany({
                where: { orgMembership: { householdId }, status: { in: MEMBER_ACTIONABLE_MEMBERSHIP } },
                select: { id: true, status: true },
            }),
            prisma.trustedAdultReview.count({
                where: { householdId, status: "PENDING_SUBJECT_ACTION" },
            }),
            // ALL of the household's approvals, not just the ones in the window:
            // expiringApprovals collapses each adult to their current authorization
            // (latest reviewBy) so an adult renewed early — a live renewal outliving a
            // stale in-window row — isn't nagged to renew someone they already renewed.
            prisma.trustedAdultReview.findMany({
                where: { householdId, status: { in: APPROVED_STATUSES }, reviewBy: { not: null } },
                select: { trustedAdultId: true, reviewBy: true, id: true },
                orderBy: { id: "asc" },
            }),
            prisma.programParticipant.findMany({
                where: { personId: { in: memberIds }, status: "PENDING", person: LIVE_PERSON },
                select: { programId: true, isPaymentPlanRequested: true, program: { select: { name: true } } },
            }),
        ]);

        if (!!hh && hh.emergencyContacts.length === 0) {
            householdTodos.push({ key: "emergency-contact", label: "Add a household emergency contact", href: "/my-household#emergency-contact" });
        }
        if (!!hh && Object.keys(validateAddress(pickAddress(hh))).length > 0) {
            householdTodos.push({ key: "household-address", label: "Add or complete your household address", href: "/my-household" });
        }
        for (const l of leadsMissingPhone) {
            householdTodos.push({ key: `lead-phone-${l.id}`, label: `Add a phone number for ${l.name ?? "the household lead"}`, href: "/my-household" });
        }
        for (const m of membersMissingAge) {
            householdTodos.push({ key: `member-age-${m.id}`, label: `Add a date of birth for ${m.name ?? "a household member"}`, href: "/my-household" });
        }
        for (const p of membershipProcs) {
            householdTodos.push({
                key: `membership-${p.id}`,
                label: MEMBERSHIP_TODO_LABEL[p.status] ?? "Continue your membership application",
                href: "/membership",
            });
        }
        for (let i = 0; i < trustedAdultAction; i++) {
            householdTodos.push({ key: `trusted-adult-action-${i}`, label: "Respond to the board's request on a trusted adult", href: "/trusted-adults" });
        }
        const trustedAdultExpiring = expiringApprovals(trustedAdultApprovals, now, warnThreshold).length;
        for (let i = 0; i < trustedAdultExpiring; i++) {
            householdTodos.push({ key: `trusted-adult-expiring-${i}`, label: "Renew an expiring trusted adult", href: "/trusted-adults" });
        }
        for (const p of pendingPrograms) {
            // Payment plan sent to finance → blocked on the board, not the household.
            if (p.isPaymentPlanRequested) { programsAwaitingFinance++; continue; }
            programTodos.push({
                key: `program-${p.programId}`,
                label: `Complete enrollment for ${p.program?.name ?? "a program"}`,
                href: `/programs/${p.programId}`,
            });
        }
    }

    // Global informational counts (not scoped to the caller).
    const [building, buildingHousehold, activePrograms] = await Promise.all([
        prisma.visit.count({ where: { departedAt: null, deletedAt: null } }),
        user.householdId
            ? prisma.visit.count({ where: { departedAt: null, deletedAt: null, person: { householdId: user.householdId } } })
            : Promise.resolve(0),
        prisma.program.count({ where: { phase: "RUNNING" } }),
    ]);

    const result: TodoCounts = {
        member: { household: householdTodos, programs: programTodos, programsAwaitingFinance },
        building,
        buildingHousehold,
        activePrograms,
    };

    // ---- Lead surface (programs the caller runs as lead mentor) ----
    // Same targets as the post-event email (src/lib/postEventEmails.ts): events
    // that have ended with attendance not yet confirmed, in a program the caller
    // leads. Surfaced in-app additively; the email keeps firing. Each item deep-
    // links to the existing confirm screen — no new capability, no new PII.
    const ledPrograms = await prisma.program.findMany({
        where: { leadMentorId: user.id },
        select: { id: true, name: true },
    });
    if (ledPrograms.length > 0) {
        const ledIds = ledPrograms.map((p) => p.id);
        const now = new Date();
        const [pendingEvents, enrolledCounts, futureEvents, volunteerRows, conflicts] = await Promise.all([
            prisma.event.findMany({
                where: { programId: { in: ledIds }, endAt: { lte: now }, attendanceConfirmedAt: null },
                select: { id: true, name: true, programId: true },
                orderBy: { endAt: "asc" },
            }),
            // "Total Enrolled" = active (not PENDING) participants per program.
            prisma.programParticipant.groupBy({
                by: ["programId"],
                where: { programId: { in: ledIds }, status: "ACTIVE", person: LIVE_PERSON },
                _count: { personId: true },
            }),
            // All upcoming sessions, ascending; we keep the next 3 per program below.
            prisma.event.findMany({
                where: { programId: { in: ledIds }, startAt: { gt: now } },
                select: { id: true, name: true, startAt: true, programId: true },
                orderBy: { startAt: "asc" },
            }),
            // Volunteer roster per program — used to split RSVP tallies by role.
            prisma.programVolunteer.findMany({
                where: { programId: { in: ledIds }, person: LIVE_PERSON },
                select: { programId: true, personId: true },
            }),
            getLeadConflicts(user.id),
        ]);
        // (programId, personId) keys that belong to a volunteer; everyone else on a roster is a participant.
        const volunteerKeys = new Set(volunteerRows.map((v) => `${v.programId}:${v.personId}`));

        const pendingByProgram = new Map<number, TodoItem[]>();
        for (const e of pendingEvents) {
            if (e.programId === null) continue;
            const items = pendingByProgram.get(e.programId) ?? [];
            items.push({
                key: `attendance-${e.id}`,
                label: `Confirm attendance for ${e.name}`,
                href: `/program-ops/sessions/${e.id}?from=my-programs`,
            });
            pendingByProgram.set(e.programId, items);
        }

        const enrolledByProgram = new Map(enrolledCounts.map((g) => [g.programId, g._count.personId]));

        // Next 3 future sessions per program (futureEvents is already startAt-asc).
        const upcomingByProgram = new Map<number, { id: number; name: string; startAt: Date }[]>();
        for (const e of futureEvents) {
            if (e.programId === null) continue;
            const list = upcomingByProgram.get(e.programId) ?? [];
            if (list.length < 3) list.push({ id: e.id, name: e.name, startAt: e.startAt });
            upcomingByProgram.set(e.programId, list);
        }

        // RSVP rows for just those next-3 events. Raw rows (not groupBy) so each
        // response can be bucketed volunteer-vs-participant by its (program, participant) key.
        const upcomingEventIds = [...upcomingByProgram.values()].flat().map((e) => e.id);
        const eventProgram = new Map<number, number>();
        for (const [programId, evs] of upcomingByProgram) for (const e of evs) eventProgram.set(e.id, programId);
        const rsvpRows = upcomingEventIds.length
            ? await prisma.rSVP.findMany({
                  where: { eventId: { in: upcomingEventIds }, person: LIVE_PERSON },
                  select: { eventId: true, personId: true, status: true },
              })
            : [];
        const emptyTally = (): { participants: RsvpTally; volunteers: RsvpTally } => ({
            participants: { yes: 0, maybe: 0, no: 0 },
            volunteers: { yes: 0, maybe: 0, no: 0 },
        });
        const tallyByEvent = new Map<number, { participants: RsvpTally; volunteers: RsvpTally }>();
        for (const r of rsvpRows) {
            const t = tallyByEvent.get(r.eventId) ?? emptyTally();
            const programId = eventProgram.get(r.eventId);
            const bucket = programId !== undefined && volunteerKeys.has(`${programId}:${r.personId}`) ? t.volunteers : t.participants;
            if (r.status === "ATTENDING") bucket.yes += 1;
            else if (r.status === "MAYBE") bucket.maybe += 1;
            else if (r.status === "NOT_ATTENDING") bucket.no += 1;
            tallyByEvent.set(r.eventId, t);
        }

        result.lead = {
            programs: ledPrograms.map((p) => ({
                id: p.id,
                name: p.name,
                totalEnrolled: enrolledByProgram.get(p.id) ?? 0,
                pending: pendingByProgram.get(p.id) ?? [],
                upcoming: (upcomingByProgram.get(p.id) ?? []).map((e) => {
                    const t = tallyByEvent.get(e.id) ?? emptyTally();
                    return { eventId: e.id, name: e.name, startAt: e.startAt.toISOString(), participants: t.participants, volunteers: t.volunteers };
                }),
            })),
            conflicts: conflicts.length,
        };
    }

    // ---- Admin surface (board's own queue) — only for board/isSysadmin ----
    if (user.isSysadmin || user.isBoardMember) {
        const [membership, applicationsTotal, paymentPlanPending, membershipPaymentPlanPending, trustedAdults, householdsMissingContact, unclaimedHouseholds, brokenHouseholds, brokenEmails, programsMisconfig, openPaymentExceptions, boardSettings, unhealthyCronJobs] = await Promise.all([
            prisma.orgMembershipProcess.count({
                where: { status: { in: BOARD_ACTIONABLE_MEMBERSHIP } },
            }),
            // Every in-flight application the Applications page lists (status != ACTIVE).
            prisma.orgMembershipProcess.count({
                where: { status: { not: "ACTIVE" } },
            }),
            // Scholarship-queue count: mirror GET /api/finance-ops/payment-plans'
            // default filter exactly so the nav badge can't over-count. Excludes
            // PENDING_HOLD_FAILED rows (inventoryHeldAt null) — those live in the
            // Shopify reconciliation queue, and the board is already emailed when a
            // hold fails, so they don't need a green "approval pending" pill.
            prisma.programParticipant.count({
                where: { status: "PENDING", isPaymentPlanRequested: true, inventoryHeldAt: { not: null }, paymentPlanDeniedAt: null, person: LIVE_PERSON },
            }),
            // Households awaiting board approval of a membership-dues payment plan.
            prisma.orgMembershipProcess.count({
                where: { status: "PENDING_PAYMENT", isPaymentPlanRequested: true },
            }),
            prisma.trustedAdultReview.count({
                where: { status: "PENDING_BOARD_REVIEW" },
            }),
            countHouseholdsMissingValidContact(),
            // Households nobody has claimed via Google sign-in yet: either a lead has an
            // email to chase but no lead has signed in, OR the household has no lead at
            // all (broken). Shared predicate with /api/membership-audit/unclaimed-households
            // so the badge count and the list can't diverge.
            prisma.household.count({
                where: UNCLAIMED_OR_BROKEN_HOUSEHOLD_WHERE,
            }),
            // "Broken" households: live members, none of them a lead. Mirrors
            // /api/admin/broken-households.
            prisma.household.count({
                where: BROKEN_HOUSEHOLD_WHERE,
            }),
            // People Resend has reported as undeliverable (bounce/complaint), not since
            // cleared by a later delivery. See Person.emailUndeliverableAt / webhooks/resend.
            prisma.person.count({
                where: { emailUndeliverableAt: { not: null }, ...LIVE_PERSON },
            }),
            // Programs priced on a tier with no matching Shopify variant — paid enrollment
            // silently can't check out. Same condition as the list/detail UI, shared via
            // PROGRAM_CHECKOUT_BROKEN_WHERE (see lib/programCheckout.ts).
            prisma.program.count({ where: PROGRAM_CHECKOUT_BROKEN_WHERE }),
            // Reconciler-detected payment problems still needing board action
            // (OPEN or ACKNOWLEDGED). Green pill on the Finance Ops Payment problems tab.
            prisma.paymentException.count({ where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } } }),
            // Required membership settings — count how many are still unset so the board
            // sees a red pill until all are configured. Empty string counts as unset for
            // the Shopify fields; bgRecheckMonths <= 0 means the re-check interval is unset;
            // a null orgMembershipYearBoundary means the renewal cycle has no anchor date.
            prisma.boardSettings.findUnique({
                where: { id: 1 },
                select: { orgMembershipVariantId: true, volunteerDiscountCode: true, bgRecheckMonths: true, orgMembershipYearBoundary: true },
            }),
            // Cron sweeps that stopped running, plus ones running but failing rows. The
            // schedule lives in a separate infra repo, so this is the app's only way to
            // notice its own nightly sweep stopped working. See lib/cronRuns.ts.
            countUnhealthyCronJobs(),
        ]);
        const settingsMisconfig =
            (boardSettings?.orgMembershipVariantId ? 0 : 1) +
            (boardSettings?.volunteerDiscountCode ? 0 : 1) +
            ((boardSettings?.bgRecheckMonths ?? 0) > 0 ? 0 : 1) +
            (boardSettings?.orgMembershipYearBoundary ? 0 : 1);
        result.admin = { membership, applicationsTotal, paymentPlanPending, membershipPaymentPlanPending, trustedAdults, householdsMissingContact, unclaimedHouseholds, brokenHouseholds, brokenEmails, settingsMisconfig, programsMisconfig, openPaymentExceptions };
        // Infra health: env-var/deploy gaps (synchronous presence checks) plus cron
        // sweeps that stopped running or stopped working. Same admin+board gate as the
        // rest of this block — both fold into the single red System Status pill.
        result.configHealth = { openIssues: openConfigIssues(), unhealthyCronJobs };
    }

    // ---- Reviewer surface (per-viewer background-check queue) ----
    // canReviewBackgroundChecks: explicit reviewers + board (implicit). Returns
    // zeros for non-reviewers, so gate on the role to avoid the query entirely.
    if (canReviewBackgroundChecks(user)) {
        result.review = await reviewQueueCounts(user.id);
    }

    return NextResponse.json(result);
});
