/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { emailBoardMembers } from '@/lib/emailRecipients';
import { logger } from '@/lib/logger';
import { notifyBoardCheckRejected, notifyBoardOfYouthLeads } from '@/lib/membership/boardAlerts';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: { orgMembershipProcess: { findUnique: jest.fn() }, person: { findMany: jest.fn() } } }));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn().mockResolvedValue(1) }));
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

const findReview = prisma.orgMembershipProcess.findUnique as jest.Mock;
const findPeople = prisma.person.findMany as jest.Mock;
const email = jest.mocked(emailBoardMembers);
const yearsAgo = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear() - n, 0, 1));

beforeEach(() => jest.clearAllMocks());

describe('notifyBoardCheckRejected', () => {
    it('emails the Board naming the person, their household and the review', async () => {
        findReview.mockResolvedValue({ subjectPerson: { name: 'Alex Rivera', household: { name: 'Rivera' } } });
        await notifyBoardCheckRejected(41);
        expect(findReview).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 41 } }));
        expect(email).toHaveBeenCalledWith('board.checkRejected', {
            personName: 'Alex Rivera',
            householdName: 'Rivera',
            reviewId: '41',
            actionLink: expect.stringMatching(/\/membership-ops\/applications$/),
        }, expect.any(String));
    });

    it('sends nothing and does not throw when the review cannot be read', async () => {
        findReview.mockRejectedValue(new Error('db down'));
        await expect(notifyBoardCheckRejected(42)).resolves.toBeUndefined();
        expect(email).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.any(String), { reviewId: 42 }, expect.any(Error));
    });

    it('sends nothing for a review that names nobody', async () => {
        findReview.mockResolvedValue({ subjectPerson: null });
        await notifyBoardCheckRejected(43);
        expect(email).not.toHaveBeenCalled();
    });
});

describe('notifyBoardOfYouthLeads', () => {
    it('emails the Board about a lead whose saved date shows them under 18', async () => {
        findPeople.mockResolvedValue([{ name: 'Sam Lee', dateOfBirth: yearsAgo(15), household: { id: 9, name: 'Lee' } }]);
        await notifyBoardOfYouthLeads([{ id: 7, dateOfBirth: null }]);
        expect(findPeople).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [7] }, isHouseholdLead: true } }));
        expect(email).toHaveBeenCalledWith('board.youthHouseholdLead', {
            personName: 'Sam Lee',
            householdName: 'Lee',
            actionLink: expect.stringMatching(/\/membership-ops\/households\/9$/),
        }, expect.any(String));
    });

    it('sends nothing for a lead who was already under 18 before the save', async () => {
        await notifyBoardOfYouthLeads([{ id: 7, dateOfBirth: yearsAgo(15) }]);
        expect(findPeople).not.toHaveBeenCalled();
        expect(email).not.toHaveBeenCalled();
    });

    it('sends nothing when the saved date shows an adult', async () => {
        findPeople.mockResolvedValue([{ name: 'Sam Lee', dateOfBirth: yearsAgo(30), household: { id: 9, name: 'Lee' } }]);
        await notifyBoardOfYouthLeads([{ id: 7, dateOfBirth: null }]);
        expect(email).not.toHaveBeenCalled();
    });

    it('sends nothing and does not throw when the leads cannot be read', async () => {
        findPeople.mockRejectedValue(new Error('db down'));
        await expect(notifyBoardOfYouthLeads([{ id: 7, dateOfBirth: null }])).resolves.toBeUndefined();
        expect(email).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.any(String), { ids: [7] }, expect.any(Error));
    });
});
