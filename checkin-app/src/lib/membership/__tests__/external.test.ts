/**
 * @jest-environment node
 */
/**
 * Unit tests for external.ts (prisma + config + zoho provider mocked, no DB):
 *   - setZohoEnvelope: refuses a closed application; findProcessByEnvelope: a passthrough.
 *   - getOrCreateContractSigningUrl: the guard chain (not_configured/not_found/
 *     no_household/not_lead/wrong_phase), the mock-mode PDF short-circuit, and
 *     the already-claimed-ids short-circuit.
 *   - advanceExternalIfComplete: the volunteer-designation allowlist is matched
 *     at the PENDING_PAYMENT transition — and only by the race winner.
 */
import { backgroundCheckProvider } from '@/lib/membership/background-check/manual-adapter';
import { setZohoEnvelope, markBgConsent, findProcessByEnvelope, getOrCreateContractSigningUrl, selfRecordBgConsent, getOwnBackgroundCheck, advanceExternalIfComplete, markContractSigned, resetSigning, ExternalError } from '@/lib/membership/external';

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn() },
        orgMembership: { findUnique: jest.fn() },
        orgMembershipProcess: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
        auditLog: { create: jest.fn() },
        // signingMockActive reads the dev signing-target radio; null = default ('zoho').
        boardSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(),
    },
}));

jest.mock('@/lib/membership/review', () => ({
    notifyReviewers: jest.fn().mockResolvedValue(undefined),
    applyVolunteerFamilyStatus: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/config', () => {
    const actual = jest.requireActual('@/lib/config');
    return {
        ...actual,
        config: {
            ...actual.config,
            zohoAvailable: jest.fn(),
            zohoMockActive: jest.fn(),
            isProd: jest.fn(),
            baseUrl: jest.fn(() => 'https://checkin.example.org'),
        },
    };
});

jest.mock('@/lib/membership/contract/zohoProvider', () => ({
    zohoSign: {
        getAccessToken: jest.fn(),
        createRequest: jest.fn(),
        submitRequest: jest.fn(),
        getEmbeddedSignUrl: jest.fn(),
        getRequestStatus: jest.fn(),
        recallRequest: jest.fn(),
    },
}));

jest.mock('@/lib/membership/contract/agreementDocument', () => {
    const actual = jest.requireActual('@/lib/membership/contract/agreementDocument');
    return { ...actual, loadAgreementPdf: jest.fn(), stampWatermark: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const prisma = require('@/lib/prisma').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { config } = require('@/lib/config');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { zohoSign } = require('@/lib/membership/contract/zohoProvider');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadAgreementPdf, stampWatermark, AgreementUnavailableError } = require('@/lib/membership/contract/agreementDocument');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { notifyReviewers, applyVolunteerFamilyStatus } = require('@/lib/membership/review');

// resetAllMocks, NOT clearAllMocks: clear wipes recorded calls but KEEPS
// implementations, so a `mockResolvedValue` set in one test silently answers every
// later test in the file. Harmless only for as long as no later test exercises a
// path that reaches the same prisma method. Reset drops implementations too, so
// each test states the prisma responses it depends on and nothing else.
//
// The three factory-level defaults below are re-established here, since reset
// clears those as well.
beforeEach(() => {
    jest.resetAllMocks();
    prisma.boardSettings.findUnique.mockResolvedValue(null); // signingMockActive: no dev override
    notifyReviewers.mockResolvedValue(undefined);
    applyVolunteerFamilyStatus.mockResolvedValue(undefined);
    config.zohoAvailable.mockReturnValue(true);
    config.zohoMockActive.mockReturnValue(true);
    config.isProd.mockReturnValue(false);
    config.baseUrl.mockReturnValue('https://checkin.example.org');
});

describe('setZohoEnvelope', () => {
    it('not_found when the process does not exist', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(null);
        await expect(setZohoEnvelope(1, 'req-1', 5)).rejects.toBeInstanceOf(ExternalError);
    });

    it('updates the envelope id, clears any stale action id, and writes an audit row', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: 1 });
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
        prisma.orgMembershipProcess.findUniqueOrThrow.mockResolvedValue({ id: 1, zohoEnvelopeId: 'req-1', zohoActionId: null });

        const result = await setZohoEnvelope(1, 'req-1', 5);

        // zohoActionId is nulled so re-pointing the envelope can't leave the old
        // action paired with the new request — restores the claimable state.
        const call = prisma.orgMembershipProcess.updateMany.mock.calls[0][0];
        expect(call.data).toEqual({ zohoEnvelopeId: 'req-1', zohoActionId: null, zohoSignerPersonId: null });
        expect(call.where.id).toBe(1);
        expect(call.where.contractSignedAt).toBeNull();
        expect(call.where.status.in).not.toContain('ACTIVE');
        expect(call.where.status.in).not.toContain('ARCHIVED');
        expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ id: 1, zohoEnvelopeId: 'req-1', zohoActionId: null });
    });

    it('refuses a closed application and writes no audit row', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: 1, status: 'ACTIVE' });
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 0 });

        await expect(setZohoEnvelope(1, 'req-1', 5)).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
});

describe('markBgConsent', () => {
    beforeEach(() => {
        prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
    });

    it.each([
        ['a PERSON_BG', { kind: 'PERSON_BG', status: 'PENDING_BG_REVIEW' }],
        ['a PERSON_AGREEMENT', { kind: 'PERSON_AGREEMENT', status: 'PENDING_EXTERNAL_ACTION' }],
        ['an archived application', { kind: 'INITIAL', status: 'ARCHIVED' }],
        ['an active application', { kind: 'RENEWAL', status: 'ACTIVE' }],
    ])('refuses %s and writes nothing', async (_label, row) => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: 20, ...row });
        await expect(markBgConsent(20, 5)).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('takes a PERSON_BG only on its own submit path, still conditional on an open status', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: 20, kind: 'PERSON_BG', status: 'PENDING_BG_REVIEW', bgConsentAt: null });
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
        await markBgConsent(20, 5, 'PERSON_BG');
        const where = prisma.orgMembershipProcess.updateMany.mock.calls[0][0].where;
        expect(where).toMatchObject({ id: 20, bgConsentAt: null, kind: { in: ['PERSON_BG'] } });
        expect(where.status.in).not.toContain('ARCHIVED');
    });
});

describe('findProcessByEnvelope', () => {
    it('looks up the process by zohoEnvelopeId — archived never matches, blocked still does', async () => {
        prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 9 });
        const result = await findProcessByEnvelope('req-9');
        expect(prisma.orgMembershipProcess.findFirst).toHaveBeenCalledWith({
            where: { zohoEnvelopeId: 'req-9', status: { in: expect.not.arrayContaining(['ARCHIVED']) } },
        });
        const where = prisma.orgMembershipProcess.findFirst.mock.calls[0][0].where;
        expect(where.status.in).toContain('BLOCKED');
        expect(where.status.in).toContain('PENDING_EXTERNAL_ACTION');
        expect(result).toEqual({ id: 9 });
    });
});

describe('selfRecordBgConsent', () => {
    const pendingProcess = {
        id: 20,
        kind: 'INITIAL',
        status: 'PENDING_EXTERNAL_ACTION',
        contractSignedAt: null,
        bgConsentAt: null,
        bgClearedAt: null,
        zohoEnvelopeId: null,
    };
    const leadUser = {
        id: 1,
        householdId: 7,
        isSysadmin: false,
        isHouseholdLead: true,
        household: { orgMembership: { processes: [pendingProcess] } },
    };

    it('not_found when the user does not exist', async () => {
        prisma.person.findUnique.mockResolvedValue(null);
        await expect(selfRecordBgConsent(1)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('no_household when the user has no household', async () => {
        prisma.person.findUnique.mockResolvedValue({ ...leadUser, householdId: null });
        await expect(selfRecordBgConsent(1)).rejects.toMatchObject({ code: 'no_household' });
    });

    it('not_lead when the caller is not a household lead and not a sysadmin', async () => {
        prisma.person.findUnique.mockResolvedValue({ ...leadUser, isHouseholdLead: false });
        await expect(selfRecordBgConsent(1)).rejects.toMatchObject({ code: 'not_lead' });
    });

    it('wrong_phase when no process is awaiting external action', async () => {
        prisma.person.findUnique.mockResolvedValue({
            ...leadUser,
            household: { orgMembership: { processes: [{ ...pendingProcess, status: 'PENDING_PAYMENT' }] } },
        });
        await expect(selfRecordBgConsent(1)).rejects.toMatchObject({ code: 'wrong_phase' });
    });

    it('records consent with the applicant as the audit actor and returns the external status', async () => {
        prisma.person.findUnique.mockResolvedValue(leadUser);
        prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
        prisma.orgMembershipProcess.findUnique
            .mockResolvedValueOnce(pendingProcess) // markBgConsent guard
            // advanceExternalIfComplete re-read: consent set, contract still unsigned → no advance
            .mockResolvedValueOnce({ ...pendingProcess, bgConsentAt: new Date() });

        const status = await selfRecordBgConsent(1);

        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ id: 20, bgConsentAt: null, kind: { in: ['INITIAL', 'RENEWAL'] } }) }),
        );
        expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 1 }) });
        expect(status.bgConsented).toBe(true);
        expect(status.contractSigned).toBe(false);
    });

    describe('own PERSON_BG obligation', () => {
        const personBg = { id: 30, kind: 'PERSON_BG', status: 'PENDING_BG_REVIEW', subjectPersonId: 1, bgConsentAt: null };
        const adultMember = { ...leadUser, isHouseholdLead: false, household: { orgMembership: { processes: [] } } };

        beforeEach(() => {
            prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
        });

        it('lets a non-lead record consent on their own obligation, as the audit actor, and pings reviewers', async () => {
            prisma.person.findUnique.mockResolvedValue(adultMember);
            prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 30, bgConsentAt: null });
            prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
            prisma.orgMembershipProcess.findUnique
                .mockResolvedValueOnce(personBg) // markBgConsent guard
                .mockResolvedValueOnce({ ...personBg, bgConsentAt: new Date() }); // advanceExternalIfComplete read

            const status = await selfRecordBgConsent(1);

            expect(prisma.orgMembershipProcess.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({ where: { kind: 'PERSON_BG', subjectPersonId: 1, status: 'PENDING_BG_REVIEW' } }),
            );
            expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: expect.objectContaining({ id: 30, bgConsentAt: null, kind: { in: ['PERSON_BG'] } }) }),
            );
            expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 1, affectedEntityId: 30 }) });
            expect(notifyReviewers).toHaveBeenCalledTimes(1);
            expect(status.bgConsented).toBe(true);
        });

        it('takes the obligation of a person with no household', async () => {
            prisma.person.findUnique.mockResolvedValue({ ...adultMember, householdId: null, household: null });
            prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 30, bgConsentAt: null });
            prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
            prisma.orgMembershipProcess.findUnique
                .mockResolvedValueOnce(personBg)
                .mockResolvedValueOnce({ ...personBg, bgConsentAt: new Date() });

            await expect(selfRecordBgConsent(1)).resolves.toMatchObject({ bgConsented: true });
        });

        it('a second attestation writes nothing and pings nobody', async () => {
            const consented = { ...personBg, bgConsentAt: new Date() };
            prisma.person.findUnique.mockResolvedValue(adultMember);
            prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 30, bgConsentAt: consented.bgConsentAt });
            prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 0 });
            prisma.orgMembershipProcess.findUnique.mockResolvedValue(consented);

            const status = await selfRecordBgConsent(1);

            expect(prisma.auditLog.create).not.toHaveBeenCalled();
            expect(notifyReviewers).not.toHaveBeenCalled();
            expect(status.bgConsented).toBe(true);
        });

        it('refuses a non-lead with no obligation, writing nothing', async () => {
            prisma.person.findUnique.mockResolvedValue(adultMember);
            prisma.orgMembershipProcess.findFirst.mockResolvedValue(null);

            await expect(selfRecordBgConsent(1)).rejects.toMatchObject({ code: 'not_lead' });
            expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        });

        it('a lead with an application awaiting consent attests the household, never their own obligation', async () => {
            prisma.person.findUnique.mockResolvedValue(leadUser);
            prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
            prisma.orgMembershipProcess.findUnique
                .mockResolvedValueOnce(pendingProcess)
                .mockResolvedValueOnce({ ...pendingProcess, bgConsentAt: new Date() });

            await selfRecordBgConsent(1);

            expect(prisma.orgMembershipProcess.findFirst).not.toHaveBeenCalled();
            expect(prisma.orgMembershipProcess.updateMany.mock.calls[0][0].where).toMatchObject({ id: 20 });
        });

        it('a lead with no application awaiting consent attests their own obligation', async () => {
            prisma.person.findUnique.mockResolvedValue({ ...leadUser, household: { orgMembership: { processes: [] } } });
            prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 30, bgConsentAt: null });
            prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
            prisma.orgMembershipProcess.findUnique
                .mockResolvedValueOnce(personBg)
                .mockResolvedValueOnce({ ...personBg, bgConsentAt: new Date() });

            await selfRecordBgConsent(1);

            expect(prisma.orgMembershipProcess.updateMany.mock.calls[0][0].where).toMatchObject({ id: 30, kind: { in: ['PERSON_BG'] } });
        });
    });
});

describe('advanceExternalIfComplete', () => {
    const readyProcess = {
        id: 20,
        orgMembershipId: 42,
        status: 'PENDING_EXTERNAL_ACTION',
        contractSignedAt: new Date(),
        bgConsentAt: new Date(),
        bgClearedAt: null,
    };

    beforeEach(() => {
        prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
        prisma.orgMembership.findUnique.mockResolvedValue({ householdId: 7 });
    });

    it('winner: applies the volunteer allowlist at the PENDING_PAYMENT transition and pings reviewers', async () => {
        const advanced = { ...readyProcess, status: 'PENDING_PAYMENT' };
        prisma.orgMembershipProcess.findUnique
            .mockResolvedValueOnce(readyProcess) // pre-tx eligibility read
            .mockResolvedValueOnce(advanced); // re-read inside the tx
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });

        const result = await advanceExternalIfComplete(20);

        // Allowlist matched now — the membership fee is read at PENDING_PAYMENT, before clearance.
        expect(applyVolunteerFamilyStatus).toHaveBeenCalledWith(prisma, 42, 7, false);
        expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
        expect(notifyReviewers).toHaveBeenCalledTimes(1); // check not yet cleared → review still needed
        expect(result).toEqual(advanced);
    });

    it('winner with a prior valid check (bgClearedAt) still applies the allowlist but does not ping reviewers', async () => {
        const cleared = { ...readyProcess, bgConsentAt: null, bgClearedAt: new Date() };
        prisma.orgMembershipProcess.findUnique
            .mockResolvedValueOnce(cleared)
            .mockResolvedValueOnce({ ...cleared, status: 'PENDING_PAYMENT' });
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });

        await advanceExternalIfComplete(20);

        expect(applyVolunteerFamilyStatus).toHaveBeenCalledWith(prisma, 42, 7, false);
        expect(notifyReviewers).not.toHaveBeenCalled();
    });

    it('loser of the race (count 0): no allowlist match, no audit, no ping', async () => {
        prisma.orgMembershipProcess.findUnique
            .mockResolvedValueOnce(readyProcess)
            .mockResolvedValueOnce({ ...readyProcess, status: 'PENDING_PAYMENT' }); // post-tx re-read
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 0 });

        await advanceExternalIfComplete(20);

        expect(applyVolunteerFamilyStatus).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
        expect(notifyReviewers).not.toHaveBeenCalled();
    });

    it('not yet eligible (contract unsigned): returns early without touching anything', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValueOnce({ ...readyProcess, contractSignedAt: null });

        await advanceExternalIfComplete(20);

        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
        expect(applyVolunteerFamilyStatus).not.toHaveBeenCalled();
    });

    it('RENEWAL: the contract gate applies too — an unsigned renewal does not advance on consent alone', async () => {
        // A fresh agreement is signed every cycle (beginRenewal), so a renewal
        // with consent but no signature must stay at PENDING_EXTERNAL_ACTION.
        prisma.orgMembershipProcess.findUnique.mockResolvedValueOnce({ ...readyProcess, kind: 'RENEWAL', contractSignedAt: null });

        await advanceExternalIfComplete(20);

        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
        expect(applyVolunteerFamilyStatus).not.toHaveBeenCalled();
        expect(notifyReviewers).not.toHaveBeenCalled();
    });
});

describe('getOrCreateContractSigningUrl', () => {
    const pendingProcess = { id: 20, status: 'PENDING_EXTERNAL_ACTION', zohoEnvelopeId: null, zohoActionId: null };
    const leadUser = {
        id: 1,
        householdId: 7,
        isSysadmin: false,
        email: 'lead@example.com',
        name: 'Lead Person',
        isHouseholdLead: true,
        household: { orgMembership: { processes: [pendingProcess] } },
    };

    it('not_configured when Zoho is unavailable', async () => {
        config.zohoAvailable.mockReturnValue(false);
        await expect(getOrCreateContractSigningUrl(1)).rejects.toMatchObject({ code: 'not_configured' });
        expect(prisma.person.findUnique).not.toHaveBeenCalled();
    });

    it('not_found when the user does not exist', async () => {
        prisma.person.findUnique.mockResolvedValue(null);
        await expect(getOrCreateContractSigningUrl(1)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('no_household when the user has no household', async () => {
        prisma.person.findUnique.mockResolvedValue({ ...leadUser, householdId: null });
        await expect(getOrCreateContractSigningUrl(1)).rejects.toMatchObject({ code: 'no_household' });
    });

    it('not_lead when the caller is not a household lead and not a sysadmin', async () => {
        prisma.person.findUnique.mockResolvedValue({ ...leadUser, isHouseholdLead: false });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(null); // no PERSON_AGREEMENT of their own
        await expect(getOrCreateContractSigningUrl(1)).rejects.toMatchObject({ code: 'not_lead' });
    });

    it('wrong_phase when there is no process awaiting external action', async () => {
        prisma.person.findUnique.mockResolvedValue({ ...leadUser, household: { orgMembership: { processes: [] } } });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(null);
        await expect(getOrCreateContractSigningUrl(1)).rejects.toMatchObject({ code: 'wrong_phase' });
    });

    // The one gate that opens. A non-lead still can't sign the HOUSEHOLD agreement
    // (the test above), but signs their own individual one — no lead role, and no household
    // application in flight, which is the normal state for an adult child in a settled
    // member household.
    it('a non-lead signs their OWN PERSON_AGREEMENT, bypassing the household lead gate', async () => {
        prisma.person.findUnique.mockResolvedValue({
            ...leadUser,
            isHouseholdLead: false,
            household: { orgMembership: { processes: [] } },
        });
        prisma.orgMembershipProcess.findFirst.mockResolvedValue({
            id: 55, kind: 'PERSON_AGREEMENT', status: 'PENDING_EXTERNAL_ACTION',
            subjectPersonId: 1, zohoEnvelopeId: null, zohoActionId: null, contractSignedAt: null,
        });
        zohoSign.getAccessToken.mockResolvedValue('token-1');
        zohoSign.createRequest.mockResolvedValue({ requestId: 'req-own', actionId: 'act-own', documentId: 'doc-own' });
        zohoSign.submitRequest.mockResolvedValue(undefined);
        zohoSign.getEmbeddedSignUrl.mockResolvedValue('https://sign.example/embed-own');
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });

        const url = await getOrCreateContractSigningUrl(1);

        expect(url).toBe('https://sign.example/embed-own');
        // Claimed against the person's OWN process, not a household one.
        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ id: 55 }) }),
        );
    });

    // A lead is checked FIRST, so a stray PERSON_AGREEMENT can never shadow the household
    // process and stall activation/renewal with no UI explanation.
    it('a household lead signs the HOUSEHOLD process even with an open PERSON_AGREEMENT', async () => {
        prisma.person.findUnique.mockResolvedValue(leadUser);
        prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 55, kind: 'PERSON_AGREEMENT', status: 'PENDING_EXTERNAL_ACTION' });
        zohoSign.getAccessToken.mockResolvedValue('token-1');
        zohoSign.createRequest.mockResolvedValue({ requestId: 'req-hh', actionId: 'act-hh', documentId: 'doc-hh' });
        zohoSign.submitRequest.mockResolvedValue(undefined);
        zohoSign.getEmbeddedSignUrl.mockResolvedValue('https://sign.example/embed-hh');
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });

        await getOrCreateContractSigningUrl(1);

        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ id: 20 }) }),
        );
    });

    it('mock mode: skips loadAgreementPdf/stampWatermark and creates + submits + embeds', async () => {
        prisma.person.findUnique.mockResolvedValue(leadUser);
        zohoSign.getAccessToken.mockResolvedValue('token-1');
        zohoSign.createRequest.mockResolvedValue({ requestId: 'req-1', actionId: 'act-1', documentId: 'doc-1' });
        zohoSign.submitRequest.mockResolvedValue(undefined);
        zohoSign.getEmbeddedSignUrl.mockResolvedValue('https://sign.example/embed');
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });

        const url = await getOrCreateContractSigningUrl(1);

        expect(loadAgreementPdf).not.toHaveBeenCalled();
        expect(stampWatermark).not.toHaveBeenCalled();
        expect(zohoSign.createRequest).toHaveBeenCalledTimes(1);
        expect(zohoSign.submitRequest).toHaveBeenCalledTimes(1);
        // Claimed for the caller BEFORE Zoho is called, then the ids stored under that claim.
        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenNthCalledWith(1, {
            where: { id: 20, zohoSignerPersonId: null, OR: [{ zohoEnvelopeId: null }, { zohoActionId: null }] },
            data: { zohoSignerPersonId: 1 },
        });
        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenNthCalledWith(2, {
            where: { id: 20, zohoSignerPersonId: 1 },
            data: { zohoEnvelopeId: 'req-1', zohoActionId: 'act-1' },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
        expect(url).toBe('https://sign.example/embed');
    });

    it('already claimed ids → skips create/submit and goes straight to the embed URL', async () => {
        prisma.person.findUnique.mockResolvedValue({
            ...leadUser,
            household: { orgMembership: { processes: [{ ...pendingProcess, zohoEnvelopeId: 'req-existing', zohoActionId: 'act-existing' }] } },
        });
        zohoSign.getAccessToken.mockResolvedValue('token-1');
        zohoSign.getRequestStatus.mockResolvedValue('in_progress');
        zohoSign.getEmbeddedSignUrl.mockResolvedValue('https://sign.example/embed-existing');

        const url = await getOrCreateContractSigningUrl(1);

        expect(zohoSign.createRequest).not.toHaveBeenCalled();
        expect(zohoSign.submitRequest).not.toHaveBeenCalled();
        expect(url).toBe('https://sign.example/embed-existing');
    });

    it('dead stored request (declined/expired) → clears the ids and creates a fresh one', async () => {
        prisma.person.findUnique.mockResolvedValue({
            ...leadUser,
            household: { orgMembership: { processes: [{ ...pendingProcess, zohoEnvelopeId: 'req-dead', zohoActionId: 'act-dead' }] } },
        });
        zohoSign.getAccessToken.mockResolvedValue('token-1');
        zohoSign.getRequestStatus.mockResolvedValue('terminal');
        zohoSign.createRequest.mockResolvedValue({ requestId: 'req-fresh', actionId: 'act-fresh', documentId: 'doc-fresh' });
        zohoSign.getEmbeddedSignUrl.mockResolvedValue('https://sign.example/embed-fresh');
        prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });

        const url = await getOrCreateContractSigningUrl(1);

        // The dead pair is forgotten (conditional on still pointing at it)…
        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith({
            where: { id: 20, zohoEnvelopeId: 'req-dead', contractSignedAt: null },
            data: { zohoEnvelopeId: null, zohoActionId: null, zohoSignerPersonId: null },
        });
        // …and a fresh request is created and embedded.
        expect(zohoSign.createRequest).toHaveBeenCalledTimes(1);
        expect(zohoSign.getEmbeddedSignUrl).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-fresh', actionId: 'act-fresh' }));
        expect(url).toBe('https://sign.example/embed-fresh');
    });

    it('status check failure → falls back to embedding the stored request (best-effort)', async () => {
        prisma.person.findUnique.mockResolvedValue({
            ...leadUser,
            household: { orgMembership: { processes: [{ ...pendingProcess, zohoEnvelopeId: 'req-existing', zohoActionId: 'act-existing' }] } },
        });
        zohoSign.getAccessToken.mockResolvedValue('token-1');
        zohoSign.getRequestStatus.mockRejectedValue(new Error('Zoho 503'));
        zohoSign.getEmbeddedSignUrl.mockResolvedValue('https://sign.example/embed-existing');

        const url = await getOrCreateContractSigningUrl(1);

        expect(zohoSign.createRequest).not.toHaveBeenCalled();
        expect(url).toBe('https://sign.example/embed-existing');
    });

    it('non-mock mode: AgreementUnavailableError maps to an agreement_unavailable ExternalError', async () => {
        config.zohoMockActive.mockReturnValue(false);
        prisma.person.findUnique.mockResolvedValue(leadUser);
        zohoSign.getAccessToken.mockResolvedValue('token-1');
        loadAgreementPdf.mockRejectedValue(new AgreementUnavailableError('no pdf yet'));
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 }); // wins the claim, then releases it

        await expect(getOrCreateContractSigningUrl(1)).rejects.toMatchObject({ code: 'agreement_unavailable' });
    });

    // ops-stg: CHECKIN_ENV=stg falls back to 'prod' (readCheckinEnv), so config.isProd()
    // alone would call ops-stg's signing flow "prod" and skip the watermark/prefix the
    // moment a real Zoho credential is ever wired to staging to rehearse signing —
    // producing a document indistinguishable from a binding prod agreement. isStaging()
    // must override isProd() here regardless.
    it('ops-stg (CHECKIN_ENV=stg, isProd()=true via the readCheckinEnv stg->prod fallback): watermark + [DEV TEST] prefix still applied', async () => {
        const prevStaging = process.env.CHECKIN_ENV;
        process.env.CHECKIN_ENV = 'stg';
        try {
            config.isProd.mockReturnValue(true); // the stg->'prod' fallback (readCheckinEnv)
            prisma.person.findUnique.mockResolvedValue(leadUser);
            zohoSign.getAccessToken.mockResolvedValue('token-1');
            const rawPdf = Buffer.from('raw-agreement');
            const watermarkedPdf = Buffer.from('watermarked-agreement');
            loadAgreementPdf.mockResolvedValue({ pdf: rawPdf, lastPageNo: 1, pageWidth: 1, pageHeight: 1 });
            stampWatermark.mockResolvedValue(watermarkedPdf);
            zohoSign.createRequest.mockResolvedValue({ requestId: 'req-stg', actionId: 'act-stg', documentId: 'doc-stg' });
            zohoSign.submitRequest.mockResolvedValue(undefined);
            zohoSign.getEmbeddedSignUrl.mockResolvedValue('https://sign.example/embed-stg');
            prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 }); // wins the id claim

            await getOrCreateContractSigningUrl(1);

            expect(stampWatermark).toHaveBeenCalledWith(rawPdf, 'DEV TEST — NOT A LEGAL AGREEMENT');
            expect(zohoSign.createRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    pdf: watermarkedPdf,
                    requestName: expect.stringContaining('[DEV TEST — NOT BINDING] '),
                }),
            );
        } finally {
            if (prevStaging === undefined) delete process.env.CHECKIN_ENV;
            else process.env.CHECKIN_ENV = prevStaging;
        }
    });

    // Zoho charges per request: a second lead never gets one while the first lead's is open.
    it("another lead's open request → signing_in_progress naming them, nothing created", async () => {
        prisma.person.findUnique
            .mockResolvedValueOnce({
                ...leadUser,
                household: { orgMembership: { processes: [{ ...pendingProcess, zohoEnvelopeId: 'req-a', zohoActionId: 'act-a', zohoSignerPersonId: 2 }] } },
            })
            .mockResolvedValueOnce({ name: 'Alex Lead', email: 'alex@example.com' });
        zohoSign.getAccessToken.mockResolvedValue('token-1');
        zohoSign.getRequestStatus.mockResolvedValue('in_progress');

        await expect(getOrCreateContractSigningUrl(1)).rejects.toMatchObject({
            code: 'signing_in_progress',
            message: 'Alex Lead started signing. Ask Alex Lead to finish, or ask the board to reset the signing so you can sign.',
        });
        expect(zohoSign.createRequest).not.toHaveBeenCalled();
        expect(zohoSign.getEmbeddedSignUrl).not.toHaveBeenCalled();
    });

    it('lost the claim to another lead → signing_in_progress before any Zoho request is created', async () => {
        prisma.person.findUnique
            .mockResolvedValueOnce(leadUser)
            .mockResolvedValueOnce({ name: 'Alex Lead', email: 'alex@example.com' });
        zohoSign.getAccessToken.mockResolvedValue('token-1');
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 0 });
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ ...pendingProcess, zohoSignerPersonId: 2 });

        await expect(getOrCreateContractSigningUrl(1)).rejects.toMatchObject({ code: 'signing_in_progress' });
        expect(zohoSign.createRequest).not.toHaveBeenCalled();
        expect(zohoSign.getEmbeddedSignUrl).not.toHaveBeenCalled();
    });

    it('own concurrent click still creating → wait message, no second Zoho request', async () => {
        prisma.person.findUnique.mockResolvedValue(leadUser);
        zohoSign.getAccessToken.mockResolvedValue('token-1');
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 0 });
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ ...pendingProcess, zohoSignerPersonId: 1 });

        await expect(getOrCreateContractSigningUrl(1)).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(zohoSign.createRequest).not.toHaveBeenCalled();
    });

    it('a failed Zoho create releases the claim so the next click can retry', async () => {
        prisma.person.findUnique.mockResolvedValue(leadUser);
        zohoSign.getAccessToken.mockResolvedValue('token-1');
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
        zohoSign.createRequest.mockRejectedValue(new Error('Zoho 500'));

        await expect(getOrCreateContractSigningUrl(1)).rejects.toThrow('Zoho 500');
        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenLastCalledWith({
            where: { id: 20, zohoSignerPersonId: 1, OR: [{ zohoEnvelopeId: null }, { zohoActionId: null }] },
            data: { zohoSignerPersonId: null },
        });
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
});

describe('markContractSigned', () => {
    it('PERSON_AGREEMENT: the CAS also requires PENDING_EXTERNAL_ACTION, so an archived agreement never flips ACTIVE', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: 55, kind: 'PERSON_AGREEMENT', status: 'ARCHIVED' });
        prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 0 });

        await markContractSigned(55);

        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 55, contractSignedAt: null, status: 'PENDING_EXTERNAL_ACTION' },
        }));
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    // The request's addressee may never have signed; the record must not name them.
    it('a board-recorded signature clears the signer; a Zoho one keeps it', async () => {
        prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ id: 20, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION', zohoSignerPersonId: 2 });

        await markContractSigned(20, 9, true);
        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: { contractSignedAt: expect.any(Date), zohoSignerPersonId: null },
        }));
        expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            newData: { contractSignedAt: true, zohoSignerPersonId: null },
        }) });

        prisma.orgMembershipProcess.updateMany.mockClear();
        await markContractSigned(20);
        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: { contractSignedAt: expect.any(Date) },
        }));
    });
});

describe('resetSigning', () => {
    const open = { id: 20, status: 'PENDING_EXTERNAL_ACTION', contractSignedAt: null, zohoEnvelopeId: 'req-a', zohoActionId: 'act-a', zohoSignerPersonId: 2 };

    beforeEach(() => {
        prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
        zohoSign.getAccessToken.mockResolvedValue('token-1');
    });

    it('recalls the Zoho request, clears ids + signer, and audits the reason', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(open);
        zohoSign.recallRequest.mockResolvedValue(undefined);
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });

        await resetSigning(20, 9, 'Alex is travelling');

        expect(zohoSign.recallRequest).toHaveBeenCalledWith('token-1', 'req-a');
        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith({
            where: { id: 20, zohoEnvelopeId: 'req-a', zohoSignerPersonId: 2, contractSignedAt: null },
            data: { zohoEnvelopeId: null, zohoActionId: null, zohoSignerPersonId: null },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            actorId: 9,
            oldData: { zohoEnvelopeId: 'req-a', zohoActionId: 'act-a', zohoSignerPersonId: 2 },
            newData: expect.objectContaining({ resetSigningReason: 'Alex is travelling' }),
        }) });
    });

    it('a request Zoho already considers dead still resets', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(open);
        zohoSign.recallRequest.mockRejectedValue(new Error('already recalled'));
        zohoSign.getRequestStatus.mockResolvedValue('terminal');
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });

        await resetSigning(20, 9, 'expired');

        expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('a request signed in Zoho is not reset', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue(open);
        zohoSign.recallRequest.mockRejectedValue(new Error('cannot recall'));
        zohoSign.getRequestStatus.mockResolvedValue('completed');

        await expect(resetSigning(20, 9, 'x')).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(prisma.orgMembershipProcess.updateMany).not.toHaveBeenCalled();
    });

    it('clears a claim whose create never finished, without calling Zoho', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ ...open, zohoEnvelopeId: null, zohoActionId: null });
        prisma.orgMembershipProcess.updateMany.mockResolvedValue({ count: 1 });

        await resetSigning(20, 9, 'stuck');

        expect(zohoSign.recallRequest).not.toHaveBeenCalled();
        expect(prisma.orgMembershipProcess.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 20, zohoEnvelopeId: null, zohoSignerPersonId: 2, contractSignedAt: null },
        }));
    });

    it('wrong_phase when already signed or nothing is open — Zoho is never called', async () => {
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ ...open, contractSignedAt: new Date() });
        await expect(resetSigning(20, 9, 'x')).rejects.toMatchObject({ code: 'wrong_phase' });
        prisma.orgMembershipProcess.findUnique.mockResolvedValue({ ...open, zohoEnvelopeId: null, zohoSignerPersonId: null });
        await expect(resetSigning(20, 9, 'x')).rejects.toMatchObject({ code: 'wrong_phase' });
        expect(zohoSign.recallRequest).not.toHaveBeenCalled();
    });
});

describe('getOwnBackgroundCheck', () => {
    const householdProcess = { id: 20, status: 'PENDING_EXTERNAL_ACTION' as const };
    const adult = { id: 1, householdId: 7, isHouseholdLead: false, isSysadmin: false, household: { orgMembership: { processes: [householdProcess] } } };

    beforeEach(() => {
        jest.spyOn(backgroundCheckProvider, 'getConsentDeepLink').mockResolvedValue('https://averity.example/consent');
    });

    it('offers a non-lead their own check awaiting review, with the consent link', async () => {
        prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 30, bgConsentAt: null });

        await expect(getOwnBackgroundCheck(adult)).resolves.toEqual({ consented: false, deepLinkUrl: 'https://averity.example/consent' });
        expect(prisma.orgMembershipProcess.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { kind: 'PERSON_BG', subjectPersonId: 1, status: 'PENDING_BG_REVIEW' }, select: { id: true, bgConsentAt: true } }),
        );
    });

    it('reports consent already on file', async () => {
        prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 30, bgConsentAt: new Date() });

        await expect(getOwnBackgroundCheck(adult)).resolves.toMatchObject({ consented: true });
    });

    it('is null when the person has no check awaiting review', async () => {
        prisma.orgMembershipProcess.findFirst.mockResolvedValue(null);

        await expect(getOwnBackgroundCheck(adult)).resolves.toBeNull();
    });

    it("is null for a lead whose consent goes to the household's application", async () => {
        await expect(getOwnBackgroundCheck({ ...adult, isHouseholdLead: true })).resolves.toBeNull();
        expect(prisma.orgMembershipProcess.findFirst).not.toHaveBeenCalled();
    });

    it("offers a lead their own check once the household's application no longer awaits consent", async () => {
        prisma.orgMembershipProcess.findFirst.mockResolvedValue({ id: 30, bgConsentAt: null });
        const lead = { ...adult, isHouseholdLead: true, household: { orgMembership: { processes: [{ ...householdProcess, status: 'PENDING_PAYMENT' as const }] } } };

        await expect(getOwnBackgroundCheck(lead)).resolves.toMatchObject({ consented: false });
    });
});
