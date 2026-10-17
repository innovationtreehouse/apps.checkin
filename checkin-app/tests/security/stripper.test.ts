/**
 * Unit tests for the policy stripper — the function that decides whether
 * each field in a response reaches the wire.
 *
 * Pure unit tests: no DB, no auth, no HTTP. Synthetic CallerContexts and
 * synthetic bags. Catches regressions in fieldVisible, scopesHeld, and
 * stripValue that integration tests (which exercise correctly-written
 * handlers) won't notice.
 */
import { stripValue, stripBag } from '@/security/stripper';
import { scopesHeld, type CallerContext } from '@/security/access-resolvers';
import { fieldVisible } from '@/security/core';

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

// Silence the "unknown model" warn from the stripper in the one test that
// exercises that path.
let warnSpy: jest.SpyInstance;
beforeAll(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
    warnSpy.mockRestore();
});

// ─── fieldVisible (token-grammar primitive) ────────────────────────────────

describe('fieldVisible', () => {
    it('secret is never visible', () => {
        expect(fieldVisible('secret', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'public'], new Set(['everyones']))).toBe(false);
    });

    it('public visible iff "public" token granted', () => {
        const scopes = new Set(['everyones'] as const);
        expect(fieldVisible('public', ['public'], scopes)).toBe(true);
        expect(fieldVisible('public', ['everyones:pii'], scopes)).toBe(false);
    });

    it('everyones:tier grants unconditionally (no caller scope needed)', () => {
        expect(fieldVisible('pii', ['everyones:pii'], new Set(['everyones']))).toBe(true);
    });

    it('scope:tier grants only when caller holds the scope', () => {
        expect(fieldVisible('pii', ['their_own:pii'], new Set(['everyones', 'their_own']))).toBe(true);
        expect(fieldVisible('pii', ['their_own:pii'], new Set(['everyones']))).toBe(false);
    });

    it('tier in token must match tier of field', () => {
        // view grants pii but field is personal → no.
        expect(fieldVisible('personal', ['their_own:pii'], new Set(['everyones', 'their_own']))).toBe(false);
    });
});

// ─── scopesHeld (per-row scope predicate) ──────────────────────────────────

describe('scopesHeld', () => {
    it('always includes everyones', () => {
        expect(scopesHeld('Tool', { id: 1 }, ctx())).toEqual(new Set(['everyones']));
    });

    it('Person.their_own when row.id === caller.selfId', () => {
        const s = scopesHeld('Person', { id: 5 }, ctx({ selfId: 5 }));
        expect(s.has('their_own')).toBe(true);
    });

    it('Person.their_own NOT held when row.id !== caller.selfId', () => {
        const s = scopesHeld('Person', { id: 7 }, ctx({ selfId: 5 }));
        expect(s.has('their_own')).toBe(false);
    });

    it('Person.their_households when householdIds match', () => {
        const s = scopesHeld('Person', { id: 9, householdId: 2 }, ctx({ selfId: 5, householdId: 2 }));
        expect(s.has('their_households')).toBe(true);
    });

    it('Person.their_program_participants when row.id in scope-programs set', () => {
        const s = scopesHeld(
            'Person',
            { id: 9 },
            ctx({ selfId: 5, participantIdsInScopePrograms: new Set([9, 10]) }),
        );
        expect(s.has('their_program_participants')).toBe(true);
    });

    it('Person.all_current_visitors requires isKeyholder AND row in active set', () => {
        const ctxWithKey = ctx({ isKeyholder: true, activeVisitorIds: new Set([9]) });
        expect(scopesHeld('Person', { id: 9 }, ctxWithKey).has('all_current_visitors')).toBe(true);
        expect(scopesHeld('Person', { id: 99 }, ctxWithKey).has('all_current_visitors')).toBe(false);

        const ctxNoKey = ctx({ isKeyholder: false, activeVisitorIds: new Set([9]) });
        expect(scopesHeld('Person', { id: 9 }, ctxNoKey).has('all_current_visitors')).toBe(false);
    });

    it('Visit.their_own when row.personId === selfId', () => {
        expect(scopesHeld('Visit', { personId: 5, departedAt: null }, ctx({ selfId: 5 })).has('their_own')).toBe(true);
    });

    it('Visit.all_current_visitors requires isKeyholder AND departedAt === null', () => {
        const keyCtx = ctx({ isKeyholder: true });
        expect(scopesHeld('Visit', { participantId: 7, departedAt: null }, keyCtx).has('all_current_visitors')).toBe(true);
        expect(scopesHeld('Visit', { participantId: 7, departedAt: new Date() }, keyCtx).has('all_current_visitors')).toBe(false);
        expect(scopesHeld('Visit', { participantId: 7, departedAt: null }, ctx()).has('all_current_visitors')).toBe(false);
    });

    it('Household.their_households when row.id === caller.householdId', () => {
        expect(scopesHeld('Household', { id: 2 }, ctx({ householdId: 2 })).has('their_households')).toBe(true);
        expect(scopesHeld('Household', { id: 99 }, ctx({ householdId: 2 })).has('their_households')).toBe(false);
    });

    it('Program.their_program_participants when caller leads or coreVols it', () => {
        const led = ctx({ programsLed: new Set([10]) });
        expect(scopesHeld('Program', { id: 10 }, led).has('their_program_participants')).toBe(true);
        const core = ctx({ programsCoreVolIn: new Set([10]) });
        expect(scopesHeld('Program', { id: 10 }, core).has('their_program_participants')).toBe(true);
        expect(scopesHeld('Program', { id: 99 }, led).has('their_program_participants')).toBe(false);
    });

    it('returns only everyones for unknown / unsupported models', () => {
        expect(scopesHeld('ToolUnknownXYZ', { id: 1 }, ctx({ selfId: 1 }))).toEqual(new Set(['everyones']));
    });
});

// ─── stripValue (the contributor-handler scenario) ─────────────────────────

describe('stripValue — Person', () => {
    const callerCtx = ctx({ selfId: 5 });
    const tokens = ['their_own:pii', 'their_own:personal', 'public'] as const;

    it('exposes pii on self row', () => {
        const row = { id: 5, name: 'Me', email: 'me@x.com', phone: '555' };
        const out = stripValue('Person', row, tokens, callerCtx);
        expect(out).toEqual({ id: 5, name: 'Me', email: 'me@x.com', phone: '555' });
    });

    it('strips pii on non-self row (THE buggy-handler case)', () => {
        // Simulates a contributor handler that fetched the wrong row.
        const row = { id: 7, name: 'Other', email: 'leaked@x.com', phone: '555' };
        const out = stripValue('Person', row, tokens, callerCtx) as Record<string, unknown>;
        expect(out.id).toBe(7);
        expect(out.name).toBe('Other');
        expect(out.email).toBeUndefined();
        expect(out.phone).toBeUndefined();
    });

    it('public-only view strips even name without "public" token', () => {
        const row = { id: 5, name: 'Me' };
        const out = stripValue('Person', row, ['their_own:pii'], callerCtx) as Record<string, unknown>;
        expect(out.id).toBeUndefined();
        expect(out.name).toBeUndefined();
    });

    it('everyones:pii exposes pii on every row regardless of caller', () => {
        const stranger = ctx(); // no selfId
        const row = { id: 99, name: 'X', email: 'x@x.com' };
        const out = stripValue('Person', row, ['everyones:pii', 'public'], stranger) as Record<string, unknown>;
        expect(out.email).toBe('x@x.com');
    });

    it('honours OR semantics: a field needs only one matching scope grant', () => {
        // Caller leads program 10; row 9 is a participant of program 10.
        const leadCtx = ctx({ selfId: 5, programsLed: new Set([10]), participantIdsInScopePrograms: new Set([9]) });
        const row = { id: 9, name: 'P', email: 'p@x.com' };
        // View only grants the program-scoped pii, not their_own.
        const out = stripValue('Person', row, ['their_program_participants:pii', 'public'], leadCtx) as Record<string, unknown>;
        expect(out.email).toBe('p@x.com');
        // Same view but a row outside the program — email stripped.
        const outsider = { id: 999, name: 'Q', email: 'q@x.com' };
        const out2 = stripValue('Person', outsider, ['their_program_participants:pii', 'public'], leadCtx) as Record<string, unknown>;
        expect(out2.email).toBeUndefined();
    });

    it('their_households grants household members on self/household rows', () => {
        const homeCtx = ctx({ selfId: 5, householdId: 2 });
        const sibling = { id: 6, name: 'Sib', householdId: 2, notificationSettings: { emailNewsletter: true } };
        const out = stripValue('Person', sibling, ['their_households:personal', 'public'], homeCtx) as Record<string, unknown>;
        expect(out.notificationSettings).toEqual({ emailNewsletter: true });
        const stranger = { id: 7, name: 'X', householdId: 99, notificationSettings: { emailNewsletter: true } };
        const out2 = stripValue('Person', stranger, ['their_households:personal', 'public'], homeCtx) as Record<string, unknown>;
        expect(out2.notificationSettings).toBeUndefined();
    });
});

describe('stripValue — secret tier is unreachable', () => {
    it('everyones:internal does NOT expose secret', () => {
        const row = { id: 'acc1', userId: 5, type: 'oauth', provider: 'google', providerAccountId: 'g123', refresh_token: 'rt', access_token: 'at', id_token: 'idt' };
        const tokens = ['everyones:pii', 'everyones:personal', 'everyones:internal', 'public'] as const;
        const out = stripValue('Account', row, tokens, ctx({ selfId: 5 })) as Record<string, unknown>;
        expect(out.userId).toBe(5);
        expect(out.refresh_token).toBeUndefined();
        expect(out.access_token).toBeUndefined();
        expect(out.id_token).toBeUndefined();
    });
});

describe('stripValue — arrays', () => {
    it('applies per-row scopes independently', () => {
        const callerCtx = ctx({ selfId: 5 });
        const tokens = ['their_own:pii', 'public'] as const;
        const rows = [
            { id: 5, name: 'me', email: 'me@x.com' },
            { id: 7, name: 'them', email: 'them@x.com' },
        ];
        const out = stripValue('Person', rows, tokens, callerCtx) as Record<string, unknown>[];
        expect(out[0].email).toBe('me@x.com');
        expect(out[1].email).toBeUndefined();
        expect(out[1].name).toBe('them');
    });
});

describe('stripValue — nested relations', () => {
    it('recursively strips household relation on a Person', () => {
        const callerCtx = ctx({ selfId: 5, householdId: 2 });
        const tokens = ['their_own:pii', 'public'] as const; // no household:personal granted
        const row = {
            id: 5,
            name: 'Me',
            email: 'me@x.com',
            household: { id: 2, name: 'Home', line1: 'private street' },
        };
        const out = stripValue('Person', row, tokens, callerCtx) as Record<string, unknown>;
        expect(out.email).toBe('me@x.com');
        const household = out.household as Record<string, unknown>;
        expect(household.id).toBe(2);
        expect(household.name).toBe('Home');
        expect(household.line1).toBeUndefined(); // internal — no token grants it
    });

    it('grants household.line1 when their_households:internal is in the view', () => {
        const callerCtx = ctx({ selfId: 5, householdId: 2 });
        const tokens = ['their_own:pii', 'their_households:internal', 'public'] as const;
        const row = {
            id: 5,
            email: 'me@x.com',
            household: { id: 2, name: 'Home', line1: 'private street' },
        };
        const out = stripValue('Person', row, tokens, callerCtx) as Record<string, unknown>;
        const household = out.household as Record<string, unknown>;
        expect(household.line1).toBe('private street');
    });
});

describe('scopesHeld — row-scoped fail-closed', () => {
    it('EmergencyContact.their_households when row.householdId === caller.householdId', () => {
        const s = scopesHeld('EmergencyContact', { id: 1, householdId: 2 }, ctx({ householdId: 2 }));
        expect(s.has('their_households')).toBe(true);
        const s2 = scopesHeld('EmergencyContact', { id: 1, householdId: 99 }, ctx({ householdId: 2 }));
        expect(s2.has('their_households')).toBe(false);
        expect(s2.has('everyones')).toBe(true); // key present, just not the caller's household
    });

    it('EmergencyContact missing its scope key yields NO scopes (not even everyones)', () => {
        // Nested row where householdId was not selected → cannot prove relationship.
        const s = scopesHeld('EmergencyContact', { id: 1, name: 'X' }, ctx({ householdId: 2 }));
        expect(s).toEqual(new Set());
    });
});

describe('stripValue — nested EmergencyContact (the leak)', () => {
    const ec = (householdId: number | undefined) => ({
        id: 1,
        householdId,
        name: 'Aunt May',
        phone: '555-1234',
        priority: 1,
        createdAt: '2026-01-01',
    });

    it('(a) non-admin their_households view shows only allowed fields on own household EC', () => {
        const homeCtx = ctx({ selfId: 5, householdId: 2 });
        const tokens = ['their_households:personal', 'public'] as const;
        const household = { id: 2, name: 'Home', emergencyContacts: [ec(2)] };
        const out = stripValue('Household', household, tokens, homeCtx) as Record<string, unknown>;
        const got = (out.emergencyContacts as Record<string, unknown>[])[0];
        expect(got.name).toBe('Aunt May'); // personal, granted via their_households
        expect(got.phone).toBe('555-1234');
        expect(got.priority).toBe(1); // public
        expect(got.createdAt).toBeUndefined(); // internal — not granted
    });

    it('(a) same view strips personal on another household’s EC', () => {
        const homeCtx = ctx({ selfId: 5, householdId: 2 });
        const tokens = ['their_households:personal', 'public'] as const;
        const household = { id: 99, name: 'Other', emergencyContacts: [ec(99)] };
        const out = stripValue('Household', household, tokens, homeCtx) as Record<string, unknown>;
        const got = (out.emergencyContacts as Record<string, unknown>[])[0];
        expect(got.name).toBeUndefined();
        expect(got.phone).toBeUndefined();
        expect(got.priority).toBe(1); // public still shows
    });

    it('(b) everyones:* view does NOT leak personal/internal on a key-less nested EC', () => {
        // Admin/board view; the nested EC row omitted householdId. Must fail closed.
        const adminCtx = ctx({ selfId: 1 });
        const tokens = ['everyones:pii', 'everyones:personal', 'everyones:internal', 'public'] as const;
        const household = {
            id: 2,
            name: 'Home',
            emergencyContacts: [{ id: 1, name: 'Aunt May', phone: '555-1234', priority: 1, createdAt: '2026-01-01' }],
        };
        const out = stripValue('Household', household, tokens, adminCtx) as Record<string, unknown>;
        const got = (out.emergencyContacts as Record<string, unknown>[])[0];
        expect(got.name).toBeUndefined(); // personal — stripped despite everyones:personal
        expect(got.phone).toBeUndefined();
        expect(got.createdAt).toBeUndefined(); // internal — stripped despite everyones:internal
        expect(got.priority).toBe(1); // public — unaffected
        expect(got.id).toBe(1);
    });

    it('everyones:* view DOES show fields when the key is present (admin intent preserved)', () => {
        const adminCtx = ctx({ selfId: 1 });
        const tokens = ['everyones:personal', 'everyones:internal', 'public'] as const;
        const household = { id: 2, name: 'Home', emergencyContacts: [ec(2)] };
        const out = stripValue('Household', household, tokens, adminCtx) as Record<string, unknown>;
        const got = (out.emergencyContacts as Record<string, unknown>[])[0];
        expect(got.name).toBe('Aunt May');
        expect(got.createdAt).toBe('2026-01-01');
    });
});

describe('stripValue — _count gating', () => {
    it('preserves _count for a relation the view can see (Visit has a public field)', () => {
        const row = { id: 5, name: 'Me', _count: { visits: 3 } };
        const out = stripValue('Person', row, ['public'], ctx({ selfId: 5 })) as Record<string, unknown>;
        expect(out._count).toEqual({ visits: 3 });
    });

    it('strips a _count the low-privilege view has no grant on', () => {
        // RawBadgeLog has no public field — its fields are personal/internal.
        // A view with only `public` cannot see any RawBadgeLog field, so the
        // count of a Person's rawBadgeLogs must not leak.
        const row = { id: 5, name: 'Me', _count: { rawBadgeLogs: 9 } };
        const out = stripValue('Person', row, ['public'], ctx({ selfId: 5 })) as Record<string, unknown>;
        expect(out._count).toBeUndefined();
    });

    it('passes that same _count to an authorized view', () => {
        // `their_own:personal` on the caller's own row grants RawBadgeLog's
        // personal-tier fields (time/location), so the count is now visible.
        const row = { id: 5, name: 'Me', _count: { rawBadgeLogs: 9 } };
        const out = stripValue('Person', row, ['their_own:personal', 'public'], ctx({ selfId: 5 })) as Record<string, unknown>;
        expect(out._count).toEqual({ rawBadgeLogs: 9 });
    });

    it('strips only the ungranted keys from a mixed _count', () => {
        const row = { id: 5, name: 'Me', _count: { visits: 3, rawBadgeLogs: 9 } };
        const out = stripValue('Person', row, ['public'], ctx({ selfId: 5 })) as Record<string, unknown>;
        expect(out._count).toEqual({ visits: 3 });
    });

    it('drops unknown relation keys (fail-closed)', () => {
        const row = { id: 5, name: 'Me', _count: { notARelation: 7 } };
        const out = stripValue('Person', row, ['public'], ctx({ selfId: 5 })) as Record<string, unknown>;
        expect(out._count).toBeUndefined();
    });
});

describe('stripValue — edge cases', () => {
    it('null and undefined pass through unchanged', () => {
        expect(stripValue('Person', null, ['public'], ctx())).toBeNull();
        expect(stripValue('Person', undefined, ['public'], ctx())).toBeUndefined();
    });

    it('empty tokens strip everything to an empty object', () => {
        const row = { id: 5, name: 'Me', email: 'me@x.com' };
        const out = stripValue('Person', row, [], ctx({ selfId: 5 })) as Record<string, unknown>;
        expect(out).toEqual({});
    });

    it('returns null for unknown model', () => {
        const out = stripValue('NotARealModelXYZ', { foo: 'bar' }, ['public'], ctx());
        expect(out).toBeNull();
    });
});

// ─── stripBag (the top-level wrapper) ──────────────────────────────────────

describe('stripBag', () => {
    it('drops unknown-model bag entries with a warn', () => {
        const out = stripBag({ Person: { id: 5, name: 'Me' }, NotAModel: { foo: 'bar' } }, ['public'], ctx({ selfId: 5 }));
        expect(out.Person).toEqual({ id: 5, name: 'Me' });
        expect(out.NotAModel).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'NotAModel'"));
    });

    it('strips each known model with the same tokens/context', () => {
        const out = stripBag(
            {
                Person: { id: 5, name: 'Me', email: 'me@x.com' },
                Household: { id: 2, name: 'Home', line1: 'street' },
            },
            ['their_own:pii', 'their_households:internal', 'public'],
            ctx({ selfId: 5, householdId: 2 }),
        );
        expect((out.Person as Record<string, unknown>).email).toBe('me@x.com');
        expect((out.Household as Record<string, unknown>).line1).toBe('street');
    });
});

// ─── Event roster (GET /api/events/[id] policy shape) ──────────────────────
// The route is FAIL-CLOSED, staff-only (admission gated in the handler fn), so
// the only views that reach the stripper are the staff tiers. These cover the
// staff field-tiering (defense-in-depth) AND pin the reason admission must be
// gated: per-field stripping CANNOT hide the "who attends" roster, because a
// participant's name is tier 'public'. The route's view carries
// their_program_participants tokens, granted per-row only on a program the
// caller leads/core-vols (admin gets everyones:* via its own view).

describe('Event roster strip (events/[id] view)', () => {
    // The exact token grant the 'authenticated' role gets in registry.ts.
    const EVENTS_VIEW = [
        'their_program_participants:pii',
        'their_program_participants:personal',
        'their_program_participants:internal',
        'their_own:pii',
        'their_own:personal',
        'member',
        'public',
    ] as const;

    const PROGRAM_ID = 77;
    const ROSTER_ID = 501; // a participant enrolled in the program

    // Event bag shaped like the route's Prisma include.
    const eventBag = () => ({
        id: 9,
        programId: PROGRAM_ID,
        name: 'Build Night',
        attendanceConfirmedAt: new Date('2026-01-01'), // internal tier
        program: {
            id: PROGRAM_ID,
            name: 'Robotics',
            participants: [
                {
                    programId: PROGRAM_ID,
                    personId: ROSTER_ID,
                    person: {
                        id: ROSTER_ID,
                        name: 'Youth Kid',     // public
                        email: 'kid@x.com',    // pii
                        phone: '555-0100',     // pii
                        dateOfBirth: '2012-05-01', // personal
                        allergies: 'peanuts',  // personal
                    },
                },
            ],
        },
    });

    function roster(out: unknown): Record<string, unknown> {
        const program = (out as Record<string, unknown>).program as Record<string, unknown>;
        const participants = program.participants as Array<Record<string, unknown>>;
        return participants[0].person as Record<string, unknown>;
    }

    it('lead mentor of the event\'s program sees roster pii/personal + internal', () => {
        const leadCtx = ctx({
            selfId: 1,
            programsLed: new Set([PROGRAM_ID]),
            participantIdsInScopePrograms: new Set([ROSTER_ID]),
        });
        const out = stripValue('Event', eventBag(), EVENTS_VIEW, leadCtx);
        const kid = roster(out);
        expect(kid.email).toBe('kid@x.com');
        expect(kid.phone).toBe('555-0100');
        expect(kid.dateOfBirth).toBe('2012-05-01');
        expect(kid.allergies).toBe('peanuts');
        // internal Event field reaches this event's staff (UI renders it).
        expect((out as Record<string, unknown>).attendanceConfirmedAt).toBeInstanceOf(Date);
    });

    // WHY the route gates admission instead of relying on stripping: a non-staff
    // scope strips email/phone (pii) and dob/allergies (personal) — but the
    // participant's NAME is tier 'public', so it survives. Stripping alone would still leak the full
    // attendee roster. This asserts that leak exists, documenting the reason the
    // handler fn 403s non-staff before the roster is ever returned.
    it('stripping alone leaves the roster name (tier public) — hence the fail-closed admission gate', () => {
        const strangerCtx = ctx({ selfId: 999 }); // leads nothing, not on roster
        const out = stripValue('Event', eventBag(), EVENTS_VIEW, strangerCtx);
        const kid = roster(out);
        expect(kid.email).toBeUndefined();      // pii stripped
        expect(kid.dateOfBirth).toBeUndefined();
        expect(kid.name).toBe('Youth Kid');     // but name (public) survives → the leak
    });
});
