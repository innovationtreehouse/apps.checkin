/**
 * SCOPE_BINDINGS — the declarative per-row scope table.
 *
 * Ported 1:1 from the imperative `switch (modelName)` that lived in
 * access-resolvers.ts (`scopesHeld`). Each entry says: "the caller holds
 * <scope> on a <Model> row when <Match> holds." The engine (scopes.ts) seeds
 * `everyones` and applies these; the equivalence test
 * (scopeBindingsEquivalence.test.ts) proves set-equality with the old switch
 * across every persona × model × row, which is the contract that this port is
 * behavior-neutral.
 *
 * Field names verified against the LIVE generated map
 * (./generated/classifications.ts), not the §7.4 doc table. Discrepancies found
 * vs that table (see docs/security/auth-consistency-analysis.md §7.4/§7.5):
 *   - Visit:  field is `departedAt` (doc wrote `departed`).            [doc fixed]
 *   - ToolStatus: field is `personId` (renamed userId→participantId #564, then participantId→personId).
 *   - RawBadgeLog: model is `RawBadgeLog` (doc table wrote `RawBadgeEvent`).
 *   - RSVP: has no `programId` column of its own, so the program-lead grant
 *     resolves via eventId → Event.programId (ctx.eventIdsInScopePrograms), not
 *     a direct `row.programId` read. See the RSVP binding below + §7.5/§9 Step 3.
 *
 * IMPORTANT: This file is CODEOWNERS-gated.
 */
import { makeScopesHeld, type ScopeBindings } from './scopes';

export const SCOPE_BINDINGS = {
    Person: {
        their_own: { field: 'id', eqCtx: 'selfId' },
        their_households: { field: 'householdId', eqCtx: 'householdId' },
        their_program_participants: { field: 'id', inCtx: 'participantIdsInScopePrograms' },
        // The PARENTS of the children a program lead/core-vol oversees: household
        // leads (isHouseholdLead) of ctx.householdIdsInScopePrograms. The
        // isHouseholdLead conjunct IS the policy — a sibling or any other member of
        // an in-scope household holds nothing here, so only the two adults a lead
        // would actually call are reachable. Requires the row to carry BOTH
        // householdId and isHouseholdLead; either one unselected fails closed
        // (isTrue is strict === true, and inCtx rejects a non-number).
        // ctx.householdIdsInScopePrograms is the union across ALL programs the caller
        // leads/core-vols, so on program A's page a lead of both A and B also resolves
        // this on a row whose household's child is enrolled in B, not A.
        their_program_households: {
            all: [
                { field: 'householdId', inCtx: 'householdIdsInScopePrograms' },
                { field: 'isHouseholdLead', isTrue: true },
            ],
        },
        // Global front-desk grant, unconditional per row (mirrors TrustedAdult).
        // Only GET /api/safety/board-contacts grants keyholders:* on Person, and
        // that route returns board members only. Any future Person view granting
        // a keyholders:* token is a policy decision, not an inherited one.
        keyholders: { flag: 'isKeyholder' },
        all_current_visitors: {
            all: [{ flag: 'isKeyholder' }, { field: 'id', inCtx: 'activeVisitorIds' }],
        },
    },
    Household: { their_households: { field: 'id', eqCtx: 'householdId' } },
    // Row-scoped (see ROW_SCOPE_KEY): a key-less EmergencyContact row fails closed.
    // their_program_households mirrors TrustedAdult: a program lead/core-vol sees
    // the emergency contacts of the households whose children they oversee
    // (ctx.householdIdsInScopePrograms), granted to those views in registry.ts.
    EmergencyContact: {
        their_households: { field: 'householdId', eqCtx: 'householdId' },
        their_program_households: { field: 'householdId', inCtx: 'householdIdsInScopePrograms' },
    },
    OrgMembership: { their_households: { field: 'householdId', eqCtx: 'householdId' } },
    Program: {
        their_program_participants: { field: 'id', inCtx: ['programsLed', 'programsCoreVolIn'] },
    },
    ProgramParticipant: {
        their_program_participants: {
            field: 'programId',
            inCtx: ['programsLed', 'programsCoreVolIn'],
        },
        their_own: { field: 'personId', eqCtx: 'selfId' },
    },
    ProgramVolunteer: {
        their_program_participants: {
            field: 'programId',
            inCtx: ['programsLed', 'programsCoreVolIn'],
        },
        their_own: { field: 'personId', eqCtx: 'selfId' },
    },
    // RSVP has no programId column of its own; the program-lead grant resolves
    // via eventId → Event.programId (ctx.eventIdsInScopePrograms), not a direct
    // row.programId read. See docs/security/auth-consistency-analysis.md §7.5.
    RSVP: {
        their_own: { field: 'personId', eqCtx: 'selfId' },
        their_program_participants: { field: 'eventId', inCtx: 'eventIdsInScopePrograms' },
    },
    Event: {
        their_program_participants: {
            field: 'programId',
            inCtx: ['programsLed', 'programsCoreVolIn'],
        },
    },
    // No householdId column: a Visit reaches a household only through its
    // person, so `led_households` matches personId against the caller's led
    // household roster rather than comparing a householdId field. It is the
    // lead-only scope, NOT `their_households` — a non-lead sibling has no claim
    // on another member's arrival/departure times.
    Visit: {
        their_own: { field: 'personId', eqCtx: 'selfId' },
        led_households: { field: 'personId', inCtx: 'ledHouseholdMemberIds' },
        // A visit AT one of the caller's program sessions. Visit has no
        // programId column either, so this reaches a program the way RSVP does:
        // associatedEventId → Event.programId (ctx.eventIdsInScopePrograms).
        // Deliberately NOT personId ∈ participantIdsInScopePrograms — that would
        // hand a program lead every facility visit their participants ever made,
        // not just the ones at their own sessions. A route must select
        // associatedEventId to get the grant; an unselected column fails closed
        // (inCtx rejects a non-number).
        their_program_participants: {
            field: 'associatedEventId',
            inCtx: 'eventIdsInScopePrograms',
        },
        // deletedAt is a conjunct, not a nicety: a tombstoned visit keeps
        // departedAt null forever, so without it a deleted open visit reads as
        // an active one for the rest of time.
        all_current_visitors: {
            all: [
                { flag: 'isKeyholder' },
                { field: 'departedAt', isNull: true },
                { field: 'deletedAt', isNull: true },
            ],
        },
    },
    RawBadgeLog: { their_own: { field: 'personId', eqCtx: 'selfId' } },
    ToolStatus: { their_own: { field: 'personId', eqCtx: 'selfId' } },
    Account: { their_own: { field: 'userId', eqCtx: 'selfId' } },
    Session: { their_own: { field: 'userId', eqCtx: 'selfId' } },
    // Bound for coverage; admin-only by tier-grant control (no route grants
    // their_own:internal on AuditLog — only everyones:internal/admin views read
    // audit rows). Audit rows record who-did-what-to-whom (incl. staff actions
    // ON members), so exposing them to the actor would leak investigation/
    // safeguarding context. A "your own actions" view would be a conscious
    // future decision. See docs/security/auth-consistency-analysis.md §7.5.1.
    AuditLog: { their_own: { field: 'actorId', eqCtx: 'selfId' } },
    TrustedAdult: {
        their_households: { field: 'householdId', eqCtx: 'householdId' },
        their_program_households: { field: 'householdId', inCtx: 'householdIdsInScopePrograms' },
        keyholders: { flag: 'isKeyholder' },
    },
    TrustedAdultReview: {
        their_households: { field: 'householdId', eqCtx: 'householdId' },
        their_program_households: { field: 'householdId', inCtx: 'householdIdsInScopePrograms' },
        keyholders: { flag: 'isKeyholder' },
    },
} as const satisfies ScopeBindings;

/**
 * Models whose sensitive fields MUST be gated by a scope key the row carries:
 * if the key is absent (e.g. a query selected the row but not its `householdId`)
 * the resolver returns NO scopes — not even `everyones` — so the stripper drops
 * every sensitive field. Fails CLOSED. This is the old ROW_SCOPE_KEY map; it
 * moved here with the bindings. The §7.3 engine sketch dropped it, but the live
 * switch has it and the EmergencyContact fail-closed unit tests require it.
 */
export const ROW_SCOPE_KEY: Record<string, string> = {
    EmergencyContact: 'householdId',
};

/**
 * Work queue: models that are sensitive AND scopable (could carry a `their_*`
 * relationship) but whose scoped route is not built yet, so they are bound
 * nowhere. A future §9 migration moves each entry OUT of this set and INTO a
 * real SCOPE_BINDINGS binding, in the same PR that ships its handler() route.
 * Done when this set is empty.
 *
 * There is NO permanent opt-out list — structurally un-scopable models (no
 * actor FK) are auto-exempt by isScopable() in validateBindings; "never leaves,
 * even to admins" content is tiered `secret`.
 *
 * NOTE — this DIVERGES from the doc §7.5.1 list, which also names
 * `EmergencyContact`. The live switch already BINDS EmergencyContact (the
 * ROW_SCOPE_KEY pilot case), so it belongs in SCOPE_BINDINGS, not here — the
 * doc's listing is stale (it predates that case landing; §9 Step 4 still treats
 * it as pending). Removed.
 */
export const OPT_OUT_PENDING_ROUTE = new Set<string>([
    // Lands ahead of the model itself (#1752, the Stage-2 presence substrate), so
    // the boundary change ships alone and reviewable — inert until that PR adds
    // the model (an entry here is only ever read as `pendingRoute.has(model)`).
    // Append-only projection source; no route returns it — the review panel reads
    // RawBadgeLog and the heartbeat bag is synthesized. A "my presence history"
    // route is plausible later; that is when this earns a real binding.
    'PresenceEvent',
    'OrgMembershipProcess', // board/admin today; a household-facing status route is plausible
    'BackgroundCheckAttestation', // bind their_own at migration, keep notes `internal`
    'Corporation', // has leads→personId; a corp-lead view is plausible
    'VolunteerDesignation', // has createdById; confirm whether a self view is warranted
    // Lands ahead of the model itself (#1031, the Shopify payment reconciler), so the
    // boundary change ships alone and reviewable — inert until that PR adds the model
    // (an entry here is only ever read as `pendingRoute.has(model)`). Board/admin only,
    // served via withAuth on finance-ops/payments; a household-facing "your payment
    // problem" route is plausible later, and that is when this earns a real binding.
    'PaymentException',
    // Surfaced by the personId fix to SCOPABLE_FIELDS (the Participant→Person rename
    // left `participantId` in that list, so every personId-only model silently took
    // the "un-scopable, admin-only by construction" exemption instead of being made
    // to declare itself here). Both below are that backlog, not new models.
    //
    // Read today only by GET/PATCH /api/roles (withAuth isSysadmin|isBoardMember) and,
    // as a derived boolean set via rolesToFlags, by GET /api/people/search (board/
    // sysadmin/ops) — the rows themselves are never serialized into a member-facing
    // bag. auth-options.ts also reads them, but that is session assembly, not a served
    // response. A self-facing "your roles/permissions" view is the plausible future
    // reader; that is when this earns `their_own: { field: 'personId', eqCtx: 'selfId' }`.
    'PersonRole',
    // Admin outreach ledger: read only by GET /api/outreach/status and the
    // process-batch drain job, both withAuth board/sysadmin/operations. The model's
    // own schema comment makes the same call for its `email` field ("only ever read
    // by board/ops on the admin send panel, never serialized through a member-facing
    // bag"). If a self-serve "emails we sent you" / suppression-audit view ever ships,
    // it earns `their_own: { field: 'personId', eqCtx: 'selfId' }`.
    'BulkSendItem',
]);

/**
 * The per-row scope resolver. Same signature as the old switch
 * (`(modelName, row, ctx) => Set<Scope>`). access-resolvers.ts re-exports this
 * so every existing `import { scopesHeld } from './access-resolvers'` keeps
 * working unchanged.
 */
export const scopesHeld = makeScopesHeld(SCOPE_BINDINGS, ROW_SCOPE_KEY);
