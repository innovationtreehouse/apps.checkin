/**
 * @jest-environment node
 */
// The session page (GET /api/events/[id]) gives program staff the roster and the
// two staff-only fields it renders, and nothing internal: a program leader sees
// whether a place is paid, never how (docs/rules/programs.md, Access to program
// information). View tokens come from the live registry, so these pins track
// policy edits.
import { stripValue } from '@/security/stripper';
import { type CallerContext } from '@/security/access-resolvers';
import { getRoute, type Role, type Token } from '@/security/core';
import { classifications } from '@/security/generated/classifications';
import '@/security/registry';

const EVENT_PAGE = 'GET /api/events/[id]';
const PROGRAM_ID = 7;
const EVENT_ID = 9;
const LEAD_ID = 1;
const CORE_ID = 2;
const KID_ID = 501;

function ctx(opts: Partial<CallerContext> = {}): CallerContext {
    return {
        selfId: undefined,
        householdId: undefined,
        isKeyholder: false,
        isKiosk: false,
        programsLed: new Set(),
        programsCoreVolIn: new Set(),
        participantIdsInScopePrograms: new Set(),
        householdIdsInScopePrograms: new Set(),
        eventIdsInScopePrograms: new Set(),
        activeVisitorIds: new Set(),
        ledHouseholdMemberIds: new Set(),
        ...opts,
    };
}

function tokensFor(role: Role): readonly Token[] {
    const spec = getRoute(EVENT_PAGE);
    if (!spec) throw new Error(`no registry entry for ${EVENT_PAGE}`);
    const entry = spec.orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`no orderedView entry for ${role} on ${EVENT_PAGE}`);
    return entry[1];
}

function internalFields(model: keyof typeof classifications): string[] {
    return Object.entries(classifications[model])
        .filter(([, tier]) => tier === 'internal')
        .map(([field]) => field);
}

const PARTICIPANT_INTERNAL = internalFields('ProgramParticipant');
const PERSON_INTERNAL = internalFields('Person');

// Every internal column filled in, so a grant that reaches any of them shows.
function withInternal(fields: string[], base: Record<string, unknown>): Record<string, unknown> {
    const row: Record<string, unknown> = { ...base };
    for (const f of fields) row[f] = `internal:${f}`;
    return row;
}

const person = (id: number, name: string) =>
    withInternal(PERSON_INTERNAL, { id, name, email: `${id}@x.com`, dateOfBirth: '2012-05-01' });

// Shaped like the route's select, with every internal ProgramParticipant and
// Person column added on top.
const eventBag = () => ({
    id: EVENT_ID,
    programId: PROGRAM_ID,
    name: 'Build Night',
    attendanceConfirmedAt: '2026-01-01T00:00:00.000Z',
    program: {
        id: PROGRAM_ID,
        name: 'Robotics',
        leadMentorId: LEAD_ID,
        volunteers: [
            { programId: PROGRAM_ID, personId: CORE_ID, isCore: true, person: person(CORE_ID, 'Core Vol') },
        ],
        participants: [
            withInternal(PARTICIPANT_INTERNAL, {
                programId: PROGRAM_ID,
                personId: KID_ID,
                status: 'PENDING',
                person: person(KID_ID, 'Youth Kid'),
            }),
        ],
    },
});

type Row = Record<string, unknown>;
function parts(out: unknown) {
    const program = (out as Row).program as Row;
    const volunteer = (program.volunteers as Row[])[0];
    const participant = (program.participants as Row[])[0];
    return {
        event: out as Row,
        volunteer,
        volunteerPerson: volunteer.person as Row,
        participant,
        participantPerson: participant.person as Row,
    };
}

const inScope = { participantIdsInScopePrograms: new Set([KID_ID]), eventIdsInScopePrograms: new Set([EVENT_ID]) };

describe('Event page: program staff get the roster, no internal fields', () => {
    // Both reach the 'authenticated' view; the handler admits them as staff.
    it.each<[string, CallerContext]>([
        ['lead mentor', ctx({ selfId: LEAD_ID, programsLed: new Set([PROGRAM_ID]), ...inScope })],
        ['core volunteer', ctx({ selfId: CORE_ID, programsCoreVolIn: new Set([PROGRAM_ID]), ...inScope })],
    ])('%s', (_label, c) => {
        const out = parts(stripValue('Event', eventBag(), tokensFor('authenticated'), c));

        for (const f of PARTICIPANT_INTERNAL) expect(out.participant).not.toHaveProperty(f);
        for (const f of PERSON_INTERNAL) {
            expect(out.participantPerson).not.toHaveProperty(f);
            expect(out.volunteerPerson).not.toHaveProperty(f);
        }

        expect(out.event.attendanceConfirmedAt).toBe('2026-01-01T00:00:00.000Z');
        expect(out.volunteer.isCore).toBe(true);
        expect(out.participant.status).toBe('PENDING');
        expect(out.participantPerson.email).toBe(`${KID_ID}@x.com`);
        expect(out.participantPerson.dateOfBirth).toBe('2012-05-01');
    });
});

describe('Event page: the Board and sysadmins still see everything', () => {
    it.each<Role>(['isBoardMember', 'isSysadmin'])('%s', (role) => {
        const out = parts(stripValue('Event', eventBag(), tokensFor(role), ctx({ selfId: 99 })));

        for (const f of PARTICIPANT_INTERNAL) expect(out.participant[f]).toBe(`internal:${f}`);
        for (const f of PERSON_INTERNAL) {
            expect(out.participantPerson[f]).toBe(`internal:${f}`);
            expect(out.volunteerPerson[f]).toBe(`internal:${f}`);
        }
        expect(out.event.attendanceConfirmedAt).toBe('2026-01-01T00:00:00.000Z');
        expect(out.volunteer.isCore).toBe(true);
    });
});
