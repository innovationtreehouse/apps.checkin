/**
 * SCOPE_BINDINGS — the declarative per-row scope table.
 *
 * Each entry says: "the caller holds <scope> on a <Model> row when <Match>
 * holds." The engine (scopes.ts) seeds `everyones` and applies these.
 *
 * Field names follow the LIVE generated map (./generated/classifications.ts).
 * RSVP has no `programId` column of its own, so its program-lead grant resolves
 * via eventId → Event.programId (see the RSVP binding below).
 * Background: docs/security/auth-consistency-analysis.md §7.4.
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
    // The /api/household response models: the caller's household and its members,
    // row-scoped (see ROW_SCOPE_KEY) so a row without its key fails closed.
    HouseholdPageHousehold: { their_households: { field: 'id', eqCtx: 'householdId' } },
    HouseholdPeer: { their_households: { field: 'householdId', eqCtx: 'householdId' } },
    // A peer's background-check status: the person themself and a lead of their
    // household. No their_households binding, so a non-lead sibling holds nothing.
    HouseholdPeerBgStatus: {
        their_own: { field: 'personId', eqCtx: 'selfId' },
        led_households: { field: 'personId', inCtx: 'ledHouseholdMemberIds' },
    },
    EmergencyContactWarning: { their_households: { field: 'householdId', eqCtx: 'householdId' } },
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
    // Same bindings as Person's on personId, so age follows dateOfBirth's grants.
    ProgramRosterAge: {
        their_own: { field: 'personId', eqCtx: 'selfId' },
        their_program_participants: { field: 'personId', inCtx: 'participantIdsInScopePrograms' },
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
    // The caller's own Key Volunteer Agreement status and sign URL.
    KeyVolunteerSelfStatus: { their_own: { field: 'personId', eqCtx: 'selfId' } },
    KeyVolunteerSigning: { their_own: { field: 'personId', eqCtx: 'selfId' } },
    // The family path's marking rows: the caller's own, and for a household lead
    // each other adult in the household they lead.
    CheckStartedRow: {
        their_own: { field: 'personId', eqCtx: 'selfId' },
        led_households: { field: 'personId', inCtx: 'ledHouseholdMemberIds' },
    },
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
    // Bound for coverage; Board-only by tier-grant control. The roster's only
    // view is sysadmin-or-board with everyones grants, so no route grants a
    // their_households token on it.
    VolunteerRosterRow: { their_households: { field: 'householdId', eqCtx: 'householdId' } },
    // Bound for coverage; finance-or-Board-only by tier-grant control. Every
    // route returning these grants only everyones tokens, so the bound scope
    // never reaches them, and none carries a finance mark, so isOwnRow never
    // reads the binding either.
    BudgetOwnerApprover: { their_own: { field: 'personId', eqCtx: 'selfId' } },
    BudgetOwnerTreasurer: { their_own: { field: 'personId', eqCtx: 'selfId' } },
    PersonMailAlias: { their_own: { field: 'personId', eqCtx: 'selfId' } },
    ExpenseReimburseeView: { their_own: { field: 'personId', eqCtx: 'selfId' } },
    UnconfirmedStockRow: {
        their_program_participants: { field: 'programId', inCtx: ['programsLed', 'programsCoreVolIn'] },
    },
    UnconfirmedStockSettlement: {
        their_program_participants: { field: 'programId', inCtx: ['programsLed', 'programsCoreVolIn'] },
    },
    FinanceViewLog: { their_own: { field: 'actorId', eqCtx: 'selfId' } },
    TrustedAdult: {
        their_households: { field: 'householdId', eqCtx: 'householdId' },
        their_program_households: { field: 'householdId', inCtx: 'householdIdsInScopePrograms' },
        keyholders: { flag: 'isKeyholder' },
    },
    // Receipt library: a submitter's own receipts and
    // their file. The uploader is the session's Person.id, never a payload field.
    Receipt: { their_own: { field: 'uploadedByUserId', eqCtx: 'selfId' } },
    ReceiptView: { their_own: { field: 'uploadedByUserId', eqCtx: 'selfId' } },
    ReceiptLineView: { their_own: { field: 'uploadedByUserId', eqCtx: 'selfId' } },
    // The notice of a submitter's other copy belongs to that copy's uploader.
    ReceiptDuplicateNotice: { their_own: { field: 'uploadedByUserId', eqCtx: 'selfId' } },
    // The confirmation that signs a reimbursement belongs to the person reimbursed.
    ReceiptConfirmationView: { their_own: { field: 'reimburseePersonId', eqCtx: 'selfId' } },
    ReceiptConfirmationLineView: { their_own: { field: 'reimburseePersonId', eqCtx: 'selfId' } },
    ReceiptReimbursedView: { their_own: { field: 'reimburseePersonId', eqCtx: 'selfId' } },
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
 * every sensitive field. Fails CLOSED. The EmergencyContact fail-closed unit
 * tests require it.
 */
export const ROW_SCOPE_KEY: Record<string, string> = {
    EmergencyContact: 'householdId',
    HouseholdPageHousehold: 'id',
    HouseholdPeer: 'householdId',
    EmergencyContactWarning: 'householdId',
};

/**
 * Work queue: models that are sensitive AND scopable (could carry a `their_*`
 * relationship) but whose scoped route is not built yet, so they are bound
 * nowhere. A route migration moves each entry OUT of this set and INTO a
 * real SCOPE_BINDINGS binding, in the same PR that ships its handler() route.
 *
 * A model whose routes exist but are finance- or Board-only gets a
 * coverage-only binding on its natural key instead (no view grants the token).
 * Two kinds stay here, each named "not pending" in its comment: a scopable model
 * with no natural key, and a finance-marked model, where a their_own or
 * their_households binding would make isOwnRow (financeView.ts) treat the row as
 * the viewer's own and leave the view out of the finance view log. Structurally
 * un-scopable models (no
 * actor FK) are auto-exempt by isScopable() in validateBindings; "never leaves,
 * even to admins" content is tiered `secret`.
 *
 * EmergencyContact is bound (the ROW_SCOPE_KEY case), so it is not listed here.
 * See docs/security/auth-consistency-analysis.md §7.5.1.
 */
export const OPT_OUT_PENDING_ROUTE = new Set<string>([
    // Append-only projection source; no route returns it — the review panel reads
    // RawBadgeLog and the heartbeat bag is synthesized. A "my presence history"
    // route is plausible later; that is when this earns a real binding.
    'PresenceEvent',
    'OrgMembershipProcess', // board/admin today; a household-facing status route is plausible
    'BackgroundCheckAttestation', // bind their_own at migration, keep notes `internal`
    'Corporation', // has leads→personId; a corp-lead view is plausible
    'VolunteerDesignation', // has createdById; confirm whether a self view is warranted
    // Board/admin only,
    // served via withAuth on finance-ops/payments; a household-facing "your payment
    // problem" route is plausible later, and that is when this earns a real binding.
    'PaymentException',
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
    // Not pending: local inventory audit logs. Their `userId` is in SCOPABLE_FIELDS,
    // but it is a local-inventory actor id — not checkin's `selfId` — so it never
    // earns a `their_own` binding; the internal attribution fields stay with the
    // INVENTORY_MANAGER view.
    'InventoryLog',
    'LocationLog',
    // Not pending: finance-marked, finance- or Board-only rows. Their owner key
    // (the uploader or audit actor, or the family a decision or queue row names)
    // would make isOwnRow treat the row as the viewer's own, so a staff member's
    // views of rows naming them would drop out of the finance view log.
    'UploadedFile',
    'InKindQueueItemView',
    'ReceiptAuditLog',
    'InKindDonation',
    'ProgramPaymentPlanDecision',
    'MembershipPaymentPlanDecision',
    'PaymentQueueRow',
    'MatchAuditEnrollmentRow',
    // Served only nested in Expense. A their_own binding on userId would drop staff views only from a top-level response.
    'ExpenseAuditLog',
]);

/**
 * The per-row scope resolver, `(modelName, row, ctx) => Set<Scope>`.
 * access-resolvers.ts re-exports it, so callers may
 * `import { scopesHeld } from './access-resolvers'`.
 */
export const scopesHeld = makeScopesHeld(SCOPE_BINDINGS, ROW_SCOPE_KEY);
