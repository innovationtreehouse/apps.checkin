/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { emailBoardMembers } from '@/lib/emailRecipients';
import { logger } from '@/lib/logger';
import { notifyBoardCheckRejected } from '@/lib/membership/boardAlerts';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: { orgMembershipProcess: { findUnique: jest.fn() } } }));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn().mockResolvedValue(1) }));
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

const findReview = prisma.orgMembershipProcess.findUnique as jest.Mock;
const email = jest.mocked(emailBoardMembers);

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
