/**
 * Unit tests for the admission gate (resolveAccess). No DB (the one lookup is
 * stubbed), no HTTP.
 * Focus on the 'self' case binding to the resource id param — a latent IDOR
 * guard, so it must fail closed on a present-but-mismatched id.
 */
import { callerHoldsRole, resolveAccess, type ResolverContext } from '@/security/access-resolvers';
import type { Authorize } from '@/security/core';
import type { AuthResult } from '@/types/auth';
import prisma from '@/lib/prisma';

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

describe("resolveAccess 'catalog-viewer'", () => {
    const designated = (emails: string[]) => {
        prisma.volunteerDesignation.findMany = jest.fn().mockResolvedValue(emails.map((email) => ({ email })));
    };
    const withEmail = (email: string): AuthResult => {
        const u = session(1);
        if (u.type === 'session') u.user.email = email;
        return u;
    };

    beforeEach(() => designated([]));

    test('any role flag → allowed', async () => {
        const u = session(1);
        if (u.type === 'session') u.user.isKeyholder = true;
        expect((await resolveAccess('catalog-viewer', rctx(u))).allowed).toBe(true);
    });

    test('program lead → allowed', async () => {
        const u = session(1);
        if (u.type === 'session') u.user.programsLed = [5];
        expect((await resolveAccess('catalog-viewer', rctx(u))).allowed).toBe(true);
    });

    test('designated volunteer, exact email → allowed', async () => {
        designated(['janedoe@gmail.com']);
        expect((await resolveAccess('catalog-viewer', rctx(withEmail('janedoe@gmail.com')))).allowed).toBe(true);
    });

    test('designated volunteer signing in with a dotted, mixed-case Gmail variant → allowed', async () => {
        designated(['janedoe@gmail.com']);
        expect((await resolveAccess('catalog-viewer', rctx(withEmail('Jane.Doe@gmail.com')))).allowed).toBe(true);
    });

    test('a non-canonical stored designation still matches', async () => {
        designated(['Jane.Doe+vol@GoogleMail.com']);
        expect((await resolveAccess('catalog-viewer', rctx(withEmail('janedoe@gmail.com')))).allowed).toBe(true);
    });

    test('dots stay significant outside Gmail → denied', async () => {
        designated(['janedoe@outlook.com']);
        expect((await resolveAccess('catalog-viewer', rctx(withEmail('jane.doe@outlook.com')))).allowed).toBe(false);
    });

    test('plain authenticated caller → denied', async () => {
        expect((await resolveAccess('catalog-viewer', rctx(session(1)))).allowed).toBe(false);
    });

    test('kiosk / no session → denied', async () => {
        expect((await resolveAccess('catalog-viewer', rctx({ type: 'kiosk' }))).allowed).toBe(false);
        expect((await resolveAccess('catalog-viewer', rctx({ type: 'unauthenticated' }))).allowed).toBe(false);
    });
});

// H4 finance vocabulary (#1272 §6, #1280 §4, #1265 §6). One persona per audience:
// finance, board, inventory manager, sysadmin-only, a Treehouse Volunteer (keyholder), and a plain
// household member with no role.
describe('finance vocabulary, catalog-viewer FINANCE admission, widened anyRole', () => {
    const as = (flags: Partial<Extract<AuthResult, { type: 'session' }>['user']>): AuthResult => {
        const a = session(1);
        if (a.type === 'session') Object.assign(a.user, flags);
        return a;
    };
    const personas: Record<string, AuthResult> = {
        finance: as({ isFinance: true }),
        board: as({ isBoardMember: true }),
        inventoryManager: as({ isInventoryManager: true }),
        sysadminOnly: as({ isSysadmin: true }),
        volunteer: as({ isKeyholder: true }),
        familyMember: as({ householdId: 7 }),
    };
    const allowed = async (authorize: Authorize, who: string) =>
        (await resolveAccess(authorize, rctx(personas[who]))).allowed;

    beforeEach(() => {
        // The designation leg of the volunteer predicate reads the DB; nobody here has one.
        prisma.volunteerDesignation.findMany = jest.fn().mockResolvedValue([]);
    });

    test.each([
        ['finance', true], ['board', false], ['sysadminOnly', false], ['volunteer', false], ['familyMember', false],
    ])("'finance' admits %s → %s", async (who, expected) => {
        expect(await allowed('finance', who)).toBe(expected);
    });

    test.each([
        ['finance', true], ['board', true], ['sysadminOnly', false], ['volunteer', false], ['familyMember', false],
    ])("'finance-or-board' admits %s → %s", async (who, expected) => {
        expect(await allowed('finance-or-board', who)).toBe(expected);
    });

    test.each([
        ['finance', true], ['board', true], ['sysadminOnly', true], ['volunteer', true], ['familyMember', false],
    ])("'catalog-viewer' admits %s → %s", async (who, expected) => {
        expect(await allowed('catalog-viewer', who)).toBe(expected);
    });

    test("'catalog-viewer' admits a volunteer designation holder with no role", async () => {
        prisma.volunteerDesignation.findMany = jest.fn().mockResolvedValue([{ email: 'u@x.test' }]);
        expect(await allowed('catalog-viewer', 'familyMember')).toBe(true);
    });

    test.each(['finance', 'finance-or-board'] as const)(
        "'%s' denies a caller with no session", async (authorize) => {
            expect((await resolveAccess(authorize, rctx({ type: 'unauthenticated' }))).allowed).toBe(false);
        },
    );

    test.each([
        ['finance', true], ['board', true], ['inventoryManager', true],
        ['sysadminOnly', false], ['volunteer', false], ['familyMember', false],
    ])("anyRole [isInventoryManager, isFinance, isBoardMember] admits %s → %s", async (who, expected) => {
        const authorize: Authorize = { anyRole: ['isInventoryManager', 'isFinance', 'isBoardMember'] };
        expect((await resolveAccess(authorize, rctx(personas[who]))).allowed).toBe(expected);
    });

    test.each([
        ['sysadminOnly', true], ['board', true], ['finance', false], ['volunteer', false], ['familyMember', false],
    ])("a BusinessRole-only anyRole [isSysadmin, isBoardMember] admits %s → %s", async (who, expected) => {
        expect((await resolveAccess({ anyRole: ['isSysadmin', 'isBoardMember'] }, rctx(personas[who]))).allowed).toBe(expected);
    });

    test.each([
        ['finance', true], ['board', false], ['sysadminOnly', false], ['volunteer', false], ['familyMember', false],
    ])("role 'isFinance' held by %s → %s", (who, expected) => {
        expect(callerHoldsRole('isFinance', personas[who], {}, rctx(personas[who]).callerContext)).toBe(expected);
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
