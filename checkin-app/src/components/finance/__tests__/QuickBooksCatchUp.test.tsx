import { noticeLines, slotLine } from '../QuickBooksCatchUp';

const IDLE = { lane: null, status: 'idle' as const, heldBy: null, until: null, queued: [], pausedUntil: null, lastRuns: {} };
const time = (date: string) => `[${date}]`;

describe('QuickBooks catch-up lines', () => {
    it('says nothing extra while nothing is paused or capped', () => {
        expect(noticeLines(IDLE, time)).toEqual([]);
        expect(slotLine(IDLE)).toBe('Nothing is posting to QuickBooks now. Posting runs every night.');
    });

    it('names a throttle pause and each lane whose last run stopped at its per-run limit', () => {
        const view = {
            ...IDLE,
            pausedUntil: '2026-11-18T14:04:00.000Z',
            lastRuns: {
                income: { ended: 'done', created: 100, capped: 'count' },
                expense: { ended: 'done', created: 50, capped: 'day' },
            },
        };
        expect(noticeLines(view, time)).toEqual([
            'Posting paused: QuickBooks asked us to slow down; resumes at [2026-11-18T14:04:00.000Z].',
            'The last Income run stopped after 100 entries; the rest go in the next run.',
        ]);
    });
});
