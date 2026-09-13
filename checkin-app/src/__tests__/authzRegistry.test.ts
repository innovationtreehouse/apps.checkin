import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Drift guard for negative-authz coverage — the authz analogue of
 * pageRegistry.test.ts. Every API route that declares a `roles:` list (the
 * withAuth role gate) is a privilege boundary; a weakened or dropped `roles:`
 * array would ship silently unless a test asserts an anon caller gets 401 and a
 * plain authenticated user gets 403.
 *
 * This walks src/app/api for every route.ts containing a `roles:` gate and
 * asserts each is listed in AUTHZ_TESTED (has a negative-authz integration
 * test) or AUTHZ_EXCLUDED (deliberately untested, with a stated reason). A new
 * role-gated route added without a deny-path test fails this test.
 *
 * Scope is the `roles:` withAuth gate ONLY — the deterministic, team-trusted
 * signal that already governs `roles` in src/lib/auth.ts. Hand-rolled
 * getServerSession routes (programs/*, shop/*, events/*, …) mix role checks
 * with ownership and are out of scope here; their boundaries live in the
 * ownership-boundary suite.
 *
 * The negative-authz tests themselves are integration tests (real Postgres,
 * INTEGRATION_DB=1) so they are NOT in the default jest run — but THIS guard is
 * a plain unit test that does run by default, so the drift is caught in CI even
 * though the integration suite is not yet gated.
 */

// Route identifier = path under src/app/api with the trailing /route.ts removed,
// e.g. 'admin/broken-households', 'system-status/links/[id]'.
function routeId(file: string): string {
    return file.replace(/.*\/src\/app\/api\//, '').replace(/\/route\.ts$/, '');
}

function findRoutes(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...findRoutes(full));
        else if (entry.name === 'route.ts') out.push(full);
    }
    return out;
}

// A route is role-gated iff it passes a `roles: [...]` list to withAuth.
function isRoleGated(file: string): boolean {
    return /\broles:\s*\[/.test(readFileSync(file, 'utf8'));
}

/**
 * Role-gated routes with a negative-authz test (401 anon + 403 plain user).
 * Coverage lives in:
 *   - src/app/__tests__/authzRoleRejection.integration.test.ts
 *   - src/app/__tests__/authzRoutes.integration.test.ts
 *   - src/app/__tests__/authzOwnershipBoundary.integration.test.ts
 */
const AUTHZ_TESTED = new Set<string>([
    'admin/broken-households',
    // POST deny-path (401 anon / 403 non-board) in programPaymentPlansAPI.integration.test.ts.
    'finance-ops/payment-plans',
    // POST deny-path (401 anon / 403 non-board) in programPaymentPlansAPI.integration.test.ts.
    'finance-ops/payment-plans/refuse',
    // POST deny-path (401 anon / 403 non-board) in programPaymentPlansAPI.integration.test.ts.
    'finance-ops/payment-plans/manual-hold',
    // POST deny-path (401 anon / 403 non-board) in membershipPaymentPlansAPI.integration.test.ts.
    'finance-ops/membership-payment-plans',
    // POST deny-path (401 anon / 403 non-board) in membershipPaymentPlansAPI.integration.test.ts.
    'finance-ops/membership-payment-plans/refuse',
    'admin/settings/localization',
    // facility/badges dropped: its only verb (GET) is handler()-governed now,
    // so the file carries no `roles:` gate and would fail the stale-entry test.
    'facility/trends',
    // GET is handler()-governed; PATCH/DELETE still carry withAuth roles.
    'facility/visits',
    // facility/visits/insert dropped: handler()-governed now (POST), so the
    // file carries no `roles:` gate and would fail the stale-entry test.
    'finance-ops/payments',
    'finance-ops/payments/[id]',
    // POST + GET deny-paths (401 anon / 403 non-board) in s-read/sync/__tests__/route.test.ts,
    // which also assert a denied request never invokes the Lambda or reads the mirror.
    'finance-ops/s-read/sync',
    // GET deny-path (401 anon / 403 non-board) in s-read/diagnose/__tests__/route.test.ts,
    // which also asserts a denied request never probes the mirror or the Lambda.
    'finance-ops/s-read/diagnose',
    // GET deny-path (401 anon / 403 non-board) in s-read/match-audit/__tests__/route.test.ts,
    // which also asserts a denied request never runs the audit.
    'finance-ops/s-read/match-audit',
    // POST deny-path (401 anon / 403 non-board) in s-read/match-audit/track/__tests__/route.test.ts,
    // which also asserts a denied request never raises a PaymentException.
    'finance-ops/s-read/match-audit/track',
    'kioskdisplay/certifications',
    'membership-audit/compliance',
    // POST deny-path (403 non-board) in personBgManualSubmit.integration.test.ts.
    'membership-audit/person-bg',
    'membership-audit/households-missing-contact',
    'membership-audit/unclaimed-households',
    'membership-ops/applications/archive',
    'membership-ops/applications/unarchive',
    'membership-ops/applications/certify-payment',
    'membership-ops/applications/external',
    'membership-ops/applications/review-override',
    // 401/403 deny-path in authzRoleRejection.integration.test.ts, incl. a
    // dedicated board-alone-is-denied case (sysadmin-only, not board).
    'membership-ops/bg-attestations/[id]',
    // POST deny-path (401 anon / 403 plain / 403 sysadmin-excluded) in
    // membership-ops/contacts/__tests__/route.integration.test.ts.
    'membership-ops/contacts',
    'membership-ops/households',
    'membership-ops/households/[id]',
    'membership-ops/participants',
    'membership-ops/participants/[id]',
    'membership-ops/participants/[id]/household',
    'membership-ops/participants/import',
    'membership-ops/participants/import/preview',
    'membership-ops/participants/merge',
    'membership-ops/participants/merge/analyze',
    'membership-ops/volunteer-memberships',
    'membership/reviews',
    'people/search',
    'programs',
    // POST deny-path (401 anon / 403 non-board) in authzRoleRejection.integration.test.ts.
    'programs/[id]/sync-shopify',
    'roles',
    'safety/emergency-contacts',
    'safety/trusted-adults/decision',
    'safety/trusted-adults/override',
    'settings/email',
    'settings/membership',
    'settings/membership/bulk-open-renewals',
    // POST deny-path (401 anon / 403 non-board) in its colocated unit test,
    // api/settings/membership/extract-variant/__tests__/route.test.ts (no DB —
    // the route never touches Prisma, only the pinned Shopify fetch).
    'settings/membership/extract-variant',
    'settings/membership/volunteer-designations',
    // GET deny-path (401 anon / 403 non-board) unit-tested through the real
    // withAuth in api/settings/shopify-webhook/__tests__/route.test.ts.
    'settings/shopify-webhook',
    'shop/tools/[id]',
    'system-status/audit-log',
    'system-status/health',
    'system-status/links/[id]',
    // GET deny-path (401 anon / 403 non-board) in lifecycleReconcile.integration.test.ts.
    'system-status/lifecycle',
]);

// Role-gated routes deliberately WITHOUT a negative-authz test. Each entry must
// state why (e.g. covered transitively, or a justified gap). Empty today —
// every role-gated route is tested.
const AUTHZ_EXCLUDED: Record<string, string> = {};

describe('authz negative-coverage drift guard', () => {
    const apiDir = join(__dirname, '..', 'app', 'api');
    const roleGated = findRoutes(apiDir).filter(isRoleGated).map(routeId);
    const known = new Set([...AUTHZ_TESTED, ...Object.keys(AUTHZ_EXCLUDED)]);

    it('every role-gated route has a negative-authz test or a documented exclusion', () => {
        const missing = roleGated.filter((r) => !known.has(r));
        expect(missing).toEqual([]);
    });

    it('has no AUTHZ_TESTED/EXCLUDED entry pointing at a route that is no longer role-gated', () => {
        const live = new Set(roleGated);
        const stale = [...known].filter((r) => !live.has(r));
        expect(stale).toEqual([]);
    });

    it('no route is both tested and excluded', () => {
        const both = [...AUTHZ_TESTED].filter((r) => r in AUTHZ_EXCLUDED);
        expect(both).toEqual([]);
    });
});
