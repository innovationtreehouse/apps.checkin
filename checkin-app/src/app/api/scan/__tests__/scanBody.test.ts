/**
 * @jest-environment node
 */
import { parseScanBody, type ScanBody } from '../scanBody';

const at = '2026-11-01T10:00:00.000Z';

function parse(body: unknown): ScanBody {
    const parsed = parseScanBody(body);
    if (!parsed.ok) throw new Error(`refused: ${parsed.error}`);
    return parsed.scan;
}

function refusal(body: unknown): string {
    const parsed = parseScanBody(body);
    if (parsed.ok) throw new Error(`parsed as ${parsed.scan.kind}`);
    return parsed.error;
}

describe('parseScanBody', () => {
    describe('a live scan', () => {
        it('reads a bare badge id as a live toggle at protocol 1', () => {
            expect(parse({ personId: 7 })).toEqual({
                kind: 'live', slot: 'live', rawId: 7, personId: 7, clientEventId: null, scannedAt: null,
                intent: null, clockSuspect: false, rosterAsOf: null, shownEmpty: null,
                protocolVersion: 1, recordedVersion: 1,
            });
        });

        it('reads an older kiosk\'s participantId as the badge id', () => {
            expect(parse({ participantId: 7 })).toMatchObject({ kind: 'live', personId: 7 });
        });

        it('keeps a try-first clientEventId and the displayed intent', () => {
            expect(parse({ personId: 7, clientEventId: 'e1', intent: 'OUT', protocolVersion: 5, clockSuspect: true }))
                .toMatchObject({ kind: 'live', clientEventId: 'e1', intent: 'OUT', protocolVersion: 5, recordedVersion: 5, clockSuspect: true });
        });

        it('normalizes an empty clientEventId to none', () => {
            expect(parse({ personId: 7, clientEventId: '' })).toMatchObject({ kind: 'live', clientEventId: null });
        });

        it('ignores a live scan\'s uncertainty: only a replay carries one', () => {
            expect(parse({ personId: 7, scanTimeUncertaintyMs: 1e16 })).toMatchObject({ kind: 'live', clockSuspect: false });
        });
    });

    describe('a replay', () => {
        const replay = { personId: 7, replay: true, clientEventId: 'e1', scannedAt: at, intent: 'IN' };

        it('carries its own id, scan time and uncertainty', () => {
            expect(parse({ ...replay, scanTimeUncertaintyMs: 500 })).toMatchObject({
                kind: 'replay', slot: 'replay', clientEventId: 'e1', scannedAt: new Date(at), uncertaintyMs: 500, clockSuspect: false,
            });
        });

        it('marks an implausibly wide uncertainty as a suspect clock and drops it', () => {
            expect(parse({ ...replay, scanTimeUncertaintyMs: 1e16 })).toMatchObject({ kind: 'replay', uncertaintyMs: 0, clockSuspect: true });
        });

        it('keeps an id that resolves to no one, to park as unresolvable', () => {
            expect(parse({ ...replay, personId: 99999999999 })).toMatchObject({ kind: 'replay', rawId: 99999999999, personId: null });
        });

        it('keeps disagreeing ids as no person instead of refusing', () => {
            expect(parse({ ...replay, participantId: 8 })).toMatchObject({ kind: 'replay', personId: null });
        });
    });

    describe('a dead letter', () => {
        it('carries the kiosk\'s status', () => {
            expect(parse({ personId: 7, dead: true, deadStatus: 500, clientEventId: 'e1', scannedAt: at })).toMatchObject({
                kind: 'dead', slot: 'dead', clientEventId: 'e1', scannedAt: new Date(at), status: 500, clockSuspect: false,
            });
        });

        it.each([undefined, 'boom', Infinity])('falls back to unknown for deadStatus %p', (deadStatus) => {
            expect(parse({ personId: 7, dead: true, deadStatus, clientEventId: 'e1', scannedAt: at })).toMatchObject({ status: 'unknown' });
        });

        it.each([
            ['an unknown intent', { intent: 'SIDEWAYS' }],
            ['a malformed protocolVersion', { protocolVersion: '2' }],
            ['an unknown close kind', { close: 'later' }],
        ])('is what an unreadable replay with %s becomes, status 400 and never a close', (_label, overrides) => {
            const scan = parse({ personId: 7, replay: true, clientEventId: 'e1', scannedAt: at, ...overrides });
            expect(scan).toMatchObject({ kind: 'dead', status: 400 });
        });

        it('records no version for a replay whose own version is invalid', () => {
            expect(parse({ personId: 7, replay: true, clientEventId: 'e1', scannedAt: at, protocolVersion: 1.5 }))
                .toMatchObject({ kind: 'dead', protocolVersion: 1.5, recordedVersion: null });
        });

        it('keys a replay with no id of its own by its body', () => {
            const body = { personId: 7, replay: true, scannedAt: at };
            const scan = parse(body);
            expect(scan).toMatchObject({ kind: 'dead', status: 400 });
            expect(scan.clientEventId).toMatch(/^body:[0-9a-f]{64}$/);
            expect(parse({ ...body }).clientEventId).toBe(scan.clientEventId);
        });

        it.each([
            ['without a scannedAt', {}],
            ['with an unparseable scannedAt', { scannedAt: 'not-a-date' }],
        ])('parks a replay %s as having no scan time, its clock suspect', (_label, overrides) => {
            expect(parse({ personId: 7, replay: true, clientEventId: 'e1', ...overrides }))
                .toMatchObject({ kind: 'dead', status: 'no_scan_time', scannedAt: null, clockSuspect: true });
        });
    });

    describe('a close', () => {
        it.each([
            ['alone', { close: 'alone' }],
            ['confirmed', { close: 'confirmed' }],
            ['confirmed', { forceCloseConfirmed: true }],
            ['confirmed', { forceCloseToken: 'tok' }],
            ['alone', { shownEmpty: true }],
        ])('reads %s from %p', (close, overrides) => {
            expect(parse({ personId: 7, ...overrides })).toMatchObject({ kind: 'close', slot: 'live', close });
        });

        it('treats an empty token as no token', () => {
            expect(parse({ personId: 7, forceCloseToken: '' })).toMatchObject({ kind: 'live' });
        });

        it('carries the kiosk\'s roster time', () => {
            expect(parse({ personId: 7, close: 'alone', rosterAsOf: at })).toMatchObject({ kind: 'close', rosterAsOf: new Date(at) });
        });

        it('arrives as a replay', () => {
            expect(parse({ personId: 7, close: 'confirmed', replay: true, clientEventId: 'e1', scannedAt: at }))
                .toMatchObject({ kind: 'close', slot: 'replay', clientEventId: 'e1', uncertaintyMs: 0 });
        });

        it('arrives as a dead letter', () => {
            expect(parse({ personId: 7, close: 'alone', dead: true, deadStatus: 502, clientEventId: 'e1', scannedAt: at }))
                .toMatchObject({ kind: 'close', slot: 'dead', status: 502 });
        });

        it('reads shownEmpty: false as no close, kept for an older kiosk', () => {
            expect(parse({ personId: 7, shownEmpty: false })).toMatchObject({ kind: 'live', shownEmpty: false });
        });
    });

    describe('a malformed body', () => {
        it.each([null, 5, 'x', [], {}])('refuses %p as having no badge id', (body) => {
            expect(refusal(body)).toBe('A valid numeric personId is required.');
        });

        it.each([2147483648, 1.5, 0, -1, '123'])('refuses participantId %p', (participantId) => {
            expect(refusal({ participantId })).toBe('A valid numeric personId is required.');
        });

        it('refuses ids that disagree', () => {
            expect(refusal({ personId: 7, participantId: 8 })).toBe('personId and participantId disagree.');
        });

        it('checks the badge id before the replay flag\'s type', () => {
            expect(refusal({ replay: 'true' })).toBe('A valid numeric personId is required.');
        });

        it.each([
            [{ replay: 'true' }, 'replay must be a boolean.'],
            [{ dead: 1 }, 'dead must be a boolean.'],
            [{ dead: true, replay: true }, 'dead and replay are mutually exclusive.'],
            [{ dead: true, scannedAt: at }, 'A dead-lettered scan requires clientEventId.'],
            [{ dead: true, clientEventId: 'e1' }, 'A dead-lettered scan requires a valid scannedAt.'],
            [{ dead: true, clientEventId: 'e1', scannedAt: at, intent: 'SIDEWAYS' }, 'intent must be IN or OUT.'],
            [{ intent: 'SIDEWAYS' }, 'intent must be IN or OUT.'],
            [{ close: 'later' }, 'close must be alone or confirmed.'],
            [{ close: 'alone', intent: 'IN' }, 'A close is a checkout; intent must be OUT.'],
            [{ shownEmpty: true, intent: 'IN' }, 'A close is a checkout; intent must be OUT.'],
            [{ rosterAsOf: 'soon' }, 'rosterAsOf must be a timestamp.'],
            [{ scanTimeUncertaintyMs: -1 }, 'scanTimeUncertaintyMs must be a non-negative number.'],
            [{ scanTimeUncertaintyMs: '5' }, 'scanTimeUncertaintyMs must be a non-negative number.'],
            [{ clockSuspect: 'yes' }, 'clockSuspect must be a boolean.'],
            [{ shownEmpty: 'no' }, 'shownEmpty must be a boolean.'],
            [{ protocolVersion: 0 }, 'protocolVersion must be a positive integer.'],
            [{ protocolVersion: 2.5 }, 'protocolVersion must be a positive integer.'],
        ])('refuses %p with its message', (overrides, error) => {
            expect(refusal({ personId: 7, ...overrides })).toBe(error);
        });

        it('reports the first broken rule only', () => {
            expect(refusal({ personId: 7, intent: 'SIDEWAYS', protocolVersion: 0 })).toBe('intent must be IN or OUT.');
        });
    });
});
