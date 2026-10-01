/**
 * Unit tests for the admission gate (resolveAccess). Pure: no DB, no HTTP.
 * Focus on the 'self' case binding to the resource id param — a latent IDOR
 * guard, so it must fail closed on a present-but-mismatched id.
 */
import { resolveAccess, type ResolverContext } from '@/security/access-resolvers';
import type { AuthResult } from '@/types/auth';

const session = (id: number): AuthResult => ({
    type: 'session',
    user: {
        id,
        email: 'u@x.test',
        isSysadmin: false,
        isBoardMember: false,
        isKeyholder: false,
        isBackgroundCheckReviewer: false,
        isOperations: false,
        isInventoryManager: false,
    },
});

const rctx = (
    auth: AuthResult,
    params: Record<string, string> = {},
    callerOverrides: Partial<ResolverContext['callerContext']> = {},
): ResolverContext => ({
    auth,
    params,
    callerContext: {
        selfId: auth.type === 'session' ? auth.user.id : undefined,
        householdId: undefined,
        isKeyholder: false,
        isKiosk: false,
        programsLed: new Set(),
        programsCoreVolIn: new Set(),
        participantIdsInScopePrograms: new Set(),
        householdIdsInScopePrograms: new Set(),
        eventIdsInScopePrograms: new Set(),
        activeVisitorIds: new Set(),
        ledHouseholdMemberIds: new Set(),
        ...callerOverrides,
    },
});

describe("resolveAccess 'self'", () => {
    test('no id param + session → allowed (handler scopes itself, e.g. GET /api/profile)', async () => {
        expect((await resolveAccess('self', rctx(session(42)))).allowed).toBe(true);
    });

    test('matching id param → allowed', async () => {
        expect((await resolveAccess('self', rctx(session(42), { id: '42' }))).allowed).toBe(true);
    });

    test('mismatched id param → denied (IDOR fail-closed)', async () => {
        expect((await resolveAccess('self', rctx(session(42), { id: '43' }))).allowed).toBe(false);
    });

    test('non-numeric id param → denied', async () => {
        expect((await resolveAccess('self', rctx(session(42), { id: 'abc' }))).allowed).toBe(false);
    });

    test('no session → denied', async () => {
        expect((await resolveAccess('self', rctx({ type: 'unauthenticated' }, { id: '42' }))).allowed).toBe(false);
    });
});

// The branches below are real authorize values (access-resolvers.ts switch) but no
// route in the current registry uses them, so registryAuthz marks them 'unhandled'
// and never drives them through resolveAccess. Cover each one allowed + denied here.

describe("resolveAccess 'program-lead-mentor'", () => {
    test('caller leads the program in the id param → allowed', async () => {
        expect(
            (await resolveAccess('program-lead-mentor', rctx(session(1), { id: '5' }, { programsLed: new Set([5]) }))).allowed,
        ).toBe(true);
    });

    test('admin who does not lead it → allowed (admin bypass)', async () => {
        const admin = session(1);
        if (admin.type === 'session') admin.user.isSysadmin = true;
        expect((await resolveAccess('program-lead-mentor', rctx(admin, { id: '5' }))).allowed).toBe(true);
    });

    test('caller does not lead the program and is not admin → denied', async () => {
        expect((await resolveAccess('program-lead-mentor', rctx(session(1), { id: '5' }))).allowed).toBe(false);
    });

    test('non-numeric id → denied', async () => {
        expect(
            (await resolveAccess('program-lead-mentor', rctx(session(1), { id: 'abc' }, { programsLed: new Set([5]) }))).allowed,
        ).toBe(false);
    });
});

describe("resolveAccess 'program-core-volunteer'", () => {
    test('caller is a core volunteer of the program in the id param → allowed', async () => {
        expect(
            (await resolveAccess('program-core-volunteer', rctx(session(1), { id: '5' }, { programsCoreVolIn: new Set([5]) }))).allowed,
        ).toBe(true);
    });

    test('caller is not a core volunteer and not admin → denied', async () => {
        expect((await resolveAccess('program-core-volunteer', rctx(session(1), { id: '5' }))).allowed).toBe(false);
    });
});

describe("resolveAccess 'household-lead'", () => {
    test('caller is a household lead → allowed', async () => {
        const lead = session(1);
        if (lead.type === 'session') lead.user.householdLead = true;
        expect((await resolveAccess('household-lead', rctx(lead))).allowed).toBe(true);
    });

    test('authenticated caller who is not a lead (and not admin) → denied', async () => {
        expect((await resolveAccess('household-lead', rctx(session(1)))).allowed).toBe(false);
    });

    test('no session → denied', async () => {
        expect((await resolveAccess('household-lead', rctx({ type: 'unauthenticated' }))).allowed).toBe(false);
    });
});

describe("resolveAccess 'certifier'", () => {
    const certifier = (id: number): AuthResult => ({
        type: 'session',
        user: {
            id,
            email: 'c@x.test',
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
            isInventoryManager: false,
            toolStatuses: [{ toolId: 1, level: 'MAY_CERTIFY_OTHERS' }],
        },
    });

    test('caller holding a MAY_CERTIFY_OTHERS toolStatus → allowed', async () => {
        expect((await resolveAccess('certifier', rctx(certifier(1)))).allowed).toBe(true);
    });

    test('admin who is not a certifier → allowed (admin bypass)', async () => {
        const admin = session(1);
        if (admin.type === 'session') admin.user.isSysadmin = true;
        expect((await resolveAccess('certifier', rctx(admin))).allowed).toBe(true);
    });

    test('authenticated caller with only a CERTIFIED (not MAY_CERTIFY_OTHERS) status → denied', async () => {
        const u = session(1);
        if (u.type === 'session') u.user.toolStatuses = [{ toolId: 1, level: 'CERTIFIED' }];
        expect((await resolveAccess('certifier', rctx(u))).allowed).toBe(false);
    });

    test('plain authenticated caller (no toolStatuses) → denied', async () => {
        expect((await resolveAccess('certifier', rctx(session(1)))).allowed).toBe(false);
    });

    test('no session → denied', async () => {
        expect((await resolveAccess('certifier', rctx({ type: 'unauthenticated' }))).allowed).toBe(false);
    });
});

describe("resolveAccess 'kiosk'", () => {
    test('kiosk caller → allowed', async () => {
        expect((await resolveAccess('kiosk', rctx({ type: 'kiosk' }))).allowed).toBe(true);
    });

    test('a normal session (not kiosk) → denied', async () => {
        expect((await resolveAccess('kiosk', rctx(session(1)))).allowed).toBe(false);
    });
});

/**
 * ops-stg ACCESS GATE — the regression coverage for the defect that killed the prior
 * staging design. `authorize: 'public'` (case above, line ~220 in access-resolvers.ts)
 * unconditionally returns `{ allowed: true }`, which is exactly right in every normal
 * environment but is precisely the surface that would ship real minors' data to an
 * anonymous `curl` of `GET /api/programs/[id]` on ops-stg. The gate must be checked
 * BEFORE the `authorize` switch, for every authorize value, not only session-gated ones.
 */
describe("resolveAccess — ops-stg access gate (checked ahead of every `authorize` branch)", () => {
    const ORIGINAL_ENV = process.env.CHECKIN_ENV;
    beforeEach(() => { process.env.CHECKIN_ENV = 'stg'; });
    afterEach(() => {
        if (ORIGINAL_ENV === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = ORIGINAL_ENV;
    });

    const orgMember = (): AuthResult => ({
        type: 'session',
        user: {
            id: 1, email: 'org@innovationtreehouse.org',
            isSysadmin: false, isBoardMember: false, isKeyholder: false,
            isBackgroundCheckReviewer: false, isOperations: false,
            isInventoryManager: false,
            hd: 'innovationtreehouse.org', emailVerified: true,
        },
    });
    const nonOrg = (canAccessStaging: boolean): AuthResult => ({
        type: 'session',
        user: {
            id: 2, email: 'stranger@gmail.com',
            isSysadmin: false, isBoardMember: false, isKeyholder: false,
            isBackgroundCheckReviewer: false, isOperations: false,
            isInventoryManager: false,
            hd: 'gmail.com', emailVerified: true, canAccessStaging,
        },
    });

    test("'public' + anonymous (unauthenticated) → DENIED — the regression case", async () => {
        expect((await resolveAccess('public', rctx({ type: 'unauthenticated' }))).allowed).toBe(false);
    });

    test("'public' + kiosk → DENIED (a kiosk carries no org/flag claims either)", async () => {
        expect((await resolveAccess('public', rctx({ type: 'kiosk' }))).allowed).toBe(false);
    });

    test("'public' + verified org member → allowed", async () => {
        expect((await resolveAccess('public', rctx(orgMember()))).allowed).toBe(true);
    });

    test("'public' + non-org, canAccessStaging false → denied", async () => {
        expect((await resolveAccess('public', rctx(nonOrg(false)))).allowed).toBe(false);
    });

    test("'public' + non-org, canAccessStaging true → allowed (the sysadmin-settable escape hatch)", async () => {
        expect((await resolveAccess('public', rctx(nonOrg(true)))).allowed).toBe(true);
    });

    test("a route-level admin bypass (e.g. isSysadmin) still cannot skip the staging gate", async () => {
        const admin = nonOrg(false);
        if (admin.type === 'session') admin.user.isSysadmin = true;
        // 'program-lead-mentor' grants isAdmin a bypass past ITS OWN check — but the
        // staging gate runs first and denies before that bypass is ever consulted.
        expect((await resolveAccess('program-lead-mentor', rctx(admin, { id: '5' }))).allowed).toBe(false);
    });

    test('is inert outside staging: the same anonymous public request is allowed once CHECKIN_ENV is not stg', async () => {
        process.env.CHECKIN_ENV = 'prod';
        expect((await resolveAccess('public', rctx({ type: 'unauthenticated' }))).allowed).toBe(true);
    });
});
