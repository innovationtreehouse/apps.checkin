/**
 * @jest-environment node
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { specTrace, startSpecTrace, traceOnCommit } from '../specTrace';

// process.env.NODE_ENV is typed read-only; tests need to vary it at runtime
const setNodeEnv = (value: string | undefined) => {
    Object.defineProperty(process.env, 'NODE_ENV', { value, configurable: true });
};

describe('specTrace', () => {
    let dir: string;
    let file: string;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCheckinEnv = process.env.CHECKIN_ENV;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'spec-trace-'));
        file = join(dir, 'trace.ndjson');
    });

    afterEach(() => {
        startSpecTrace(null);
        setNodeEnv(originalNodeEnv);
        process.env.CHECKIN_ENV = originalCheckinEnv;
        rmSync(dir, { recursive: true, force: true });
    });

    it('writes one tagged NDJSON line per event once a test starts it, off production', () => {
        startSpecTrace(file);
        specTrace('ScanCommit', { p: 1, kind: 'checkin' });
        const [line] = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(line).toMatchObject({ tag: 'trace', event: { name: 'ScanCommit', p: 1, kind: 'checkin' } });
    });

    it('writes nothing until started', () => {
        specTrace('ScanCommit', { p: 1 });
        expect(existsSync(file)).toBe(false);
    });

    it.each([
        ['CHECKIN_ENV unset', undefined],
        ['CHECKIN_ENV=prod', 'prod'],
    ])('is a no-op with NODE_ENV=production and %s, even when started', (_label, checkinEnv) => {
        setNodeEnv('production');
        if (checkinEnv === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = checkinEnv;
        startSpecTrace(file);
        specTrace('ScanCommit', { p: 1 });
        expect(existsSync(file)).toBe(false);
    });

    describe('traceOnCommit', () => {
        const names = () => existsSync(file)
            ? readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l).event.name)
            : [];

        it('writes the held lines once the transaction commits', async () => {
            startSpecTrace(file);
            await traceOnCommit(async () => {
                specTrace('VisitOpen', { p: 1 });
                expect(names()).toEqual([]);
            });
            expect(names()).toEqual(['VisitOpen']);
        });

        it('drops the held lines when the transaction rolls back', async () => {
            startSpecTrace(file);
            await expect(traceOnCommit(async () => {
                specTrace('VisitDepart', { p: 1 });
                throw new Error('rollback');
            })).rejects.toThrow('rollback');
            expect(names()).toEqual([]);
        });

        it('hands an inner scope\'s lines to the outer one, written only when the outer commits', async () => {
            startSpecTrace(file);
            await traceOnCommit(async () => {
                specTrace('CloseExecuted', { n: 1 });
                await traceOnCommit(async () => specTrace('VisitDepart', { p: 1 }));
                expect(names()).toEqual([]);
            });
            expect(names()).toEqual(['CloseExecuted', 'VisitDepart']);
        });

        it('drops an inner scope\'s committed lines when the outer one rolls back', async () => {
            startSpecTrace(file);
            await expect(traceOnCommit(async () => {
                await traceOnCommit(async () => specTrace('VisitDepart', { p: 1 }));
                throw new Error('rollback');
            })).rejects.toThrow('rollback');
            expect(names()).toEqual([]);
        });
    });
});
