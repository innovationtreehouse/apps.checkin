/**
 * @jest-environment node
 */
/**
 * Negative-auth coverage for protected routes that previously had NO 401/403
 * test. Two shapes:
 *
 *  1. ROLE-GATED — reject both the unauthenticated caller (401) and a plain
 *     authenticated user with no privileged role (403). Table-driven; the auth
 *     gate fires before any body/param work, so dummy params/empty bodies reach
 *     it.
 *
 *  2. AUTH-ONLY (`withAuth({})`, no role list) — there is NO privilege boundary
 *     beyond authentication, so only 401 is a meaningful negative. We assert 401
 *     and explicitly document that a plain authenticated user is admitted by
 *     design (NOT 403).
 *
 * TEST-ONLY. A route here returning 2xx for the unauthenticated/plain caller is
 * a live authz hole.
 */
import { PATCH as ADMIN_HH_PATCH } from '@/app/api/membership-ops/households/[id]/route';
import { POST as PARTICIPANTS_POST } from '@/app/api/membership-ops/participants/route';
import { PUT as PARTICIPANT_PUT } from '@/app/api/membership-ops/participants/[id]/route';
import { POST as PARTICIPANT_HH_POST } from '@/app/api/membership-ops/participants/[id]/household/route';
import { POST as IMPORT_POST } from '@/app/api/membership-ops/participants/import/route';
import { POST as MERGE_POST } from '@/app/api/membership-ops/participants/merge/route';
import { GET as MERGE_ANALYZE_GET } from '@/app/api/membership-ops/participants/merge/analyze/route';
import { POST as IMPORT_PREVIEW_POST } from '@/app/api/membership-ops/participants/import/preview/route';
import { GET as SYSTEM_HEALTH_GET } from '@/app/api/system-status/health/route';
import { GET as TRENDS_GET } from '@/app/api/facility/trends/route';
import { GET as ADMIN_TA_GET } from '@/app/api/safety/trusted-adults/route';
import { POST as TA_OVERRIDE_POST } from '@/app/api/safety/trusted-adults/override/route';
import { PATCH as SHOP_TOOL_PATCH } from '@/app/api/shop/tools/[id]/route';
import { GET as FIN_PAYMENTS_GET } from '@/app/api/finance-ops/payments/route';
import { PATCH as FIN_PAYMENTS_PATCH } from '@/app/api/finance-ops/payments/[id]/route';
import { GET as EVENT_GET, PATCH as EVENT_PATCH } from '@/app/api/events/[id]/route';
import { GET as EVENTS_LIST_GET } from '@/app/api/events/route';
import { POST as PROGRAMS_POST } from '@/app/api/programs/route';
import { POST as PROGRAM_SYNC_SHOPIFY_POST } from '@/app/api/programs/[id]/sync-shopify/route';
import { GET as NOTIFICATIONS_GET } from '@/app/api/notifications/route';
import { POST as CONTRACT_SYNC_POST } from '@/app/api/membership/contract/sync/route';
import { POST as ONBOARDING_POST } from '@/app/api/profile/onboarding/route';
// ---- routes filled in by the authz drift-guard sweep ----------------------
import { GET as BROKEN_HH_GET } from '@/app/api/admin/broken-households/route';
import { GET as LOCALIZATION_GET, PUT as LOCALIZATION_PUT } from '@/app/api/admin/settings/localization/route';
import { GET as BADGES_GET } from '@/app/api/facility/badges/route';
import { GET as FAC_VISITS_GET, PATCH as FAC_VISITS_PATCH, DELETE as FAC_VISITS_DELETE } from '@/app/api/facility/visits/route';
import { POST as FAC_VISITS_INSERT_POST } from '@/app/api/facility/visits/insert/route';
import { GET as MISSING_CONTACT_GET } from '@/app/api/membership-audit/households-missing-contact/route';
import { GET as UNCLAIMED_GET } from '@/app/api/membership-audit/unclaimed-households/route';
import { GET as TURNING_18_GET } from '@/app/api/membership-audit/turning-18/route';
import { POST as CERTIFY_PAYMENT_POST } from '@/app/api/membership-ops/applications/certify-payment/route';
import { POST as APP_EXTERNAL_POST } from '@/app/api/membership-ops/applications/external/route';
import { POST as REVIEW_OVERRIDE_POST } from '@/app/api/membership-ops/applications/review-override/route';
import { POST as APP_ARCHIVE_POST } from '@/app/api/membership-ops/applications/archive/route';
import { POST as APP_UNARCHIVE_POST } from '@/app/api/membership-ops/applications/unarchive/route';
import { DELETE as BG_ATTEST_DELETE } from '@/app/api/membership-ops/bg-attestations/[id]/route';
import { GET as MOPS_HH_GET, POST as MOPS_HH_POST } from '@/app/api/membership-ops/households/route';
import { GET as VOL_ROSTER_GET } from '@/app/api/membership-ops/volunteer-memberships/route';
import { POST as REVIEWS_POST } from '@/app/api/membership/reviews/route';
import { GET as ROLES_GET, PATCH as ROLES_PATCH } from '@/app/api/roles/route';
import { GET as BOARD_CONTACTS_GET } from '@/app/api/safety/board-contacts/route';
import { POST as TA_DECISION_POST } from '@/app/api/safety/trusted-adults/decision/route';
import { GET as SETTINGS_MEMBERSHIP_GET, PUT as SETTINGS_MEMBERSHIP_PUT } from '@/app/api/settings/membership/route';
import { POST as BULK_RENEWALS_POST } from '@/app/api/settings/membership/bulk-open-renewals/route';
import { GET as VOL_DESIG_GET, POST as VOL_DESIG_POST, DELETE as VOL_DESIG_DELETE } from '@/app/api/settings/membership/volunteer-designations/route';
import { GET as AUDIT_LOG_GET } from '@/app/api/system-status/audit-log/route';
import { GET as SS_ERRORS_GET } from '@/app/api/system-status/errors/route';
import { GET as SS_LINKS_GET } from '@/app/api/system-status/links/route';
import { PATCH as SS_LINK_PATCH } from '@/app/api/system-status/links/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'authz-rolereject-test';

function as(id: number, extra: Record<string, unknown> = {}) {
    (getServerSession as jest.Mock).mockResolvedValue({
        user: { id, isSysadmin: false, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false, ...extra },
    });
}
function anon() {
    (getServerSession as jest.Mock).mockResolvedValue(null);
}
// authenticateRequest reads req.headers/url/method; the hand-rolled routes read
// req.json()/params. A plain (polyfilled) Request covers all of these — none of
// these routes touch req.nextUrl. next/server is mocked, so NextRequest is N/A.
function nreq(url = 'http://localhost/api/x', method = 'GET', body?: unknown) {
    return new Request(url, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as never;
}
function idCtx(id: string | number) {
    return { params: Promise.resolve({ id: String(id) }) } as never;
}

/**
 * Each role-gated case: invoke(req) calls the handler with whatever ctx/body it
 * needs. We mock the session per call. A plain user (plainId, no role flags)
 * must get 403; no session must get 401.
 */
type Case = { name: string; invoke: () => Promise<Response> };

describe('Protected-route role rejection', () => {
    let plainId = 0, plainHh = 0;
    let eventId = 0, programId = 0;
    // events/[id] PATCH IDOR fixtures: an event owned by ownerLead's program, and
    // foreignLead = lead of a DIFFERENT program (the cross-program attacker).
    let ownerLeadId = 0, foreignLeadId = 0, ownedEventId = 0;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        await prisma.event.deleteMany({ where: { program: { name: { contains: TAG } } } });
        await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
        if (ids.length) {
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
    }

    beforeAll(async () => {
        await wipe();
        plainHh = (await prisma.household.create({ data: { name: `Plain HH ${TAG}` } })).id;
        plainId = (await prisma.person.create({ data: { name: `Plain ${TAG}`, householdId: plainHh } })).id;
        // A real event so events/[id] GET reaches its in-handler staff gate
        // (a missing event short-circuits to 404 before the 403).
        const prog = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Prog ${TAG}` } });
        programId = prog.id;
        eventId = (await prisma.event.create({
            data: { programId, name: `Evt ${TAG}`, startAt: new Date('2030-01-01T10:00:00Z'), endAt: new Date('2030-01-01T12:00:00Z') },
        })).id;

        // events/[id] PATCH IDOR setup: an event whose program is led by ownerLead,
        // plus foreignLead who leads a SEPARATE program (privileged elsewhere, but
        // not staff of ownedEvent — the cross-program attacker).
        const ownerHh = (await prisma.household.create({ data: { name: `Owner HH ${TAG}` } })).id;
        ownerLeadId = (await prisma.person.create({ data: { name: `OwnerLead ${TAG}`, householdId: ownerHh } })).id;
        const ownedProgram = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Owned Prog ${TAG}`, leadMentorId: ownerLeadId } });
        ownedEventId = (await prisma.event.create({
            data: { programId: ownedProgram.id, name: `Owned Evt ${TAG}`, startAt: new Date('2030-02-01T10:00:00Z'), endAt: new Date('2030-02-01T12:00:00Z') },
        })).id;
        const foreignHh = (await prisma.household.create({ data: { name: `Foreign HH ${TAG}` } })).id;
        foreignLeadId = (await prisma.person.create({ data: { name: `ForeignLead ${TAG}`, householdId: foreignHh } })).id;
        await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Foreign Prog ${TAG}`, leadMentorId: foreignLeadId } });
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    beforeEach(() => jest.clearAllMocks());

    // ---- ROLE-GATED: 401 unauthenticated + 403 plain user ---------------------
    const roleGated: Case[] = [
        { name: 'PATCH /api/membership-ops/households/[id]', invoke: () => ADMIN_HH_PATCH(nreq('http://localhost/api/membership-ops/households/1', 'PATCH', {}), idCtx(1)) },
        { name: 'POST /api/membership-ops/participants', invoke: () => PARTICIPANTS_POST(nreq('http://localhost/api/membership-ops/participants', 'POST', {})) },
        { name: 'PUT /api/membership-ops/participants/[id]', invoke: () => PARTICIPANT_PUT(nreq('http://localhost/api/membership-ops/participants/1', 'PUT', {}), idCtx(1)) },
        { name: 'POST /api/membership-ops/participants/[id]/household', invoke: () => PARTICIPANT_HH_POST(nreq('http://localhost/api/membership-ops/participants/1/household', 'POST', {}), idCtx(1)) },
        { name: 'POST /api/membership-ops/participants/import', invoke: () => IMPORT_POST(nreq('http://localhost/api/membership-ops/participants/import', 'POST')) },
        { name: 'POST /api/membership-ops/participants/merge', invoke: () => MERGE_POST(nreq('http://localhost/api/membership-ops/participants/merge', 'POST', {})) },
        { name: 'GET /api/membership-ops/participants/merge/analyze', invoke: () => MERGE_ANALYZE_GET(nreq('http://localhost/api/membership-ops/participants/merge/analyze')) },
        { name: 'POST /api/membership-ops/participants/import/preview', invoke: () => IMPORT_PREVIEW_POST(nreq('http://localhost/api/membership-ops/participants/import/preview', 'POST')) },
        { name: 'GET /api/system-status/health', invoke: () => SYSTEM_HEALTH_GET(nreq('http://localhost/api/system-status/health')) },
        { name: 'GET /api/facility/trends', invoke: () => TRENDS_GET(nreq('http://localhost/api/facility/trends')) },
        { name: 'GET /api/safety/trusted-adults', invoke: () => ADMIN_TA_GET(nreq('http://localhost/api/safety/trusted-adults')) },
        { name: 'POST /api/safety/trusted-adults/override', invoke: () => TA_OVERRIDE_POST(nreq('http://localhost/api/safety/trusted-adults/override', 'POST', {})) },
        { name: 'PATCH /api/shop/tools/[id]', invoke: () => SHOP_TOOL_PATCH(nreq('http://localhost/api/shop/tools/1', 'PATCH', {}), idCtx(1)) },
        // P0-B2: routes collapsed from getServerSession onto the withAuth roles gate.
        // (finance-ops/payment-plans POST is covered in programPaymentPlansAPI; its GET is now a handler().)
        { name: 'GET /api/events (standalone list)', invoke: () => EVENTS_LIST_GET(nreq('http://localhost/api/events')) },
        { name: 'POST /api/programs', invoke: () => PROGRAMS_POST(nreq('http://localhost/api/programs', 'POST', {})) },
        { name: 'POST /api/programs/[id]/sync-shopify', invoke: () => PROGRAM_SYNC_SHOPIFY_POST(nreq('http://localhost/api/programs/1/sync-shopify', 'POST', {}), idCtx(1)) },

        // ---- drift-guard sweep: one row per method of each role-gated route ----
        // The withAuth roles gate fires before any body/param work, so dummy
        // params and empty bodies reach it. All gated on isSysadmin|isBoardMember
        // unless noted.
        { name: 'GET /api/admin/broken-households', invoke: () => BROKEN_HH_GET(nreq('http://localhost/api/admin/broken-households')) },
        { name: 'GET /api/admin/settings/localization', invoke: () => LOCALIZATION_GET(nreq('http://localhost/api/admin/settings/localization')) },
        { name: 'PUT /api/admin/settings/localization (sysadmin-only)', invoke: () => LOCALIZATION_PUT(nreq('http://localhost/api/admin/settings/localization', 'PUT', {})) },
        { name: 'GET /api/facility/badges', invoke: () => BADGES_GET(nreq('http://localhost/api/facility/badges')) },
        // Payment problems queue (the Shopify reconciler's triage rows): family +
        // order + what went wrong, board/sysadmin only.
        { name: 'GET /api/finance-ops/payments', invoke: () => FIN_PAYMENTS_GET(nreq('http://localhost/api/finance-ops/payments')) },
        { name: 'PATCH /api/finance-ops/payments/[id]', invoke: () => FIN_PAYMENTS_PATCH(nreq('http://localhost/api/finance-ops/payments/1', 'PATCH', {}), idCtx(1)) },
        { name: 'GET /api/facility/visits', invoke: () => FAC_VISITS_GET(nreq('http://localhost/api/facility/visits')) },
        { name: 'PATCH /api/facility/visits', invoke: () => FAC_VISITS_PATCH(nreq('http://localhost/api/facility/visits', 'PATCH', {})) },
        { name: 'DELETE /api/facility/visits', invoke: () => FAC_VISITS_DELETE(nreq('http://localhost/api/facility/visits', 'DELETE', {})) },
        // Staff insert-for-others: personId comes from the body, so the role gate
        // is the entire subject boundary — a wrong-role caller must never reach it.
        { name: 'POST /api/facility/visits/insert', invoke: () => FAC_VISITS_INSERT_POST(nreq('http://localhost/api/facility/visits/insert', 'POST', {})) },
        { name: 'GET /api/membership-audit/households-missing-contact', invoke: () => MISSING_CONTACT_GET(nreq('http://localhost/api/membership-audit/households-missing-contact')) },
        { name: 'GET /api/membership-audit/unclaimed-households', invoke: () => UNCLAIMED_GET(nreq('http://localhost/api/membership-audit/unclaimed-households')) },
        { name: 'GET /api/membership-audit/turning-18', invoke: () => TURNING_18_GET(nreq('http://localhost/api/membership-audit/turning-18')) },
        { name: 'POST /api/membership-ops/applications/certify-payment', invoke: () => CERTIFY_PAYMENT_POST(nreq('http://localhost/api/membership-ops/applications/certify-payment', 'POST', {})) },
        { name: 'POST /api/membership-ops/applications/external', invoke: () => APP_EXTERNAL_POST(nreq('http://localhost/api/membership-ops/applications/external', 'POST', {})) },
        { name: 'POST /api/membership-ops/applications/review-override', invoke: () => REVIEW_OVERRIDE_POST(nreq('http://localhost/api/membership-ops/applications/review-override', 'POST', {})) },
        { name: 'POST /api/membership-ops/applications/archive', invoke: () => APP_ARCHIVE_POST(nreq('http://localhost/api/membership-ops/applications/archive', 'POST', {})) },
        { name: 'POST /api/membership-ops/applications/unarchive', invoke: () => APP_UNARCHIVE_POST(nreq('http://localhost/api/membership-ops/applications/unarchive', 'POST', {})) },
        { name: 'DELETE /api/membership-ops/bg-attestations/[id] (sysadmin-only)', invoke: () => BG_ATTEST_DELETE(nreq('http://localhost/api/membership-ops/bg-attestations/1', 'DELETE', { reason: 'test' }), idCtx(1)) },
        { name: 'GET /api/membership-ops/households (collection)', invoke: () => MOPS_HH_GET(nreq('http://localhost/api/membership-ops/households')) },
        { name: 'POST /api/membership-ops/households (collection)', invoke: () => MOPS_HH_POST(nreq('http://localhost/api/membership-ops/households', 'POST', {})) },
        { name: 'GET /api/membership-ops/volunteer-memberships', invoke: () => VOL_ROSTER_GET(nreq('http://localhost/api/membership-ops/volunteer-memberships')) },
        { name: 'POST /api/membership/reviews (backgroundCheckReviewer-only)', invoke: () => REVIEWS_POST(nreq('http://localhost/api/membership/reviews', 'POST', {})) },
        { name: 'GET /api/roles', invoke: () => ROLES_GET(nreq('http://localhost/api/roles')) },
        { name: 'PATCH /api/roles', invoke: () => ROLES_PATCH(nreq('http://localhost/api/roles', 'PATCH', {})) },
        { name: 'GET /api/safety/board-contacts', invoke: () => BOARD_CONTACTS_GET(nreq('http://localhost/api/safety/board-contacts')) },
        { name: 'POST /api/safety/trusted-adults/decision', invoke: () => TA_DECISION_POST(nreq('http://localhost/api/safety/trusted-adults/decision', 'POST', {})) },
        { name: 'GET /api/settings/membership', invoke: () => SETTINGS_MEMBERSHIP_GET(nreq('http://localhost/api/settings/membership')) },
        { name: 'PUT /api/settings/membership', invoke: () => SETTINGS_MEMBERSHIP_PUT(nreq('http://localhost/api/settings/membership', 'PUT', {})) },
        { name: 'POST /api/settings/membership/bulk-open-renewals', invoke: () => BULK_RENEWALS_POST(nreq('http://localhost/api/settings/membership/bulk-open-renewals', 'POST', {})) },
        { name: 'GET /api/settings/membership/volunteer-designations', invoke: () => VOL_DESIG_GET(nreq('http://localhost/api/settings/membership/volunteer-designations')) },
        { name: 'POST /api/settings/membership/volunteer-designations', invoke: () => VOL_DESIG_POST(nreq('http://localhost/api/settings/membership/volunteer-designations', 'POST', {})) },
        { name: 'DELETE /api/settings/membership/volunteer-designations', invoke: () => VOL_DESIG_DELETE(nreq('http://localhost/api/settings/membership/volunteer-designations', 'DELETE')) },
        { name: 'GET /api/system-status/audit-log', invoke: () => AUDIT_LOG_GET(nreq('http://localhost/api/system-status/audit-log')) },
        { name: 'GET /api/system-status/errors', invoke: () => SS_ERRORS_GET(nreq('http://localhost/api/system-status/errors')) },
        { name: 'GET /api/system-status/links', invoke: () => SS_LINKS_GET(nreq('http://localhost/api/system-status/links')) },
        // links/[id] is a GLOBAL admin resource (integrationErrorLog keyed by a
        // global id, no household scoping) — the roles gate IS the boundary, so
        // no cross-tenant 404 case applies here.
        { name: 'PATCH /api/system-status/links/[id]', invoke: () => SS_LINK_PATCH(nreq('http://localhost/api/system-status/links/1', 'PATCH', {}), idCtx(1)) },
    ];

    describe.each(roleGated)('$name', ({ invoke }) => {
        it('401 when unauthenticated', async () => {
            anon();
            expect((await invoke()).status).toBe(401);
        });
        it('403 for a plain authenticated user (no privileged role)', async () => {
            as(plainId, { householdId: plainHh });
            expect((await invoke()).status).toBe(403);
        });
    });

    // ---- bg-attestations DELETE — sysadmin-only, NOT board (#1456 Decision 3) --
    // Attestations are review artifacts, not a membership decision, so the
    // board's usual "board OR sysadmin" reach does not extend here.
    describe('DELETE /api/membership-ops/bg-attestations/[id] — board alone is denied', () => {
        it('403s a board member who is not also sysadmin', async () => {
            as(plainId, { householdId: plainHh, isBoardMember: true });
            const res = await BG_ATTEST_DELETE(nreq('http://localhost/api/membership-ops/bg-attestations/1', 'DELETE', { reason: 'test' }), idCtx(1));
            expect(res.status).toBe(403);
        });
    });

    // ---- Operations gets the Participants directory (read + membership-ops/
    // contacts create) only — every edit/rich-create participants endpoint stays
    // board/sysadmin-only. isOperations must still 403 here (contrast with
    // membership-ops/contacts, the one endpoint operations DOES clear — see its
    // own integration suite).
    const participantsEditRoutes = roleGated.filter((c) => c.name.includes('/membership-ops/participants'));
    describe.each(participantsEditRoutes)('$name — operations-only is denied', ({ invoke }) => {
        it('403s an operations-only actor', async () => {
            as(plainId, { householdId: plainHh, isOperations: true });
            expect((await invoke()).status).toBe(403);
        });
    });

    // ---- Facility Ops — operations reaches the aggregate, not the record ------
    // #1633 [Decision]: operations reach attendance in aggregate only — the
    // trends, and printing the ID badges (whose /api/people/search + /api/programs
    // already admit them). One person's record sits outside that reach: they do
    // not record, correct or remove a visit, and do not read the raw badge events
    // behind one. So trends must NOT 401/403 an operations actor, and every
    // /api/facility/visits verb plus the raw badge log must 403 them.
    const facilityOpsGrantedNames = ['GET /api/facility/trends'];
    const facilityOpsWithheldNames = [
        'GET /api/facility/badges',
        'GET /api/facility/visits',
        'PATCH /api/facility/visits',
        'DELETE /api/facility/visits',
        'POST /api/facility/visits/insert',
    ];
    const byName = (names: string[]) => roleGated.filter((c) => names.includes(c.name));
    const facilityOpsGranted = byName(facilityOpsGrantedNames);
    const facilityOpsWithheld = byName(facilityOpsWithheldNames);
    // Guard: the filters match on literal names, so a renamed or removed case
    // would silently shrink a sweep instead of failing it.
    it('guard: every Facility Ops route named above is present in the harness', () => {
        expect([...facilityOpsGranted, ...facilityOpsWithheld].map((c) => c.name).sort())
            .toEqual([...facilityOpsGrantedNames, ...facilityOpsWithheldNames].sort());
    });
    describe.each(facilityOpsGranted)('$name — operations clears the gate', ({ invoke }) => {
        it('does not 401/403 an operations actor', async () => {
            as(plainId, { householdId: plainHh, isOperations: true });
            const status = (await invoke()).status;
            expect(status).not.toBe(401);
            expect(status).not.toBe(403);
        });
    });
    describe.each(facilityOpsWithheld)('$name — operations is denied', ({ invoke }) => {
        it('403s an operations-only actor', async () => {
            as(plainId, { householdId: plainHh, isOperations: true });
            expect((await invoke()).status).toBe(403);
        });
    });

    // ---- membership/reviews POST — reviewer PII boundary ----------------------
    // The attestation surface exposes applicant parents' names/emails. Reviewers
    // AND board members (implicit reviewers, canReviewBackgroundChecks) may pass;
    // any other privileged-but-wrong role (e.g. isKeyholder) must be denied. A
    // board member clears the role gate and stops at body validation (400, not
    // 403); a keyholder is rejected at the gate.
    describe('POST /api/membership/reviews — privileged role gate', () => {
        it('board member passes the role gate (400 bad body, not 403)', async () => {
            as(plainId, { householdId: plainHh, isBoardMember: true });
            expect((await REVIEWS_POST(nreq('http://localhost/api/membership/reviews', 'POST', {}))).status).toBe(400);
        });
        it('403 for a isKeyholder without reviewer/board role', async () => {
            as(plainId, { householdId: plainHh, isKeyholder: true });
            expect((await REVIEWS_POST(nreq('http://localhost/api/membership/reviews', 'POST', {}))).status).toBe(403);
        });
    });

    // ---- events/[id] — fail-closed staff-only roster gate ---------------------
    // GET is on the security handler() for field-tiering, but the roster (who is
    // enrolled / RSVP'd / attended) is staff-only: a participant's name/id and
    // the existence of their enrollment/RSVP/Visit row are tier 'public', so
    // per-field stripping can't hide the "who attends" association. The handler fn
    // gates admission inline (event -> program lead/core-vol/admin) and 403s
    // everyone else, so a non-staff caller never receives the roster.
    describe('events/[id]', () => {
        it('GET 401 when unauthenticated', async () => {
            anon();
            expect((await EVENT_GET(nreq(`http://localhost/api/events/${eventId}`), idCtx(eventId))).status).toBe(401);
        });
        it('GET 403 for a plain user who is not event staff (roster gate)', async () => {
            as(plainId, { householdId: plainHh });
            expect((await EVENT_GET(nreq(`http://localhost/api/events/${eventId}`), idCtx(eventId))).status).toBe(403);
        });
        it('PATCH 401 when unauthenticated', async () => {
            anon();
            const res = await EVENT_PATCH(nreq(`http://localhost/api/events/${eventId}`, 'PATCH', { action: 'cancel' }), idCtx(eventId));
            expect(res.status).toBe(401);
        });
        // IDOR boundary (route migrated in #571): the gate is the inline
        // `event.program.leadMentorId === caller` check. A lead of a DIFFERENT
        // program must be 403'd AND must not mutate the event — a 403 that still
        // wrote would be the real bug. Re-read to pin it. Mirrors fd192fc.
        it('PATCH 403 for a lead of a DIFFERENT program (confirmAttendance) — and the event is untouched', async () => {
            as(foreignLeadId);
            const before = await prisma.event.findUnique({ where: { id: ownedEventId }, select: { attendanceConfirmedAt: true, attendanceConfirmedById: true } });
            expect(before?.attendanceConfirmedAt).toBeNull();
            const res = await EVENT_PATCH(nreq(`http://localhost/api/events/${ownedEventId}`, 'PATCH', { action: 'confirmAttendance' }), idCtx(ownedEventId));
            expect(res.status).toBe(403);
            const after = await prisma.event.findUnique({ where: { id: ownedEventId }, select: { attendanceConfirmedAt: true, attendanceConfirmedById: true } });
            expect(after?.attendanceConfirmedAt).toBeNull();
            expect(after?.attendanceConfirmedById).toBeNull();
        });
        it('PATCH 403 for a lead of a DIFFERENT program (cancel) — and the event survives', async () => {
            as(foreignLeadId);
            const res = await EVENT_PATCH(nreq(`http://localhost/api/events/${ownedEventId}`, 'PATCH', { action: 'cancel' }), idCtx(ownedEventId));
            expect(res.status).toBe(403);
            expect(await prisma.event.findUnique({ where: { id: ownedEventId } })).not.toBeNull();
        });
    });

    // ---- AUTH-ONLY (withAuth({})): only 401 is a real negative ----------------
    // These have no role/ownership boundary — a plain authenticated user is
    // admitted by design. We assert 401 for the anon caller and that the plain
    // user is NOT rejected with 403.
    const authOnly: { name: string; invoke: () => Promise<Response> }[] = [
        { name: 'GET /api/notifications', invoke: () => NOTIFICATIONS_GET(nreq('http://localhost/api/notifications')) },
        { name: 'POST /api/membership/contract/sync', invoke: () => CONTRACT_SYNC_POST(nreq('http://localhost/api/membership/contract/sync', 'POST')) },
        { name: 'POST /api/profile/onboarding', invoke: () => ONBOARDING_POST(nreq('http://localhost/api/profile/onboarding', 'POST', { completed: true })) },
    ];

    describe.each(authOnly)('$name (auth-only)', ({ invoke }) => {
        it('401 when unauthenticated', async () => {
            anon();
            expect((await invoke()).status).toBe(401);
        });
        it('plain authenticated user is admitted by design (not 401/403)', async () => {
            as(plainId, { householdId: plainHh });
            const status = (await invoke()).status;
            expect(status).not.toBe(401);
            expect(status).not.toBe(403);
        });
    });
});
