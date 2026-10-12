/**
 * S1 — the equivalence gate (the proof the SCOPE_BINDINGS port is behavior-neutral).
 *
 * Asserts the new data-driven resolver (`scopesHeldNext`, scopeBindings.ts) is
 * SET-EQUAL to the live imperative switch (`scopesHeld`, access-resolvers.ts)
 * for every combination of:
 *   - 8 caller personas (anonymous … sysadmin),
 *   - every model in SCOPE_BINDINGS plus unbound + unknown models,
 *   - representative rows: caller's own / another's / in-program /
 *     out-of-program / active-visit / departed-visit / missing-key / non-object.
 *
 * Pure unit test — no DB, no seed. Both resolvers are pure functions of
 * (modelName, row, ctx), and buildCallerContext (which builds the ctx from the
 * DB) is UNCHANGED by this refactor, so hand-built CallerContexts are a complete
 * and deterministic proof: if the two diverge it is the binding, not the ctx.
 *
 * On a mismatch the BINDING is wrong — fix scopeBindings.ts, never this test.
 * EXCEPTION: a binding deliberately added after the S2 snapshot (e.g. AuditLog,
 * Blocker 2) is encoded as an explicit expected delta in `expectedFromSnapshot`,
 * not by editing the frozen oracle below.
 *
 * The old switch has been deleted (S2). `referenceScopesHeld` below is a FROZEN
 * copy of it (the snapshot), so this stays a live regression guard: any future
 * change to scopeBindings.ts that diverges from the intended behavior fails here.
 *
 * DIVERGENCE FROM THE ORIGINAL SWITCH (one, deliberate): RSVP.
 * The original switch grouped RSVP with ProgramParticipant/ProgramVolunteer
 * and read `row.programId` — but RSVP has no programId column, so that grant was
 * DEAD. The resolver now grants `their_program_participants` on RSVP via
 * eventId → ctx.eventIdsInScopePrograms (§7.5 / §9 Step 3 Blocker 1). The RSVP
 * branch of this oracle encodes that NEW intended behavior, not the dead switch
 * read — so the equivalence assertion holds against the corrected resolver.
 */
import { type CallerContext } from '@/security/access-resolvers';
import { scopesHeld, SCOPE_BINDINGS } from '@/security/scopeBindings';
import type { Scope } from '@/security/core';

// ─── FROZEN reference oracle: snapshot of the deleted switch ───────────────────
// Do NOT "simplify" or sync this to scopeBindings.ts — its whole value is being
// an independent snapshot of the pre-refactor behavior. ONE deliberate edit:
// the RSVP dead read (RSVP.programId — a column that model lacks) was dropped to
// match the schema-correct binding. That is behavior-identical on every
// reachable row; see the case body below.
const ROW_SCOPE_KEY: Record<string, string> = { EmergencyContact: 'householdId' };

function referenceScopesHeld(
    modelName: string,
    row: Record<string, unknown> | null | undefined,
    ctx: CallerContext,
): Set<Scope> {
    if (!row || typeof row !== 'object') {
        return modelName in ROW_SCOPE_KEY ? new Set<Scope>() : new Set<Scope>(['everyones']);
    }
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
    const scopeKey = ROW_SCOPE_KEY[modelName];
    if (scopeKey !== undefined && num(row[scopeKey]) === undefined) {
        return new Set<Scope>();
    }
    const scopes = new Set<Scope>(['everyones']);
    switch (modelName) {
        case 'Person': {
            const id = num(row.id);
            const householdId = num(row.householdId);
            if (id !== undefined && id === ctx.selfId) scopes.add('their_own');
            if (householdId !== undefined && householdId === ctx.householdId) scopes.add('their_households');
            if (id !== undefined && ctx.participantIdsInScopePrograms.has(id)) scopes.add('their_program_participants');
            if (id !== undefined && ctx.isKeyholder && ctx.activeVisitorIds.has(id)) scopes.add('all_current_visitors');
            break;
        }
        case 'Household': {
            const id = num(row.id);
            if (id !== undefined && id === ctx.householdId) scopes.add('their_households');
            break;
        }
        case 'EmergencyContact': {
            // Post-snapshot delta (deliberate): the original switch bound only
            // their_households. their_program_households was added (mirrors
            // TrustedAdult) so a program lead/core-vol overseeing a child's
            // household sees the emergency contacts on GET /api/programs/[id].
            const householdId = num(row.householdId);
            if (householdId !== undefined && householdId === ctx.householdId) scopes.add('their_households');
            if (householdId !== undefined && ctx.householdIdsInScopePrograms.has(householdId)) scopes.add('their_program_households');
            break;
        }
        // 'HouseholdLead': model dropped in the a1 contract phase (superseded by
        // Person.isHouseholdLead). No binding, no rows, no case — gone entirely.
        case 'OrgMembership': {
            const householdId = num(row.householdId);
            if (householdId !== undefined && householdId === ctx.householdId) scopes.add('their_households');
            break;
        }
        case 'Program': {
            const id = num(row.id);
            if (id !== undefined && (ctx.programsLed.has(id) || ctx.programsCoreVolIn.has(id))) scopes.add('their_program_participants');
            break;
        }
        case 'ProgramParticipant':
        case 'ProgramVolunteer': {
            const programId = num(row.programId);
            const participantId = num(row.participantId);
            if (programId !== undefined && (ctx.programsLed.has(programId) || ctx.programsCoreVolIn.has(programId))) scopes.add('their_program_participants');
            if (participantId !== undefined && participantId === ctx.selfId) scopes.add('their_own');
            break;
        }
        // RSVP has no programId column; the program-lead grant resolves via
        // eventId → eventIdsInScopePrograms, a deliberate divergence from the
        // frozen switch's dead row.programId read (see header).
        case 'RSVP': {
            const eventId = num(row.eventId);
            const participantId = num(row.participantId);
            if (eventId !== undefined && ctx.eventIdsInScopePrograms.has(eventId)) scopes.add('their_program_participants');
            if (participantId !== undefined && participantId === ctx.selfId) scopes.add('their_own');
            break;
        }
        case 'Event': {
            const programId = num(row.programId);
            if (programId !== undefined && (ctx.programsLed.has(programId) || ctx.programsCoreVolIn.has(programId))) scopes.add('their_program_participants');
            break;
        }
        case 'Visit': {
            const personId = num(row.personId);
            if (personId !== undefined && personId === ctx.selfId) scopes.add('their_own');
            if (ctx.isKeyholder && row.departedAt == null) scopes.add('all_current_visitors');
            break;
        }
        case 'RawBadgeLog': {
            const personId = num(row.personId);
            if (personId !== undefined && personId === ctx.selfId) scopes.add('their_own');
            break;
        }
        case 'ToolStatus': {
            const personId = num(row.personId);
            if (personId !== undefined && personId === ctx.selfId) scopes.add('their_own');
            break;
        }
        case 'Account':
        case 'Session': {
            const userId = num(row.userId);
            if (userId !== undefined && userId === ctx.selfId) scopes.add('their_own');
            break;
        }
        case 'TrustedAdult':
        case 'TrustedAdultReview': {
            const householdId = num(row.householdId);
            if (householdId !== undefined && householdId === ctx.householdId) scopes.add('their_households');
            if (householdId !== undefined && ctx.householdIdsInScopePrograms.has(householdId)) scopes.add('their_program_households');
            if (ctx.isKeyholder) scopes.add('keyholders');
            break;
        }
    }
    return scopes;
}

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

const PERSONAS: Record<string, CallerContext> = {
    anonymous: ctx(),
    selfOnlyMember: ctx({ selfId: 5, householdId: 2 }),
    householdCoMember: ctx({ selfId: 6, householdId: 2 }),
    // Lead of household 2 — the only persona with a non-empty led roster, which
    // is what makes led_households strictly narrower than their_households:
    // householdCoMember above shares household 2 and holds neither.
    householdLead: ctx({
        selfId: 6,
        householdId: 2,
        ledHouseholdMemberIds: new Set([5, 6, 9]),
    }),
    programLead: ctx({
        selfId: 10,
        householdId: 4,
        programsLed: new Set([100]),
        participantIdsInScopePrograms: new Set([9, 5]),
        householdIdsInScopePrograms: new Set([2]),
        eventIdsInScopePrograms: new Set([200]),
    }),
    coreVolunteer: ctx({
        selfId: 11,
        householdId: 5,
        programsCoreVolIn: new Set([101]),
        participantIdsInScopePrograms: new Set([9]),
        householdIdsInScopePrograms: new Set([2]),
        eventIdsInScopePrograms: new Set([201]),
    }),
    keyholder: ctx({
        selfId: 12,
        householdId: 6,
        isKeyholder: true,
        activeVisitorIds: new Set([9, 5]),
    }),
    // board/sysadmin privilege lives in the Role/view layer, not CallerContext —
    // to the per-row resolver they are plain authenticated members.
    boardMember: ctx({ selfId: 13, householdId: 7 }),
    sysadmin: ctx({ selfId: 14, householdId: 8 }),
};

// Representative rows. Each carries every field any binding matches on, so one
// row exercises all models. Includes the fail-closed / non-object cases.
const ROWS: Array<{ label: string; row: unknown }> = [
    { label: 'null', row: null },
    { label: 'undefined', row: undefined },
    { label: 'number (non-object)', row: 42 },
    { label: 'string (non-object)', row: 'nope' },
    { label: 'empty object', row: {} },
    { label: 'present but no scope keys', row: { id: 1, name: 'X' } },
    {
        label: "caller-5 own / in-program / active",
        row: { id: 5, householdId: 2, participantId: 5, personId: 5, programId: 100, eventId: 200, userId: 5, actorId: 5, departedAt: null },
    },
    {
        // isHouseholdLead exercises Person.their_program_households (hh 2 is in
        // the lead's/core-vol's scope). Row id 9 below is the same household
        // WITHOUT the flag, and row id 7 carries the flag in an out-of-scope
        // household — together the positive and both negatives.
        label: 'household co-member + household lead (hh 2)',
        row: { id: 6, householdId: 2, isHouseholdLead: true, participantId: 6, personId: 6, programId: 100, eventId: 200, userId: 6, actorId: 6, departedAt: null },
    },
    {
        label: 'program participant / coreVol prog / active visitor',
        row: { id: 9, householdId: 2, participantId: 9, personId: 9, programId: 101, eventId: 201, userId: 9, actorId: 9, departedAt: null },
    },
    {
        label: "another's / out-of-program / departed / household lead",
        row: { id: 7, householdId: 99, isHouseholdLead: true, participantId: 7, personId: 7, programId: 88, eventId: 88, userId: 7, actorId: 7, departedAt: new Date() },
    },
    {
        label: "lead's own program (Program row id 100)",
        row: { id: 100, householdId: 4, participantId: 10, personId: 10, programId: 100, eventId: 200, userId: 10, actorId: 10, uploadedByUserId: 10, departedAt: null },
    },
];

const MODELS = [
    ...Object.keys(SCOPE_BINDINGS), // includes AuditLog (now bound — Blocker 2)
    // unbound-but-sensitive, structurally-unscopable, and unknown — all must
    // resolve identically (everyones-only, or {} via fail-closed) under both.
    'Tool',
    'BoardSettings',
    'OrgMembershipProcess',
    'UnknownModelXYZ',
];

function eq(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

/**
 * The frozen switch is the S2 snapshot of pre-refactor behavior. A binding added
 * AFTER that snapshot legitimately diverges from it; this wraps the oracle with
 * those intentional, documented deltas so the test stays an explicit contract
 * (not a silenced mismatch).
 *
 * AuditLog.their_own (Blocker 2, §7.5.1): the switch had no AuditLog case, so it
 * yields {everyones}. AuditLog was later bound `their_own: actorId` purely so the
 * coverage validator passes — runtime-inert (no route grants their_own:internal
 * on AuditLog). On a row whose actorId === selfId the table therefore adds
 * their_own where the snapshot did not. That is the one expected diff.
 *
 * Person.keyholders: the switch's Person case had no keyholders grant, so it
 * yields no 'keyholders'. Person was later bound `keyholders: { flag }` — an
 * unconditional per-row grant mirroring TrustedAdult — so that
 * GET /api/safety/board-contacts can hand keyholders the board's email/phone
 * via a 'keyholders:pii' token instead of a blanket 'everyones:pii'. On any
 * object row, a keyholder caller therefore holds 'keyholders' where the
 * snapshot did not. That is the second expected diff.
 *
 * Visit.led_households (#1254): the switch's Visit case bound only their_own +
 * all_current_visitors, so a household lead held nothing on a member's visit —
 * which would strip arrivedAt/departedAt from exactly the rows the AT3
 * act-for-members capability returns. Visit carries no householdId, so the
 * binding matches personId against ctx.ledHouseholdMemberIds (populated only
 * for leads). On a Visit row whose personId is in that roster, a lead therefore
 * holds 'led_households' where the snapshot did not. That is the third
 * expected diff.
 *
 * Person.their_program_households: the switch's Person case had no household-
 * scoped program grant, so a lead held nothing on a parent's row. Person was
 * later bound `their_program_households` on (householdId ∈
 * householdIdsInScopePrograms AND isHouseholdLead), so GET /api/programs/[id]
 * can hand a program lead the parents' phone/email on the roster. On a
 * household-lead row in an in-scope household the resolver therefore adds
 * their_program_households where the snapshot did not. That is the fourth
 * expected diff.
 *
 * Receipt / ReceiptView / ReceiptLineView.their_own (#1265 §6): receipt models
 * postdate the switch, which has no case for them. Each is bound `their_own` on
 * uploadedByUserId === selfId, so on such a row the resolver adds their_own
 * where the snapshot did not. That is the fifth expected diff.
 */
function expectedFromSnapshot(
    model: string,
    row: Record<string, unknown> | null | undefined,
    callerCtx: CallerContext,
): Set<Scope> {
    const expected = referenceScopesHeld(model, row, callerCtx);
    if (
        model === 'AuditLog' &&
        row &&
        typeof row === 'object' &&
        typeof row.actorId === 'number' &&
        row.actorId === callerCtx.selfId
    ) {
        expected.add('their_own');
    }
    if (model === 'Person' && row && typeof row === 'object' && callerCtx.isKeyholder) {
        expected.add('keyholders');
    }
    if (
        model === 'Visit' &&
        row &&
        typeof row === 'object' &&
        typeof row.personId === 'number' &&
        callerCtx.ledHouseholdMemberIds.has(row.personId)
    ) {
        expected.add('led_households');
    }
    if (
        model === 'Person' &&
        row &&
        typeof row === 'object' &&
        row.isHouseholdLead === true &&
        typeof row.householdId === 'number' &&
        callerCtx.householdIdsInScopePrograms.has(row.householdId)
    ) {
        expected.add('their_program_households');
    }
    if (
        (model === 'Receipt' || model === 'ReceiptView' || model === 'ReceiptLineView') &&
        row &&
        typeof row === 'object' &&
        typeof row.uploadedByUserId === 'number' &&
        row.uploadedByUserId === callerCtx.selfId
    ) {
        expected.add('their_own');
    }
    return expected;
}

describe('S1 — scopesHeld ≡ frozen switch + intentional deltas (personas × models × rows)', () => {
    it('matches the snapshot (plus documented post-snapshot bindings)', () => {
        const mismatches: string[] = [];
        for (const [pName, pCtx] of Object.entries(PERSONAS)) {
            for (const model of MODELS) {
                for (const { label, row } of ROWS) {
                    const expected = expectedFromSnapshot(model, row as Record<string, unknown>, pCtx);
                    const next = scopesHeld(model, row as Record<string, unknown>, pCtx);
                    if (!eq(expected as Set<string>, next as Set<string>)) {
                        mismatches.push(
                            `${pName} / ${model} / ${label}: ` +
                                `expected={${[...expected].sort().join(',')}} table={${[...next].sort().join(',')}}`,
                        );
                    }
                }
            }
        }
        expect(mismatches).toEqual([]);
    });

    it('covers every bound model', () => {
        // Guard against the row set silently not exercising a model.
        expect(MODELS).toEqual(expect.arrayContaining(Object.keys(SCOPE_BINDINGS)));
        expect(Object.keys(SCOPE_BINDINGS).length).toBe(20); // +AuditLog (Blocker 2) -HouseholdLead (a1 contract) -FeePayment (FR7 drop) +3 receipt (#1265)
    });
});
