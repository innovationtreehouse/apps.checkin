/**
 * @jest-environment node
 */
/**
 * Integration tests for POST /api/membership-ops/contacts — the board
 * email-only account-creation endpoint. Real Postgres, INTEGRATION_DB=1.
 *
 * Covers: the happy path (household + lead created via the shared
 * createParticipantWithHousehold builder, matches the unclaimed-households
 * surface, writes a CREATE audit row), the owner-named 409 (the dup check MUST normalize before the lookup or a
 * case-variant slips past to a 500 on the @unique constraint), the deliberate
 * sysadmin exclusion (403 — NOT a bug), operations admission (ops clears
 * this same endpoint), and the standard
 * anon/plain negative-authz pair.
 */
import { POST } from '@/app/api/membership-ops/contacts/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { expectAuditRow } from '@/test-helpers/expectAuditRow';
import { UNCLAIMED_OR_BROKEN_HOUSEHOLD_WHERE } from '@/lib/household/filters';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
// jest.setup.js globally mocks @/lib/auth-options to `{}` (avoids every OTHER
// unit test cascading into next-auth's Google/ESM provider imports). This suite
// calls the route, which imports the REAL createParticipantWithHousehold from
// that module — unmock it here, same as auth-options-jwt.test.ts /
// auth-options-adapter.test.ts. Those two also stub config's Google/NextAuth
// secret reads so the module constructs without real secrets — CI's
// integration-tests job has no .env (gitignored) and sets none of these vars,
// so a local dev .env's dummy values (what this suite relied on before) only
// work on a laptop; mirror the same stub here.
jest.mock('@/lib/config', () => {
    const actual = jest.requireActual('@/lib/config');
    return {
        __esModule: true,
        ...actual,
        config: {
            ...actual.config,
            nextAuthSecret: jest.fn(() => 'test-secret'),
            googleClientId: jest.fn(() => 'gid'),
            googleClientSecret: jest.fn(() => 'gsecret'),
        },
    };
});
jest.unmock('@/lib/auth-options');

// Two tags, two lifetimes (mirrors adminParticipants.integration.test.ts):
// PERSISTENT_TAG fixtures (the actors + the duplicate-email owner) are created
// once in beforeAll and must survive every test; CREATED_TAG is what individual
// tests create via POST, swept after each test without touching the actors.
const PERSISTENT_TAG = 'contacts-persistent-test';
const CREATED_TAG = 'contacts-created-test';

async function wipeByEmailContains(substr: string) {
    const rows = await prisma.person.findMany({ where: { email: { contains: substr } }, select: { householdId: true } });
    const householdIds = [...new Set(rows.map((r) => r.householdId).filter((id): id is number => id != null))];
    await prisma.person.deleteMany({ where: { email: { contains: substr } } });
    if (householdIds.length) {
        await prisma.household.deleteMany({ where: { id: { in: householdIds }, householdMembers: { none: {} } } });
    }
}

function asSession(user: Record<string, unknown> | null) {
    (getServerSession as jest.Mock).mockResolvedValue(user ? { user } : null);
}

// authenticateRequest only reads headers/url/method; the route under test reads
// req.json(). A plain polyfilled Request covers both — `as never` sidesteps the
// handler's NextRequest typing, same convention as authzRoleRejection.integration.test.ts.
function nreq(url: string, method = 'POST', body?: unknown) {
    return new Request(url, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as never;
}

describe('POST /api/membership-ops/contacts', () => {
    let boardId: number;
    let sysadminId: number;
    let opsId: number;
    let plainId: number;
    let plainHh: number;
    let ownerEmail: string;

    beforeAll(async () => {
        await wipeByEmailContains(PERSISTENT_TAG);

        const boardHh = await prisma.household.create({ data: { name: `Board HH ${PERSISTENT_TAG}` } });
        boardId = (await prisma.person.create({
            data: { name: 'Board Actor', email: `board-${PERSISTENT_TAG}@example.com`, isBoardMember: true, householdId: boardHh.id },
        })).id;

        const sysadminHh = await prisma.household.create({ data: { name: `Sysadmin HH ${PERSISTENT_TAG}` } });
        sysadminId = (await prisma.person.create({
            data: { name: 'Sysadmin Actor', email: `sysadmin-${PERSISTENT_TAG}@example.com`, isSysadmin: true, householdId: sysadminHh.id },
        })).id;

        const opsHh = await prisma.household.create({ data: { name: `Ops HH ${PERSISTENT_TAG}` } });
        opsId = (await prisma.person.create({
            data: { name: 'Ops Actor', email: `ops-${PERSISTENT_TAG}@example.com`, householdId: opsHh.id },
        })).id;

        const plainHhRow = await prisma.household.create({ data: { name: `Plain HH ${PERSISTENT_TAG}` } });
        plainHh = plainHhRow.id;
        plainId = (await prisma.person.create({
            data: { name: 'Plain Actor', email: `plain-${PERSISTENT_TAG}@example.com`, householdId: plainHhRow.id },
        })).id;

        // Duplicate-email owner for the 409 tests. Stored lowercase (write-time
        // normalization); the case-variant test uppercases this same address.
        ownerEmail = `jane-${PERSISTENT_TAG}@example.com`;
        const ownerHh = await prisma.household.create({ data: { name: `Owner HH ${PERSISTENT_TAG}` } });
        await prisma.person.create({ data: { name: 'Jane Doe', email: ownerEmail, householdId: ownerHh.id } });
    });

    afterAll(async () => {
        await wipeByEmailContains(PERSISTENT_TAG);
        await prisma.$disconnect();
    });

    afterEach(() => wipeByEmailContains(CREATED_TAG));

    it('creates a household + lead for a board actor, normalizes the email, matches the unclaimed-households surface, and writes a CREATE audit row', async () => {
        asSession({ id: boardId, isBoardMember: true });
        const email = `Ada-${CREATED_TAG}@Example.com`;

        const res = await POST(nreq('http://localhost/api/membership-ops/contacts', 'POST', { name: 'Ada Lovelace', email }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);

        const created = await prisma.person.findUnique({ where: { id: data.participant.id } });
        expect(created?.email).toBe(email.toLowerCase());
        expect(created?.isHouseholdLead).toBe(true);
        expect(created?.dateOfBirth).toBeNull();
        expect(created?.googleId).toBeNull();

        const household = await prisma.household.findUnique({ where: { id: created!.householdId! } });
        expect(household?.name).toBe('Ada Lovelace');

        // Pin the route's serialized response shape, not just the DB rows above —
        // every assertion before this line still passes if the route's nested
        // `include: { household: { include: { householdMembers } } }` becomes
        // a bare `include: { household: true }`; the RTL mock is hand-maintained
        // and can't catch that either.
        expect(data.participant.household.householdMembers).toHaveLength(1);
        expect(data.participant.household.householdMembers[0]).toMatchObject({
            id: created!.id,
            name: 'Ada Lovelace',
            email: email.toLowerCase(),
        });

        // The board's unclaimed-households surface (and the nav todo-count badge)
        // share this predicate — a shell with an emailed, unclaimed lead must match
        // it with zero new wiring.
        const matches = await prisma.household.findFirst({
            where: { id: household!.id, ...UNCLAIMED_OR_BROKEN_HOUSEHOLD_WHERE },
        });
        expect(matches).not.toBeNull();

        const log = await expectAuditRow(prisma, {
            action: 'CREATE',
            tableName: 'Person',
            affectedEntityId: created!.id,
            secondaryAffectedEntity: created!.householdId!,
        });
        expect(log.actorId).toBe(boardId);
    });

    it('catches a case-variant duplicate with the owner-named 409 — the normalizeEmail regression', async () => {
        asSession({ id: boardId, isBoardMember: true });
        const variant = ownerEmail.toUpperCase();
        expect(variant).not.toBe(ownerEmail); // sanity: this really is a differently-cased address

        const res = await POST(nreq('http://localhost/api/membership-ops/contacts', 'POST', { name: 'Someone Else', email: variant }));
        // A dup check on the raw (un-normalized) key would miss here and 500 on the
        // Person.email @unique constraint instead. This must be 409, not 500.
        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.error).toBe('This email already belongs to Jane Doe');
        expect(data.fields).toEqual(['email']);
    });

    it('catches a whitespace-padded duplicate with the owner-named 409 — normalizeEmail trims, not just lowercases', async () => {
        asSession({ id: boardId, isBoardMember: true });
        const variant = `  ${ownerEmail.toUpperCase()}  `;

        const res = await POST(nreq('http://localhost/api/membership-ops/contacts', 'POST', { name: 'Someone Else', email: variant }));
        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.error).toBe('This email already belongs to Jane Doe');
        expect(data.fields).toEqual(['email']);
    });

    it('stores a whitespace-padded email trimmed', async () => {
        asSession({ id: boardId, isBoardMember: true });
        const padded = `  Whitespace-${CREATED_TAG}@Example.com  `;

        const res = await POST(nreq('http://localhost/api/membership-ops/contacts', 'POST', { name: 'Padded Email', email: padded }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.participant.email).toBe(padded.trim().toLowerCase());

        const created = await prisma.person.findUnique({ where: { id: data.participant.id } });
        expect(created?.email).toBe(padded.trim().toLowerCase());
    });

    it('400s a blank name', async () => {
        asSession({ id: boardId, isBoardMember: true });
        const res = await POST(nreq('http://localhost/api/membership-ops/contacts', 'POST', { name: '   ', email: `blank-name-${CREATED_TAG}@example.com` }));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Name is required');
    });

    it('400s a malformed email', async () => {
        asSession({ id: boardId, isBoardMember: true });
        const res = await POST(nreq('http://localhost/api/membership-ops/contacts', 'POST', { name: 'Bad Email', email: 'not-an-email' }));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('A valid email is required');
    });

    it('creates a household + lead for an operations-only actor (the RBAC rework follow-on)', async () => {
        asSession({ id: opsId, isOperations: true });
        const email = `Grace-${CREATED_TAG}@Example.com`;

        const res = await POST(nreq('http://localhost/api/membership-ops/contacts', 'POST', { name: 'Grace Hopper', email }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);

        const created = await prisma.person.findUnique({ where: { id: data.participant.id } });
        expect(created?.email).toBe(email.toLowerCase());

        const log = await expectAuditRow(prisma, {
            action: 'CREATE',
            tableName: 'Person',
            affectedEntityId: created!.id,
            secondaryAffectedEntity: created!.householdId!,
        });
        expect(log.actorId).toBe(opsId);
    });

    it('403s a sysadmin-only actor — intentional, sysadmin is excluded from board-create (Jeff / #1083-style board-only carve-out), not a bug', async () => {
        asSession({ id: sysadminId, isSysadmin: true });
        const res = await POST(nreq('http://localhost/api/membership-ops/contacts', 'POST', { name: 'Should Not Create', email: `blocked-${CREATED_TAG}@example.com` }));
        expect(res.status).toBe(403);
        expect(await prisma.person.findUnique({ where: { email: `blocked-${CREATED_TAG}@example.com` } })).toBeNull();
    });

    it('401s an anonymous caller', async () => {
        asSession(null);
        const res = await POST(nreq('http://localhost/api/membership-ops/contacts', 'POST', { name: 'X', email: `anon-${CREATED_TAG}@example.com` }));
        expect(res.status).toBe(401);
    });

    it('403s a plain authenticated user holding no role', async () => {
        asSession({ id: plainId, householdId: plainHh });
        const res = await POST(nreq('http://localhost/api/membership-ops/contacts', 'POST', { name: 'X', email: `plainx-${CREATED_TAG}@example.com` }));
        expect(res.status).toBe(403);
    });
});
