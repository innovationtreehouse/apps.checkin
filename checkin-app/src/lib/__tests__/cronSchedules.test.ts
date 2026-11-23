/**
 * @jest-environment node
 */
import { readdirSync } from 'fs';
import path from 'path';
import { awsCronToCroner, CRON_ROUTES, cronScheduleNotices, lastDueAt, readCronSchedules } from '@/lib/cronSchedules';

// Thursday 2026-08-06, 12:00 UTC.
const NOW = new Date('2026-08-06T12:00:00.000Z');

/** The schedules infra passes to dev and prod. */
const INFRA_EXPRESSIONS = [
    'cron(15 9 * * ? *)',
    'cron(30 9 * * ? *)',
    'cron(45 9 * * ? *)',
    'cron(16 9 * * ? *)',
    'cron(0 13 * * ? *)',
    'cron(15 13 * * ? *)',
    'cron(30 13 * * ? *)',
    'cron(1 13 * * ? *)',
    'cron(50 22 * * ? *)',
];

const list = (...entries: { job: string; schedule: string; timezone: string }[]) => JSON.stringify(entries);
const utc = (job: string, schedule = 'cron(0 9 * * ? *)') => ({ job, schedule, timezone: 'UTC' });
const allRoutes = () => CRON_ROUTES.map((job) => utc(job));

describe('CRON_ROUTES', () => {
    it('names exactly the route directories under src/app/api/cron', () => {
        const dir = path.join(__dirname, '../../app/api/cron');
        const routes = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
        expect([...CRON_ROUTES].sort()).toEqual(routes);
    });
});

describe('awsCronToCroner', () => {
    it.each(INFRA_EXPRESSIONS)('reads %s as a seven-field pattern with zero seconds', (expression) => {
        const fields = expression.slice('cron('.length, -1);
        expect(awsCronToCroner(expression)).toBe(`0 ${fields}`);
    });

    it('rejects an expression that is not cron(...)', () => {
        expect(() => awsCronToCroner('rate(1 day)')).toThrow('not a cron(...) expression');
    });

    it('rejects a five-field expression', () => {
        expect(() => awsCronToCroner('cron(0 9 * * ?)')).toThrow('has 5 fields, not 6');
    });
});

describe('lastDueAt', () => {
    it.each(INFRA_EXPRESSIONS.filter((e) => e !== 'cron(50 22 * * ? *)'))('finds the latest UTC due time of %s', (expression) => {
        const [minute, hour] = expression.slice('cron('.length).split(' ').map(Number);
        const today = new Date(Date.UTC(2026, 7, 6, hour, minute));
        const expected = today <= NOW ? today : new Date(today.getTime() - 24 * 60 * 60 * 1000);
        expect(lastDueAt({ schedule: expression, timezone: 'UTC' }, NOW)).toEqual(expected);
    });

    it('reads the nightly Chicago schedule in Chicago time on both sides of daylight saving', () => {
        const nightly = { schedule: 'cron(50 22 * * ? *)', timezone: 'America/Chicago' };
        expect(lastDueAt(nightly, NOW)).toEqual(new Date('2026-08-06T03:50:00.000Z'));
        expect(lastDueAt(nightly, new Date('2026-12-01T12:00:00.000Z'))).toEqual(new Date('2026-12-01T04:50:00.000Z'));
    });

    it('numbers weekdays as AWS does, 1 for Sunday', () => {
        expect(lastDueAt({ schedule: 'cron(0 9 ? * 2 *)', timezone: 'UTC' }, NOW)).toEqual(new Date('2026-08-03T09:00:00.000Z'));
        expect(lastDueAt({ schedule: 'cron(0 9 ? * 1 *)', timezone: 'UTC' }, NOW)).toEqual(new Date('2026-08-02T09:00:00.000Z'));
    });

    it('honours the year field', () => {
        expect(lastDueAt({ schedule: 'cron(0 9 1 1 ? 2025)', timezone: 'UTC' }, NOW)).toEqual(new Date('2025-01-01T09:00:00.000Z'));
        expect(lastDueAt({ schedule: 'cron(0 9 * * ? 2030)', timezone: 'UTC' }, NOW)).toBeNull();
    });
});

describe('readCronSchedules', () => {
    it('is unset when the variable is absent or blank', () => {
        expect(readCronSchedules(undefined)).toEqual({ kind: 'unset' });
        expect(readCronSchedules('  ')).toEqual({ kind: 'unset' });
    });

    it('reads the list infra passes', () => {
        const raw = list(utc('reconcile-shopify', 'cron(0 13 * * ? *)'), { job: 'nightly', schedule: 'cron(50 22 * * ? *)', timezone: 'America/Chicago' });
        expect(readCronSchedules(raw)).toEqual({ kind: 'ok', schedules: JSON.parse(raw) });
    });

    it.each([
        ['not JSON', '{oops', 'it is not JSON'],
        ['not a list', '{"job":"nightly"}', 'it is not a list'],
        ['an entry with no job', list({ job: '', schedule: 'cron(0 9 * * ? *)', timezone: 'UTC' }), 'entry 1 has no job'],
        ['an entry with no timezone', '[{"job":"nightly","schedule":"cron(0 9 * * ? *)"}]', 'nightly needs a schedule and a timezone'],
        ['a rate expression', list(utc('nightly', 'rate(1 day)')), 'nightly: "rate(1 day)" is not a cron(...) expression'],
        ['an unknown timezone', list({ job: 'nightly', schedule: 'cron(0 9 * * ? *)', timezone: 'Mars/Olympus' }), 'nightly:'],
        ['a job listed twice', list(utc('nightly'), utc('nightly')), 'nightly is listed twice'],
    ])('is malformed when it is %s', (_case, raw, reason) => {
        const source = readCronSchedules(raw);
        expect(source.kind).toBe('malformed');
        expect(source.kind === 'malformed' && source.reason).toContain(reason);
    });
});

describe('cronScheduleNotices', () => {
    it('says nothing while the variable is unset', () => {
        expect(cronScheduleNotices({ kind: 'unset' })).toEqual([]);
    });

    it('says the list cannot be read, and nothing else, when it is malformed', () => {
        expect(cronScheduleNotices({ kind: 'malformed', reason: 'it is not JSON' })).toEqual([
            "The scheduled-job list (CRON_SCHEDULES) can't be read: it is not JSON. No job is judged late.",
        ]);
    });

    it('says nothing when every route has a schedule and every schedule a route', () => {
        expect(cronScheduleNotices({ kind: 'ok', schedules: allRoutes() })).toEqual([]);
    });

    it('lists a route with no schedule', () => {
        const schedules = allRoutes().filter((s) => s.job !== 'post-event');
        expect(cronScheduleNotices({ kind: 'ok', schedules })).toEqual(['Scheduled job post-event: has a route but no schedule']);
    });

    it('lists a schedule with no route', () => {
        const schedules = [...allRoutes(), utc('person-bg-annual')];
        expect(cronScheduleNotices({ kind: 'ok', schedules })).toEqual(['Scheduled job person-bg-annual: has a schedule but no route']);
    });
});
