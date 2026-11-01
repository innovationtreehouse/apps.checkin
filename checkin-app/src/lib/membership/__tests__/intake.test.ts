/**
 * @jest-environment node
 */
/**
 * Unit test for startIntake's race guard: the check+create runs inside
 * a transaction holding a FOR UPDATE lock on the Membership row, so a second
 * in-flight INITIAL process is never created — the tx's own re-check (via `tx`,
 * not the caller's stale pre-tx read) finds the winner and returns it. Mirrors
 * renewal's createRenewalProcess / renewalConcurrency.integration.test.ts intent,
 * as a mocked-prisma unit test.
 */
import { getIntakeState, startIntake, saveIntake, submitIntake, IntakeError } from '@/lib/membership/intake';
import { Prisma } from '@/generated/prisma/client';
import { findSelfGrantRefusal, recordSelfGrantRefusal } from '@/lib/membership/selfGrantGuard';
import { invalidateAttendanceCache } from '@/lib/getFullAttendance';
import { logger, logBackendError } from '@/lib/logger';

const txMembershipProcess = { findMany: jest.fn(), create: jest.fn() };
const txAuditLog = { create: jest.fn() };
const txQueryRaw = jest.fn();
// saveIntake's two person.creates run on a tx client (they pair the create
// with mintPersonId(tx)). Same delegate object as the root mock below,
// so the assertions in this file stay pointed at one place.
const mockPerson = { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() };
const mockHousehold = { update: jest.fn() };
const tx = { $queryRaw: txQueryRaw, person: mockPerson, household: mockHousehold, orgMembershipProcess: txMembershipProcess, auditLog: txAuditLog };
/** The id txQueryRaw hands back for mintPersonId. */
const MINTED_ID = 2503;

jest.mock('@/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, logBackendError: jest.fn() }));
jest.mock('@/lib/person/mailAliases', () => ({ removeAliasesForSignInEmail: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        // A getter, not a direct reference: jest hoists this factory above the
        // `const mockPerson` above, so reading it eagerly is a TDZ error.
        get person() { return mockPerson; },
        get household() { return mockHousehold; },
        orgMembershipProcess: { findFirst: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        auditLog: { create: jest.fn() },
        volunteerDesignation: { findMany: jest.fn() },
        $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(tx)),
    },
}));

jest.mock('@/lib/membership/external', () => ({ getExternalStatus: jest.fn(), advanceExternalIfComplete: jest.fn(), getOwnBackgroundCheck: jest.fn() }));
jest.mock('@/lib/emergencyContacts/service', () => ({
    upsertPrimaryContact: jest.fn(),
    reconcileHouseholdConflicts: jest.fn(),
}));
jest.mock('@/lib/household/leads', () => {
    const actual = jest.requireActual('@/lib/household/leads');
    return { ...actual, addHouseholdLead: jest.fn() };
});
jest.mock('@/lib/membership/renewal', () => ({
    householdBgIsFresh: jest.fn(),
    nextBoundary: jest.fn(),
    householdApplicationOpenOrBlockedWhere: { OR: [] },
}));
jest.mock('@/lib/membership/householdStatus', () => ({
    ensureHouseholdMembership: jest.fn(),
    lockAndFindDeniedHousehold: jest.fn(),
    raiseDeniedHouseholdActivity: jest.fn(),
}));
jest.mock('@/lib/getFullAttendance', () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock('@/lib/membership/review', () => ({ applyVolunteerFamilyStatus: jest.fn() }));
jest.mock('@/lib/membership/selfGrantGuard', () => ({ findSelfGrantRefusal: jest.fn(), recordSelfGrantRefusal: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const prisma = require('@/lib/prisma').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getExternalStatus } = require('@/lib/membership/external');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { upsertPrimaryContact, reconcileHouseholdConflicts } = require('@/lib/emergencyContacts/service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addHouseholdLead, HouseholdLeadLimitError, HouseholdLeadDeniedError, HouseholdLeadYouthError, MAX_HOUSEHOLD_LEADS } = require('@/lib/household/leads');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { householdBgIsFresh } = require('@/lib/membership/renewal');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyVolunteerFamilyStatus } = require('@/lib/membership/review');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { advanceExternalIfComplete, getOwnBackgroundCheck } = require('@/lib/membership/external');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensureHouseholdMembership, raiseDeniedHouseholdActivity } = require('@/lib/membership/householdStatus');

const user = {
    id: 1,
    householdId: 7,
    isSysadmin: false,
    isHouseholdLead: true,
    household: { orgMembership: null },
};

beforeEach(() => {
    jest.clearAllMocks();
    txQueryRaw.mockResolvedValue([{ value: MINTED_ID }]);
    prisma.person.findUnique.mockResolvedValue(user);
    ensureHouseholdMembership.mockResolvedValue({ id: 42, status: 'NONE' });
});

describe('startIntake race guard', () => {
    /** The status the FOR UPDATE read sees, then the household's open/blocked applications. */
    function underLock(status: string, open: unknown[]) {
        txQueryRaw.mockResolvedValueOnce([{ status }]);
        txMembershipProcess.findMany.mockResolvedValue(open);
    }

    it('a second in-flight INITIAL start (existing found under the lock) returns the existing process, no duplicate create', async () => {
        const existingProcess = { id: 99, orgMembershipId: 42, kind: 'INITIAL', status: 'INTAKE' };
        underLock('NONE', [existingProcess]);

        const result = await startIntake(1);

        expect(result).toBe(existingProcess);
        // Lock taken before the in-flight check, inside the same transaction.
        expect(txQueryRaw).toHaveBeenCalledTimes(1);
        // No duplicate process/audit row created for the loser of the race.
        expect(txMembershipProcess.create).not.toHaveBeenCalled();
        expect(txAuditLog.create).not.toHaveBeenCalled();
    });

    it('no in-flight process → creates one INTAKE process + audit row inside the same transaction', async () => {
        underLock('NONE', []);
        const created = { id: 100, orgMembershipId: 42, kind: 'INITIAL', status: 'INTAKE' };
        txMembershipProcess.create.mockResolvedValue(created);

        const result = await startIntake(1);

        expect(result).toBe(created);
        expect(ensureHouseholdMembership).toHaveBeenCalledWith(prisma, 7);
        expect(txMembershipProcess.create).toHaveBeenCalledWith({
            data: { orgMembershipId: 42, kind: 'INITIAL', status: 'INTAKE' },
        });
        expect(txAuditLog.create).toHaveBeenCalledTimes(1);
    });

    it('a REVOKED household with nothing open starts a joining application', async () => {
        underLock('REVOKED', []);
        txMembershipProcess.create.mockResolvedValue({ id: 102 });

        await expect(startIntake(1)).resolves.toEqual({ id: 102 });
    });

    it('not_lead: caller is not a household lead and not a sysadmin', async () => {
        prisma.person.findUnique.mockResolvedValue({ ...user, isHouseholdLead: false });

        await expect(startIntake(1)).rejects.toMatchObject({ code: 'not_lead' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('already_member: an ACTIVE household gets renewals only', async () => {
        underLock('ACTIVE', []);

        await expect(startIntake(1)).rejects.toMatchObject({ code: 'already_member' });
        expect(txMembershipProcess.create).not.toHaveBeenCalled();
    });

    it('denied: a DENIED household is refused and raised to the board', async () => {
        underLock('DENIED', []);

        await expect(startIntake(1)).rejects.toMatchObject({ code: 'denied' });
        expect(txMembershipProcess.create).not.toHaveBeenCalled();
        expect(raiseDeniedHouseholdActivity).toHaveBeenCalledWith(expect.objectContaining({ householdId: 7, personId: 1 }));
    });

    it('blocked: a household with a BLOCKED application cannot re-apply (F-30)', async () => {
        underLock('NONE', [{ id: 50, kind: 'INITIAL', status: 'BLOCKED' }]);

        await expect(startIntake(1)).rejects.toMatchObject({ code: 'blocked' });
        expect(txMembershipProcess.create).not.toHaveBeenCalled();
        expect(raiseDeniedHouseholdActivity).not.toHaveBeenCalled();
    });

    it('renewal_open: a REVOKED household with an open renewal continues it instead', async () => {
        underLock('REVOKED', [{ id: 60, kind: 'RENEWAL', status: 'PENDING_PAYMENT' }]);

        await expect(startIntake(1)).rejects.toMatchObject({ code: 'renewal_open' });
        expect(txMembershipProcess.create).not.toHaveBeenCalled();
    });

    it('P2002 race loser: a concurrent insert gets past the FOR UPDATE lock, winner found on re-query', async () => {
        const winner = { id: 101, orgMembershipId: 42, kind: 'INITIAL', status: 'INTAKE' };
        const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '7.8.0' });
        prisma.$transaction.mockRejectedValueOnce(p2002);
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(winner);

        const result = await startIntake(1);

        expect(result).toBe(winner);
    });

    it('P2002 race loser: no winner found on re-query rethrows the original error', async () => {
        const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '7.8.0' });
        prisma.$transaction.mockRejectedValueOnce(p2002);
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(null);

        await expect(startIntake(1)).rejects.toBe(p2002);
    });
});

describe('getIntakeState', () => {
    it('no_household: participant not found at all', async () => {
        prisma.person.findUnique.mockResolvedValue(null);
        await expect(getIntakeState(1)).rejects.toBeInstanceOf(IntakeError);
    });

    it('household missing (hasHousehold=false) → nothing prefilled, no external lookup', async () => {
        prisma.person.findUnique.mockResolvedValue({ id: 1, householdId: null, household: null });

        const state = await getIntakeState(1);

        expect(state.hasHousehold).toBe(false);
        expect(state.membershipStatus).toBeNull();
        expect(state.process).toBeNull();
        expect(state.external).toBeNull();
        expect(getExternalStatus).not.toHaveBeenCalled();
        expect(state.prefill.household).toBeNull();
        expect(state.prefill.primaryParent).toBeNull();
        expect(state.prefill.secondaryParent).toBeNull();
        expect(state.prefill.children).toEqual([]);
    });

    it("returns the caller's own background check as the external service reads it", async () => {
        const caller = { id: 1, householdId: null, household: null, isHouseholdLead: false, isSysadmin: false };
        prisma.person.findUnique.mockResolvedValue(caller);
        getOwnBackgroundCheck.mockResolvedValue({ consented: false, deepLinkUrl: 'https://averity.example/consent' });

        const state = await getIntakeState(1);

        expect(getOwnBackgroundCheck).toHaveBeenCalledWith(caller);
        expect(state.ownBackgroundCheck).toEqual({ consented: false, deepLinkUrl: 'https://averity.example/consent' });
    });

    it('loads every household member, by id', async () => {
        prisma.person.findUnique.mockResolvedValue({ id: 1, householdId: null, household: null });

        await getIntakeState(1);

        const include = prisma.person.findUnique.mock.calls[0][0].include;
        expect(include.household.include.householdMembers).toEqual({ orderBy: { id: "asc" } });
    });

    it('household with an in-flight process, primary/secondary parents and a child → full prefill + external lookup', async () => {
        const dob = new Date('2000-01-01T00:00:00Z');
        prisma.person.findUnique.mockResolvedValue({
            id: 1,
            householdId: 7,
            household: {
                name: 'Test Household',
                intakeNotes: 'volunteer only, no students',
                line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', postalCode: '78701',
                householdMembers: [
                    { id: 1, name: 'Primary', email: 'p@x.com', dateOfBirth: dob, allergies: null, isHouseholdLead: true },
                    { id: 2, name: 'Secondary', email: 's@x.com', dateOfBirth: null, allergies: 'peanuts', isHouseholdLead: true },
                    { id: 3, name: 'Kid', email: null, dateOfBirth: null, allergies: null, isHouseholdLead: false },
                ],
                orgMembership: {
                    status: 'NONE',
                    processes: [
                        { id: 10, kind: 'INITIAL', status: 'ACTIVE' },
                        { id: 11, kind: 'INITIAL', status: 'INTAKE' },
                    ],
                },
                emergencyContacts: [{ name: 'Aunt', phone: '555-555-2000', email: 'a@x.com' }],
            },
        });
        getExternalStatus.mockResolvedValue({ contractSigned: false, contractStarted: false, bgConsented: false, bgCleared: false, deepLinkUrl: null });

        const state = await getIntakeState(1);

        expect(state.hasHousehold).toBe(true);
        expect(state.membershipStatus).toBe('NONE');
        // Highest-id non-ACTIVE process wins over the ACTIVE one.
        expect(state.process).toEqual({ id: 11, kind: 'INITIAL', status: 'INTAKE' });
        expect(getExternalStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }));
        expect(state.prefill.primaryParent?.id).toBe(1);
        expect(state.prefill.primaryParent?.dob).toBe('2000-01-01');
        expect(state.prefill.secondaryParent?.id).toBe(2);
        expect(state.prefill.children).toHaveLength(1);
        expect(state.prefill.children[0].id).toBe(3);
        expect(state.prefill.household?.emergencyContactName).toBe('Aunt');
        expect(state.prefill.household?.notes).toBe('volunteer only, no students');
    });

    it('a non-lead household member (e.g. a youth) gets no intake note in the prefill', async () => {
        prisma.person.findUnique.mockResolvedValue({
            id: 3,
            householdId: 7,
            household: {
                name: 'Test Household',
                intakeNotes: 'we are volunteer only; dad lost his job',
                line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', postalCode: '78701',
                householdMembers: [
                    { id: 1, name: 'Primary', email: 'p@x.com', dateOfBirth: null, allergies: null, isHouseholdLead: true },
                    { id: 3, name: 'Kid', email: null, dateOfBirth: null, allergies: null, isHouseholdLead: false },
                ],
                orgMembership: { status: 'ACTIVE', processes: [] },
                emergencyContacts: [],
            },
        });

        const state = await getIntakeState(3);

        expect(state.isLead).toBe(false);
        expect(state.prefill.household?.notes).toBeNull();
        // The rest of the household prefill is family-authored shared data.
        expect(state.prefill.household?.name).toBe('Test Household');
    });

    it('a sysadmin who is not a lead gets no intake note in the prefill', async () => {
        prisma.person.findUnique.mockResolvedValue({
            id: 3,
            householdId: 7,
            isSysadmin: true,
            household: {
                name: 'Test Household',
                intakeNotes: 'we are volunteer only; dad lost his job',
                line1: null, line2: null, city: null, state: null, postalCode: null,
                householdMembers: [
                    { id: 1, name: 'Primary', email: null, dateOfBirth: null, allergies: null, isHouseholdLead: true },
                    { id: 3, name: 'Admin', email: null, dateOfBirth: null, allergies: null, isHouseholdLead: false },
                ],
                orgMembership: { status: 'ACTIVE', processes: [] },
                emergencyContacts: [],
            },
        });

        const state = await getIntakeState(3);

        expect(state.prefill.household?.notes).toBeNull();
    });

    it('every process ACTIVE → process is null, no external lookup', async () => {
        prisma.person.findUnique.mockResolvedValue({
            id: 1,
            householdId: 7,
            household: {
                name: 'H', line1: null, line2: null, city: null, state: null, postalCode: null,
                householdMembers: [{ id: 1, name: 'P', email: null, dateOfBirth: null, allergies: null, isHouseholdLead: true }],
                orgMembership: { status: 'ACTIVE', processes: [{ id: 5, kind: 'INITIAL', status: 'ACTIVE' }] },
                emergencyContacts: [],
            },
        });

        const state = await getIntakeState(1);

        expect(state.process).toBeNull();
        expect(getExternalStatus).not.toHaveBeenCalled();
    });
});

describe('saveIntake', () => {
    const baseUser = {
        id: 1,
        householdId: 7,
        isSysadmin: false,
        isHouseholdLead: true,
        household: {
            name: 'H',
            line1: null, line2: null, city: null, state: null, postalCode: null,
            householdMembers: [{ id: 1, isHouseholdLead: true }, { id: 4, isHouseholdLead: false }],
            orgMembership: null,
            emergencyContacts: [],
        },
    };

    beforeEach(() => {
        prisma.person.findUnique.mockResolvedValue(baseUser);
        getExternalStatus.mockResolvedValue(null);
        prisma.volunteerDesignation.findMany.mockResolvedValue([{ email: 'volunteer@gmail.com' }]);
    });

    describe('age fields', () => {
        const youthDob = new Date(new Date().getFullYear() - 14, 0, 1);
        const asYouth = { ...baseUser, dateOfBirth: youthDob };
        const declared = { dob: '', over25: true };

        beforeEach(() => mockPerson.update.mockClear());

        it.each([
            ['primary parent', { primaryParent: declared }],
            ['second parent', { secondaryParent: { id: 1, ...declared } }],
            ['child', { children: [{ id: 1, dob: '' }] }],
        ])('leaves a youth\'s own record unwritten when named as the %s, and says so', async (_section, input) => {
            prisma.person.findUnique.mockResolvedValue(asYouth);
            const { rejections } = await saveIntake(1, input);
            expect(mockPerson.update).not.toHaveBeenCalled();
            expect(rejections).toEqual([expect.objectContaining({ section: 'primaryParent', code: 'youth' })]);
        });

        it('still saves the rest of a youth\'s form', async () => {
            prisma.person.findUnique.mockResolvedValue(asYouth);
            await saveIntake(1, { primaryParent: declared, children: [{ id: 4, name: 'Kid' }] });
            expect(mockPerson.update).toHaveBeenCalledTimes(1);
            expect(mockPerson.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 4 } }));
        });

        it('stores no declaration beside the primary parent\'s date on file', async () => {
            prisma.person.findUnique.mockResolvedValue({ ...baseUser, dateOfBirth: new Date(new Date().getFullYear() - 22, 0, 1) });
            await saveIntake(1, { primaryParent: { over25: true } });
            expect(mockPerson.update.mock.calls[0][0].data).toEqual({ isDeclaredAdult: false });
        });

        it('stores no declaration beside the second parent\'s date on file', async () => {
            prisma.person.findUnique.mockResolvedValue({
                ...baseUser,
                household: { ...baseUser.household, householdMembers: [{ id: 1, isHouseholdLead: true }, { id: 4, isHouseholdLead: false, dateOfBirth: youthDob }] },
            });
            await saveIntake(1, { secondaryParent: { id: 4, over25: true } });
            expect(mockPerson.update.mock.calls[0][0].data).toEqual({ isDeclaredAdult: false });
        });

        it('reports nothing when a youth\'s form resends their record unchanged', async () => {
            prisma.person.findUnique.mockResolvedValue({ ...asYouth, name: 'Youth Lead', allergies: null });
            const { rejections } = await saveIntake(1, {
                primaryParent: { name: 'Youth Lead', dob: youthDob.toISOString().slice(0, 10), over25: false, allergies: null },
            });
            expect(mockPerson.update).not.toHaveBeenCalled();
            expect(rejections).toEqual([]);
        });

        it.each([
            ['name', { name: 'New Name' }],
            ['date', { dob: '2000-01-01' }],
            ['allergies', { allergies: 'peanuts' }],
        ])('reports a youth changing their own %s', async (_field, change) => {
            prisma.person.findUnique.mockResolvedValue({ ...asYouth, name: 'Youth Lead', allergies: null });
            const { rejections } = await saveIntake(1, { primaryParent: change });
            expect(mockPerson.update).not.toHaveBeenCalled();
            expect(rejections).toEqual([expect.objectContaining({ code: 'youth' })]);
        });

        it('reports a youth once when the form names them in two sections', async () => {
            prisma.person.findUnique.mockResolvedValue(asYouth);
            const { rejections } = await saveIntake(1, { primaryParent: declared, secondaryParent: { id: 1, ...declared } });
            expect(rejections).toHaveLength(1);
        });

        it('still saves a youth\'s household address', async () => {
            prisma.person.findUnique.mockResolvedValue(asYouth);
            mockHousehold.update.mockClear();
            await saveIntake(1, { household: { line1: '1 Main St' }, primaryParent: declared });
            expect(mockHousehold.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { line1: '1 Main St' } });
        });

        describe('second parent with a date on file', () => {
            const withSecond = (dateOfBirth: Date | null) => ({
                ...baseUser,
                household: { ...baseUser.household, householdMembers: [{ id: 1, isHouseholdLead: true }, { id: 4, isHouseholdLead: true, dateOfBirth }] },
            });

            it.each([[null], ['']])('refuses replacing an under-18 date with a declaration (dob %j), saving nothing', async (dob) => {
                prisma.person.findUnique.mockResolvedValue(withSecond(youthDob));
                await expect(saveIntake(1, { secondaryParent: { id: 4, dob, over25: true } })).rejects.toMatchObject({
                    code: 'under_18_declared',
                    fields: ['secondaryParent'],
                });
                expect(mockPerson.update).not.toHaveBeenCalled();
            });

            it('accepts a declaration in a later save once the date is cleared', async () => {
                prisma.person.findUnique.mockResolvedValue(withSecond(youthDob));
                await saveIntake(1, { secondaryParent: { id: 4, dob: null, over25: false } });
                expect(mockPerson.update.mock.calls[0][0].data).toEqual({ dateOfBirth: null, isDeclaredAdult: false });

                prisma.person.findUnique.mockResolvedValue(withSecond(null));
                await saveIntake(1, { secondaryParent: { id: 4, dob: null, over25: true } });
                expect(mockPerson.update.mock.calls[1][0].data).toEqual({ dateOfBirth: null, isDeclaredAdult: true });
            });

            it('accepts a declaration replacing a date of 18 or over', async () => {
                prisma.person.findUnique.mockResolvedValue(withSecond(new Date(new Date().getFullYear() - 22, 0, 1)));
                await saveIntake(1, { secondaryParent: { id: 4, dob: null, over25: true } });
                expect(mockPerson.update.mock.calls[0][0].data).toEqual({ dateOfBirth: null, isDeclaredAdult: true });
            });
        });
    });

    // Designated addresses are set on a person only by the board.
    it('refuses a new second parent with a designated address, saving nothing', async () => {
        await expect(saveIntake(1, {
            household: { notes: 'n' },
            secondaryParent: { name: 'New Parent', email: 'Volun.teer+x@gmail.com' },
        })).rejects.toMatchObject({
            code: 'email_designated',
            fields: ['secondaryParent'],
            message: "That email address can't be added here. To use it, contact the board.",
        });
        expect(prisma.household.update).not.toHaveBeenCalled();
        expect(prisma.person.create).not.toHaveBeenCalled();
    });

    it('refuses a new child with a designated address, saving nothing', async () => {
        await expect(saveIntake(1, {
            children: [{ name: 'Kid', email: 'VOLUNTEER@googlemail.com' }],
        })).rejects.toMatchObject({ code: 'email_designated', fields: ['children'] });
        expect(prisma.person.create).not.toHaveBeenCalled();
    });

    it('refuses a taken email for new people without confirming anyone holds it; other unique violations stay unexpected', async () => {
        const violation = (target: string[]) => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '7.8.0', meta: { target } });
        const input = {
            secondaryParent: { name: 'New Parent', email: 'parent@example.com' },
            children: [{ name: 'Kid', email: 'kid@example.com' }, { name: 'Kid Two', email: 'two@example.com' }, { name: 'No Email' }],
        };

        prisma.person.create.mockRejectedValueOnce(violation(['email']));
        await expect(saveIntake(1, input)).rejects.toMatchObject({
            code: 'email_in_use',
            fields: ['secondaryParent', 'children'],
            message: expect.stringContaining('If they already have an account'),
        });

        const other = violation(['id']);
        prisma.person.create.mockRejectedValueOnce(other);
        await expect(saveIntake(1, input)).rejects.toBe(other);
    });

    it('no_household when the caller has no participant row', async () => {
        prisma.person.findUnique.mockResolvedValue(null);
        await expect(saveIntake(1, {})).rejects.toBeInstanceOf(IntakeError);
    });

    it('not_lead when the caller is not a household lead', async () => {
        prisma.person.findUnique.mockResolvedValue({ ...baseUser, isHouseholdLead: false });
        await expect(saveIntake(1, {})).rejects.toMatchObject({ code: 'not_lead' });
    });

    it('normalized address data updates the household; emergency-contact fields upsert the primary contact', async () => {
        await saveIntake(1, {
            household: { line1: ' 1 Main St ', emergencyContactName: 'Aunt May', emergencyContactPhone: '555-555-2000' },
        });

        expect(prisma.household.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { line1: '1 Main St' } });
        expect(upsertPrimaryContact).toHaveBeenCalledWith(tx, 7, {
            name: 'Aunt May',
            phone: '555-555-2000',
            email: undefined,
        });
        expect(reconcileHouseholdConflicts).toHaveBeenCalledWith(tx, 7);
    });

    it('household notes persist as intakeNotes (trimmed; empty → null)', async () => {
        await saveIntake(1, { household: { notes: '  we volunteer only, no students  ' } });
        expect(prisma.household.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { intakeNotes: 'we volunteer only, no students' } });

        prisma.household.update.mockClear();
        await saveIntake(1, { household: { notes: '' } });
        expect(prisma.household.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { intakeNotes: null } });
    });

    it('no address keys and no emergency-contact keys → neither household.update nor upsertPrimaryContact is called', async () => {
        await saveIntake(1, { household: {} });

        expect(prisma.household.update).not.toHaveBeenCalled();
        expect(upsertPrimaryContact).not.toHaveBeenCalled();
    });

    it('updates the primary parent (the caller)', async () => {
        await saveIntake(1, { primaryParent: { name: 'New Name' } });

        expect(prisma.person.update).toHaveBeenCalledWith({
            where: { id: 1 },
            data: { name: 'New Name' },
        });
    });

    // A submitted-but-blank name is rejected, not
    // silently dropped — this is the caller's own name, always required.
    it('rejects blanking the primary parent (caller) name', async () => {
        await expect(saveIntake(1, { primaryParent: { name: '   ' } })).rejects.toMatchObject({ code: 'name_required' });
        expect(prisma.person.update).not.toHaveBeenCalled();
    });

    it('trims the primary parent name on write', async () => {
        await saveIntake(1, { primaryParent: { name: '  Trimmed  ' } });
        expect(prisma.person.update).toHaveBeenCalledWith({
            where: { id: 1 },
            data: { name: 'Trimmed' },
        });
    });

    // Intake funnels DoB through the same guard as every other interactive path, so
    // signup cannot persist an exact DoB for a 26+ person and rely on the nightly cron.
    it('strips a 26+ DoB at signup and declares the person an adult', async () => {
        prisma.person.create.mockResolvedValue({ id: 55 });

        await saveIntake(1, {
            primaryParent: { dob: '1985-04-01' },
            secondaryParent: { name: 'New Parent', dob: '1980-02-02' },
        });

        expect(prisma.person.update).toHaveBeenCalledWith({
            where: { id: 1 },
            data: { dateOfBirth: null, isDeclaredAdult: true },
        });
        expect(prisma.person.create).toHaveBeenCalledWith({
            data: { id: MINTED_ID, householdId: 7, name: 'New Parent', dateOfBirth: null, isDeclaredAdult: true, allergies: null },
        });
    });

    // One calendar-date convention across every DoB writer. A DoB stored at
    // any other time of day fails SQL age filters cut at UTC midnight.
    it('stores a kept DoB at UTC midnight', async () => {
        const childBirthYear = new Date().getUTCFullYear() - 12;

        await saveIntake(1, { children: [{ id: 4, dob: `${childBirthYear}-05-04` }] });

        expect(prisma.person.update).toHaveBeenCalledWith({
            where: { id: 4 },
            data: { dateOfBirth: new Date(`${childBirthYear}-05-04T00:00:00.000Z`), isDeclaredAdult: false },
        });
    });

    it('secondary parent already a household member → update + addLeadOrRecord', async () => {
        await saveIntake(1, { secondaryParent: { id: 4, name: 'Existing Parent' } });

        expect(prisma.person.update).toHaveBeenCalledWith({
            where: { id: 4 },
            data: { name: 'Existing Parent' },
        });
        expect(addHouseholdLead).toHaveBeenCalledWith(tx, 7, 4);
    });

    it('secondary parent is new → create + addLeadOrRecord', async () => {
        prisma.person.create.mockResolvedValue({ id: 55 });

        await saveIntake(1, { secondaryParent: { name: 'New Parent', email: 'NEW@X.com' } });

        expect(prisma.person.create).toHaveBeenCalledWith({
            data: { id: MINTED_ID, householdId: 7, name: 'New Parent', email: 'new@x.com', allergies: null },
        });
        expect(addHouseholdLead).toHaveBeenCalledWith(tx, 7, 55);
    });

    it('rejects blanking an existing secondary parent name on update', async () => {
        await expect(saveIntake(1, { secondaryParent: { id: 4, name: '   ' } })).rejects.toMatchObject({ code: 'name_required' });
        expect(prisma.person.update).not.toHaveBeenCalled();
    });

    // The create-path sibling: a whitespace-only name must be treated like no
    // name at all — falling through to the existing name-required rejection
    // (soft, not thrown) rather than creating a blank-named person.
    it('a whitespace-only new secondary parent name falls through to the name-required rejection', async () => {
        const result = await saveIntake(1, { secondaryParent: { name: '   ', email: 'new@x.com' } });

        expect(prisma.person.create).not.toHaveBeenCalled();
        expect(result.rejections).toEqual([
            {
                section: 'secondaryParent',
                code: 'name_required',
                message: expect.stringContaining('name is required'),
            },
        ]);
    });

    it('addHouseholdLead hitting the per-household cap is recorded as a rejection, not thrown', async () => {
        addHouseholdLead.mockRejectedValue(new HouseholdLeadLimitError(7));

        const result = await saveIntake(1, { secondaryParent: { id: 4, name: 'Existing Parent' } });

        expect(result.rejections).toEqual([
            {
                section: 'secondaryParent',
                code: 'lead_limit',
                message: expect.stringContaining(String(MAX_HOUSEHOLD_LEADS)),
            },
        ]);
    });

    it('a sysadmin who does not lead the household cannot promote a guardian through intake', async () => {
        const refusal = { actorId: 1, affectedEntityId: 4, newData: {} };
        jest.mocked(findSelfGrantRefusal).mockResolvedValueOnce(refusal);
        prisma.person.findUnique.mockResolvedValueOnce({ ...baseUser, isHouseholdLead: false, isSysadmin: true });

        const result = await saveIntake(1, { secondaryParent: { id: 4, name: 'Existing Parent' } });

        expect(findSelfGrantRefusal).toHaveBeenCalledWith(tx, 1, { personId: 4, householdId: 7 }, { table: 'Person', attempted: { isHouseholdLead: true } });
        expect(recordSelfGrantRefusal).toHaveBeenCalledWith(prisma, refusal);
        expect(addHouseholdLead).not.toHaveBeenCalled();
        expect(result.rejections).toEqual([{ section: 'secondaryParent', code: 'not_lead', message: expect.stringContaining('only a lead') }]);
    });

    it('a lead promotion in a DENIED household is a rejection raised to the board', async () => {
        addHouseholdLead.mockRejectedValue(new HouseholdLeadDeniedError(7, 4));

        const result = await saveIntake(1, { secondaryParent: { id: 4, name: 'Existing Parent' } });

        expect(result.rejections).toEqual([
            { section: 'secondaryParent', code: 'household_denied', message: expect.stringContaining('denied membership') },
        ]);
        expect(raiseDeniedHouseholdActivity).toHaveBeenCalledWith(expect.objectContaining({ householdId: 7, personId: 4 }));
    });

    it('a refused new second parent is recorded against the household, not the minted id', async () => {
        jest.mocked(findSelfGrantRefusal).mockResolvedValueOnce({ actorId: 1, affectedEntityId: 7, newData: {} });
        prisma.person.create.mockResolvedValue({ id: 55 });
        prisma.person.findUnique.mockResolvedValueOnce({ ...baseUser, isHouseholdLead: false, isSysadmin: true });

        await saveIntake(1, { secondaryParent: { name: 'New Parent' } });

        expect(findSelfGrantRefusal).toHaveBeenCalledWith(tx, 1, { householdId: 7 }, { table: 'Person', attempted: { isHouseholdLead: true } });
        expect(addHouseholdLead).not.toHaveBeenCalled();
    });

    it('a youth second parent is a rejection, kept as a household member', async () => {
        prisma.person.create.mockResolvedValue({ id: 55 });
        addHouseholdLead.mockRejectedValue(new HouseholdLeadYouthError(7, 55));

        const result = await saveIntake(1, { secondaryParent: { name: 'Young Person', dob: '2015-01-01' } });

        expect(prisma.person.create).toHaveBeenCalled();
        expect(result.rejections).toEqual([{ section: 'secondaryParent', code: 'youth', message: expect.stringContaining('under 18') }]);
    });

    it('raises a denied promotion only after the transaction commits', async () => {
        addHouseholdLead.mockRejectedValue(new HouseholdLeadDeniedError(7, 4));
        const committed = jest.fn();
        prisma.$transaction.mockImplementationOnce(async (cb: (t: unknown) => unknown) => {
            const out = await cb(tx);
            expect(raiseDeniedHouseholdActivity).not.toHaveBeenCalled();
            committed();
            return out;
        });

        await saveIntake(1, { secondaryParent: { id: 4, name: 'Existing Parent' } });

        expect(committed).toHaveBeenCalled();
        expect(raiseDeniedHouseholdActivity).toHaveBeenCalledTimes(1);
    });

    it('a rollback drops the denied raise', async () => {
        addHouseholdLead.mockRejectedValue(new HouseholdLeadDeniedError(7, 4));
        prisma.person.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('write failed'));

        await expect(saveIntake(1, { secondaryParent: { id: 4, name: 'Parent' }, children: [{ id: 4, name: 'Child' }] })).rejects.toThrow('write failed');

        expect(raiseDeniedHouseholdActivity).not.toHaveBeenCalled();
    });

    it('a rollback still records a self-grant refusal', async () => {
        const refusal = { actorId: 1, affectedEntityId: 4, newData: {} };
        jest.mocked(findSelfGrantRefusal).mockResolvedValueOnce(refusal);
        prisma.person.findUnique.mockResolvedValueOnce({ ...baseUser, isHouseholdLead: false, isSysadmin: true });
        prisma.person.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('write failed'));

        await expect(saveIntake(1, { secondaryParent: { id: 4, name: 'Parent' }, children: [{ id: 4, name: 'Child' }] })).rejects.toThrow('write failed');

        expect(recordSelfGrantRefusal).toHaveBeenCalledWith(prisma, refusal);
    });

    describe('a failure after the outcome is settled', () => {
        const dbDown = new Error('database unavailable');
        const refusal = { actorId: 1, affectedEntityId: 4, newData: {} };
        const refusedSysadmin = () => {
            jest.mocked(findSelfGrantRefusal).mockResolvedValueOnce(refusal);
            prisma.person.findUnique.mockResolvedValueOnce({ ...baseUser, isHouseholdLead: false, isSysadmin: true });
            jest.mocked(recordSelfGrantRefusal).mockRejectedValueOnce(dbDown);
        };

        it('a failed denied raise still reports the committed save and refreshes the cache', async () => {
            addHouseholdLead.mockRejectedValue(new HouseholdLeadDeniedError(7, 4));
            raiseDeniedHouseholdActivity.mockRejectedValueOnce(dbDown);

            const result = await saveIntake(1, { secondaryParent: { id: 4, name: 'Parent' } });

            expect(result.rejections).toEqual([expect.objectContaining({ code: 'household_denied' })]);
            expect(invalidateAttendanceCache).toHaveBeenCalled();
            const ref = expect.objectContaining({ householdId: 7, personId: 4 });
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('denied household raise'), ref, dbDown);
            expect(logBackendError).toHaveBeenCalledWith(dbDown, 'saveIntake denied household raise', ref);
        });

        it('a failed refusal write still reports the committed save', async () => {
            refusedSysadmin();

            const result = await saveIntake(1, { secondaryParent: { id: 4, name: 'Parent' } });

            expect(result.rejections).toEqual([expect.objectContaining({ code: 'not_lead' })]);
            expect(invalidateAttendanceCache).toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('self-grant refusal'), refusal, dbDown);
            expect(logBackendError).toHaveBeenCalledWith(dbDown, 'saveIntake self-grant refusal', refusal);
        });

        it('a failed refusal write leaves the rollback reporting its own error', async () => {
            refusedSysadmin();
            prisma.person.create.mockRejectedValueOnce(
                new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '7.8.0', meta: { target: ['email'] } }),
            );

            await expect(saveIntake(1, { secondaryParent: { id: 4, name: 'Parent' }, children: [{ name: 'Kid', email: 'kid@example.com' }] }))
                .rejects.toMatchObject({ code: 'email_in_use' });

            expect(logBackendError).toHaveBeenCalledWith(dbDown, 'saveIntake self-grant refusal', refusal);
        });

        it('a failed state read returns a null state, not an error', async () => {
            prisma.person.findUnique.mockResolvedValueOnce(baseUser).mockRejectedValueOnce(dbDown);

            const result = await saveIntake(1, { primaryParent: { name: 'Pat' } });

            expect(result).toEqual({ state: null, rejections: [] });
            expect(prisma.person.update).toHaveBeenCalled();
            expect(logBackendError).toHaveBeenCalledWith(dbDown, 'saveIntake state read', { userId: 1 });
        });
    });

    it('child already a household member → update; a new named child → create', async () => {
        prisma.person.create.mockResolvedValue({ id: 56 });

        await saveIntake(1, {
            children: [
                { id: 4, name: 'Existing Kid' },
                { name: 'New Kid' },
            ],
        });

        expect(prisma.person.update).toHaveBeenCalledWith({
            where: { id: 4 },
            data: { name: 'Existing Kid' },
        });
        expect(prisma.person.create).toHaveBeenCalledWith({
            data: { id: MINTED_ID, householdId: 7, name: 'New Kid', allergies: null },
        });
    });

    // Same rejection as the primary parent — an
    // existing child's name can't be blanked through an update.
    it('rejects blanking an existing child name on update', async () => {
        await expect(saveIntake(1, { children: [{ id: 4, name: '   ' }] })).rejects.toMatchObject({ code: 'name_required' });
        expect(prisma.person.update).not.toHaveBeenCalled();
    });

    // A padded name passes the trimmed gate but must store trimmed — the
    // create write goes through nameWrite like every other write path.
    it('stores a padded new-child name trimmed', async () => {
        prisma.person.create.mockResolvedValue({ id: 56 });
        await saveIntake(1, { children: [{ name: '  John  ' }] });
        expect(prisma.person.create).toHaveBeenCalledWith({
            data: { id: MINTED_ID, householdId: 7, name: 'John', allergies: null },
        });
    });

    // "   " is truthy, so a bare `else if (child.name)` gate
    // would create a child with a whitespace-only stored name.
    it('does not create a child from a whitespace-only name', async () => {
        const result = await saveIntake(1, { children: [{ name: '   ' }] });
        expect(prisma.person.create).not.toHaveBeenCalled();
        expect(result.rejections).toEqual([]);
    });
});

describe('submitIntake', () => {
    const inFlightUser = {
        id: 1,
        householdId: 7,
        isSysadmin: false,
        isHouseholdLead: true,
        household: {
            id: 7,
            line1: '1 Main St',
            city: 'Austin',
            state: 'TX',
            postalCode: '78701',
            emergencyContacts: [{ conflictParticipantId: null, name: 'Aunt May', phone: '555-555-2000' }],
            householdMembers: [{ id: 1, name: 'Primary' }],
            orgMembership: { processes: [{ id: 11, orgMembershipId: 42, kind: 'INITIAL', status: 'INTAKE' }] },
        },
    };

    // The status write, its audit row and the allowlist share one transaction; run it on the root mock.
    beforeEach(() => {
        prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
        prisma.person.findUnique.mockResolvedValue(inFlightUser);
        prisma.boardSettings.findUnique.mockResolvedValue(null);
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
        prisma.orgMembershipProcess.findUniqueOrThrow.mockResolvedValue({ id: 11, status: 'PENDING_EXTERNAL_ACTION' });
    });

    afterAll(() => {
        prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(tx));
    });

    it('writes the status and its audit row in one transaction', async () => {
        householdBgIsFresh.mockResolvedValue(false);
        prisma.auditLog.create.mockRejectedValueOnce(new Error('audit write failed'));

        await expect(submitIntake(1)).rejects.toThrow('audit write failed');
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(advanceExternalIfComplete).not.toHaveBeenCalled();
    });

    it('no_process when there is no INTAKE-status INITIAL process', async () => {
        prisma.person.findUnique.mockResolvedValue({
            ...inFlightUser,
            household: { ...inFlightUser.household, orgMembership: { processes: [] } },
        });

        await expect(submitIntake(1)).rejects.toMatchObject({ code: 'no_process' });
    });

    it('CAS from INTAKE: a concurrent archive or double submit (count 0) → no_process, no audit, no advance (F-11)', async () => {
        householdBgIsFresh.mockResolvedValue(false);
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 0 });

        await expect(submitIntake(1)).rejects.toMatchObject({ code: 'no_process' });
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
        expect(advanceExternalIfComplete).not.toHaveBeenCalled();
    });

    it('incomplete: missing address and missing valid emergency contact are both reported', async () => {
        prisma.person.findUnique.mockResolvedValue({
            ...inFlightUser,
            household: { ...inFlightUser.household, line1: null, emergencyContacts: [] },
        });

        await expect(submitIntake(1)).rejects.toMatchObject({
            code: 'incomplete',
            fields: expect.arrayContaining(['address', 'emergencyContact']),
        });
    });

    it('complete + bgFresh=false → no bgClearedAt stamp, allowlist deferred to the external advance', async () => {
        householdBgIsFresh.mockResolvedValue(false);

        await submitIntake(1);

        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith({
            where: { id: 11, status: 'INTAKE' },
            data: expect.not.objectContaining({ bgClearedAt: expect.anything() }),
        });
        expect(applyVolunteerFamilyStatus).not.toHaveBeenCalled();
    });

    it('complete + bgFresh=true → stamps bgClearedAt, advances, and matches the volunteer allowlist', async () => {
        householdBgIsFresh.mockResolvedValue(true);

        const result = await submitIntake(1);

        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith({
            where: { id: 11, status: 'INTAKE' },
            data: expect.objectContaining({ status: 'PENDING_EXTERNAL_ACTION', bgClearedAt: expect.any(Date) }),
        });
        expect(prisma.auditLog.create).toHaveBeenCalled();
        // Fresh-check shortcut skips clearBackgroundCheck for the whole cycle, so
        // the designation allowlist must be matched here or never.
        expect(applyVolunteerFamilyStatus).toHaveBeenCalledWith(prisma, 42, 7, false);
        expect(result).toEqual({ id: 11, status: 'PENDING_EXTERNAL_ACTION' });
    });

    it('re-runs the external advance after landing at PENDING_EXTERNAL_ACTION and returns its result', async () => {
        householdBgIsFresh.mockResolvedValue(false);
        // Board pre-marked contract + BG consent on the INTAKE row, so the gate is
        // already met when we arrive — the advance carries the process to PENDING_PAYMENT.
        advanceExternalIfComplete.mockResolvedValue({ id: 11, status: 'PENDING_PAYMENT' });

        const result = await submitIntake(1);

        expect(advanceExternalIfComplete).toHaveBeenCalledWith(11);
        expect(result).toEqual({ id: 11, status: 'PENDING_PAYMENT' });
    });

    it('falls back to the re-read process when the external advance is a no-op', async () => {
        householdBgIsFresh.mockResolvedValue(false);
        // Nothing pre-marked ⇒ advanceExternalIfComplete finds the gate unmet and
        // returns the still-PENDING_EXTERNAL_ACTION process (here left undefined to
        // exercise the fallback); submitIntake reports the phase it advanced to.
        advanceExternalIfComplete.mockResolvedValue(undefined);

        const result = await submitIntake(1);

        expect(advanceExternalIfComplete).toHaveBeenCalledWith(11);
        expect(result).toEqual({ id: 11, status: 'PENDING_EXTERNAL_ACTION' });
    });

    it('complete + fresh check + intake note → the note does not disqualify the shortcut', async () => {
        prisma.person.findUnique.mockResolvedValue({
            ...inFlightUser,
            household: { ...inFlightUser.household, intakeNotes: 'please treat us as a volunteer household' },
        });
        householdBgIsFresh.mockResolvedValue(true);

        await submitIntake(1);

        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith({
            where: { id: 11, status: 'INTAKE' },
            data: expect.objectContaining({ bgClearedAt: expect.any(Date) }),
        });
    });
});
