import { render, screen, act } from '@testing-library/react';
import { Suspense } from 'react';
import { TimezoneProvider, useOrgTime } from '@/components/TimezoneProvider';
import { APP_TIMEZONE } from '@/lib/time';
import { pinTimezone } from '@/test-helpers/tz';

// 10:30 PM Aug 31 in New York, 9:30 PM Aug 31 in Chicago — one hour apart, which is
// the reported symptom: a visit time rendered an hour off.
const INSTANT = '2026-09-01T02:30:00.000Z';

// Request A's leaf suspends on a slow read and formats only once it resolves, so its
// render lands after another request has already rendered. Rebuilt per test: `open`
// latches and never resets, so a shared gate would leave a second test's LateStamp
// never suspending — the interleave would not happen and the test would pass green
// while asserting nothing.
let release!: () => void;
let gate!: Promise<void>;
let open = false;

function LateStamp() {
    const { formatDateTime } = useOrgTime();
    if (!open) throw gate;
    return <span data-testid="late">{formatDateTime(INSTANT)}</span>;
}

function Stamp() {
    const { formatDateTime } = useOrgTime();
    return <span data-testid="b">{formatDateTime(INSTANT)}</span>;
}

// On the server a single lib/time module instance is shared by every concurrent
// request, so a zone held in module state belongs to whichever request wrote it last.
describe('concurrent renders do not share a display timezone', () => {
    pinTimezone('America/Chicago');

    beforeEach(() => {
        open = false;
        gate = new Promise<void>((r) => {
            release = r;
        });
        void gate.then(() => {
            open = true;
        });
    });

    it('keeps request A in its own zone while request B renders in another', async () => {
        // Request A: the org's configured zone, New York. Its leaf suspends.
        render(
            <TimezoneProvider value="America/New_York">
                <Suspense fallback={<span data-testid="pending" />}>
                    <LateStamp />
                </Suspense>
            </TimezoneProvider>,
        );

        // Request B renders meanwhile; its settings read threw and fell back.
        render(
            <TimezoneProvider value={APP_TIMEZONE}>
                <Stamp />
            </TimezoneProvider>,
        );

        // Request A's leaf finally renders.
        await act(async () => {
            release();
            await gate;
        });

        expect(screen.getByTestId('b').textContent).toContain('9:30');
        expect(screen.getByTestId('late').textContent).toContain('10:30');
    });
});
