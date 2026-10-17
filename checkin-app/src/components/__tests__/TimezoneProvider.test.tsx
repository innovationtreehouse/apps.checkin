import { render, screen } from '@testing-library/react';
import { TimezoneProvider, useOrgTime } from '@/components/TimezoneProvider';
import { pinTimezone } from '@/test-helpers/tz';

// 9:30 PM Aug 31 in Chicago, 11:30 AM Sep 1 in Tokyo — a different hour AND a
// different day, so a formatter stuck on the compiled-in zone cannot pass.
const INSTANT = '2026-09-01T02:30:00.000Z';

function Stamp() {
    const { formatDateTime } = useOrgTime();
    return <span data-testid="stamp">{formatDateTime(INSTANT)}</span>;
}

describe('TimezoneProvider', () => {
    // The process zone is deliberately not the org zone: these assertions must
    // follow the configured setting, not whatever the machine is running in.
    pinTimezone('America/Chicago');

    it('renders an instant in the configured org timezone, not the compiled-in default', () => {
        render(
            <TimezoneProvider value="Asia/Tokyo">
                <Stamp />
            </TimezoneProvider>,
        );
        const text = screen.getByTestId('stamp').textContent!;
        expect(text).toContain('9/1/2026');
        expect(text).toContain('11:30');
        expect(text).not.toContain('8/31/2026');
    });

    // Type-level guard: the tree's zone always wins, so the options must not
    // advertise a `timeZone` the formatter would accept and then discard.
    it('rejects a caller-supplied timeZone at compile time', () => {
        function Rejected() {
            const { formatDate } = useOrgTime();
            // @ts-expect-error timeZone is omitted from the accepted options
            return <>{formatDate(INSTANT, { timeZone: 'Asia/Tokyo' })}</>;
        }
        expect(Rejected).toBeDefined();
    });

    it('falls back to APP_TIMEZONE when the configured zone is missing', () => {
        render(
            <TimezoneProvider value={''}>
                <Stamp />
            </TimezoneProvider>,
        );
        const text = screen.getByTestId('stamp').textContent!;
        expect(text).toContain('8/31/2026');
        expect(text).toContain('9:30');
    });
});
