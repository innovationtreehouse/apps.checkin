/**
 * @jest-environment node
 */
/**
 * Unit test for startIntake's race guard (M3): the check+create now runs inside
 * a transaction holding a FOR UPDATE lock on the Membership row, so a second
 * in-flight INITIAL process is never created — the tx's own re-check (via `tx`,
 * not the caller's stale pre-tx read) finds the winner and returns it. Mirrors
 * renewal's createRenewalProcess / renewalConcurrency.integration.test.ts intent,
 * but as a mocked-prisma unit test since this worktree has no DB.
 */
import { getIntakeState, startIntake, saveIntake, submitIntake, IntakeError } from '@/lib/membership/intake';
import { Prisma } from '@/generated/prisma/client';

const txMembershipProcess = { findFirst: jest.fn(), create: jest.fn() };
const txAuditLog = { create: jest.fn() };
const txQueryRaw = jest.fn();
// saveIntake's two person.creates now run on a tx client (they pair the create
// with mintPersonId(tx) — #1693). Same delegate object as the root mock below,
// so the assertions in this file stay pointed at one place.
const mockPerson = { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() };
const tx = { $queryRaw: txQueryRaw, person: mockPerson, orgMembershipProcess: txMembershipProcess, auditLog: txAuditLog };
/** The id txQueryRaw hands back for mintPersonId. */
const MINTED_ID = 2503;

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        // A getter, not a direct reference: jest hoists this factory above the
        // `const mockPerson` above, so reading it eagerly is a TDZ error.
        get person() { return mockPerson; },
        household: { update: jest.fn() },
        orgMembership: { upsert: jest.fn() },
        orgMembershipProcess: { findFirst: jest.fn(), update: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        auditLog: { create: jest.fn() },
        volunteerDesignation: { findMany: jest.fn() },
        $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(tx)),
    },
}));

jest.mock('@/lib/membership/external', () => ({ getExternalStatus: jest.fn(), advanceExternalIfComplete: jest.fn() }));
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
}));
jest.mock('@/lib/membership/review', () => ({ applyVolunteerStatus: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const prisma = require('@/lib/prisma').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getExternalStatus } = require('@/lib/membership/external');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { upsertPrimaryContact, reconcileHouseholdConflicts } = require('@/lib/emergencyContacts/service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addHouseholdLead, HouseholdLeadLimitError, MAX_HOUSEHOLD_LEADS } = require('@/lib/household/leads');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { householdBgIsFresh } = require('@/lib/membership/renewal');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyVolunteerStatus } = require('@/lib/membership/review');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { advanceExternalIfComplete } = require('@/lib/membership/external');

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
    prisma.orgMembership.upsert.mockResolvedValue({ id: 42, householdId: 7, status: 'NONE' });
});

describe('startIntake race guard', () => {
    it('a second in-flight INITIAL start (existing found under the lock) returns the existing process, no duplicate create', async () => {
        const existingProcess = { id: 99, orgMembershipId: 42, kind: 'INITIAL', status: 'INTAKE' };
        txMembershipProcess.findFirst.mockResolvedValue(existingProcess);

        const result = await startIntake(1);

        expect(result).toBe(existingProcess);
        // Lock taken before the in-flight check, inside the same transaction.
        expect(txQueryRaw).toHaveBeenCalledTimes(1);
        // No duplicate process/audit row created for the loser of the race.
        expect(txMembershipProcess.create).not.toHaveBeenCalled();
        expect(txAuditLog.create).not.toHaveBeenCalled();
    });

    it('no in-flight process → creates one INTAKE process + audit row inside the same transaction', async () => {
        txMembershipProcess.findFirst.mockResolvedValue(null);
        const created = { id: 100, orgMembershipId: 42, kind: 'INITIAL', status: 'INTAKE' };
        txMembershipProcess.create.mockResolvedValue(created);

        const result = await startIntake(1);

        expect(result).toBe(created);
        expect(txMembershipProcess.create).toHaveBeenCalledWith({
            data: { orgMembershipId: 42, kind: 'INITIAL', status: 'INTAKE' },
        });
        expect(txAuditLog.create).toHaveBeenCalledTimes(1);
    });

    it('not_lead: caller is not a household lead and not a sysadmin', async () => {
        prisma.person.findUnique.mockResolvedValue({ ...user, isHouseholdLead: false });

        await expect(startIntake(1)).rejects.toMatchObject({ code: 'not_lead' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('already_member: household membership is already ACTIVE', async () => {
        prisma.person.findUnique.mockResolvedValue({
            ...user,
            household: { orgMembership: { status: 'ACTIVE' } },
        });

        await expect(startIntake(1)).rejects.toMatchObject({ code: 'already_member' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('P2002 race loser: the FOR UPDATE lock lost to a pre-fix instance, winner found on re-query', async () => {
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
        expect(upsertPrimaryContact).toHaveBeenCalledWith(prisma, 7, {
            name: 'Aunt May',
            phone: '555-555-2000',
            email: undefined,
        });
        expect(reconcileHouseholdConflicts).toHaveBeenCalledWith(prisma, 7);
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

    // #1432 site 9 / Decision 5: a submitted-but-blank name is rejected, not
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

    // Intake used to write DoB with a bare `new Date`, bypassing the #1165 guard
    // that every other interactive path funnels through: signup could persist an
    // exact DoB for a 26+ person, with only the nightly cron as the net.
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

    // F1: one calendar-date convention across every DoB writer. A DoB stored at
    // any other time of day fails SQL age filters cut at UTC midnight (#1447).
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
        expect(addHouseholdLead).toHaveBeenCalledWith(prisma, 7, 4);
    });

    it('secondary parent is new → create + addLeadOrRecord', async () => {
        prisma.person.create.mockResolvedValue({ id: 55 });

        await saveIntake(1, { secondaryParent: { name: 'New Parent', email: 'NEW@X.com' } });

        expect(prisma.person.create).toHaveBeenCalledWith({
            data: { id: MINTED_ID, householdId: 7, name: 'New Parent', email: 'new@x.com', dateOfBirth: null, isDeclaredAdult: false, allergies: null },
        });
        expect(addHouseholdLead).toHaveBeenCalledWith(prisma, 7, 55);
    });

    // #1432 follow-up: the plan's table wrongly marked this row closed by
    // #1688, which closed explicit `null` only — a blank/whitespace name still
    // wrote through. Same rejection as sites 9/10 (Decision 5): a submitted
    // name is required to be non-blank.
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
            data: { id: MINTED_ID, householdId: 7, name: 'New Kid', dateOfBirth: null, allergies: null },
        });
    });

    // #1432 site 10 / Decision 5: same rejection as the primary parent — an
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
            data: { id: MINTED_ID, householdId: 7, name: 'John', dateOfBirth: null, allergies: null },
        });
    });

    // #1432 site 4: "   " is truthy, so the old `else if (child.name)` gate
    // would have created a child with a whitespace-only stored name.
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

    beforeEach(() => {
        prisma.person.findUnique.mockResolvedValue(inFlightUser);
        prisma.boardSettings.findUnique.mockResolvedValue(null);
        prisma.orgMembershipProcess.update.mockResolvedValue({ id: 11, status: 'PENDING_EXTERNAL_ACTION' });
    });

    it('no_process when there is no INTAKE-status INITIAL process', async () => {
        prisma.person.findUnique.mockResolvedValue({
            ...inFlightUser,
            household: { ...inFlightUser.household, orgMembership: { processes: [] } },
        });

        await expect(submitIntake(1)).rejects.toMatchObject({ code: 'no_process' });
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

        expect(prisma.orgMembershipProcess.update).toHaveBeenCalledWith({
            where: { id: 11 },
            data: expect.not.objectContaining({ bgClearedAt: expect.anything() }),
        });
        expect(applyVolunteerStatus).not.toHaveBeenCalled();
    });

    it('complete + bgFresh=true → stamps bgClearedAt, advances, and matches the volunteer allowlist (#874)', async () => {
        householdBgIsFresh.mockResolvedValue(true);

        const result = await submitIntake(1);

        expect(prisma.orgMembershipProcess.update).toHaveBeenCalledWith({
            where: { id: 11 },
            data: expect.objectContaining({ status: 'PENDING_EXTERNAL_ACTION', bgClearedAt: expect.any(Date) }),
        });
        expect(prisma.auditLog.create).toHaveBeenCalled();
        // Fresh-check shortcut skips clearBackgroundCheck for the whole cycle, so
        // the designation allowlist must be matched here or never.
        expect(applyVolunteerStatus).toHaveBeenCalledWith(prisma, 42, 7, false);
        expect(result).toEqual({ id: 11, status: 'PENDING_EXTERNAL_ACTION' });
    });

    it('re-runs the external advance after landing at PENDING_EXTERNAL_ACTION and returns its result (#878)', async () => {
        householdBgIsFresh.mockResolvedValue(false);
        // Board pre-marked contract + BG consent on the INTAKE row, so the gate is
        // already met when we arrive — the advance carries the process to PENDING_PAYMENT.
        advanceExternalIfComplete.mockResolvedValue({ id: 11, status: 'PENDING_PAYMENT' });

        const result = await submitIntake(1);

        expect(advanceExternalIfComplete).toHaveBeenCalledWith(11);
        expect(result).toEqual({ id: 11, status: 'PENDING_PAYMENT' });
    });

    it('falls back to the update result when the external advance is a no-op (#878)', async () => {
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

        expect(prisma.orgMembershipProcess.update).toHaveBeenCalledWith({
            where: { id: 11 },
            data: expect.objectContaining({ bgClearedAt: expect.any(Date) }),
        });
    });
});
