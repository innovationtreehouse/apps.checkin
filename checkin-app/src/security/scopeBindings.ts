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
    // Receipt library: a submitter's own receipts and
    // their file. The uploader is the session's Person.id, never a payload field.
    Receipt: { their_own: { field: 'uploadedByUserId', eqCtx: 'selfId' } },
    ReceiptView: { their_own: { field: 'uploadedByUserId', eqCtx: 'selfId' } },
    ReceiptLineView: { their_own: { field: 'uploadedByUserId', eqCtx: 'selfId' } },
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
};

/**
 * Work queue: models that are sensitive AND scopable (could carry a `their_*`
 * relationship) but whose scoped route is not built yet, so they are bound
 * nowhere. A route migration moves each entry OUT of this set and INTO a
 * real SCOPE_BINDINGS binding, in the same PR that ships its handler() route.
 * Done when this set is empty.
 *
 * There is NO permanent opt-out list — structurally un-scopable models (no
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
    // Budget-owner buckets. Not pending: its routes exist
    // (registry/budgetOwner.ts). `ownerId` makes it scopable, but every view is
    // finance-or-board with everyones grants and no owner-scoped view; per-line
    // approval by a bucket's approvers is a handler query filter, not a scope.
    'BudgetOwner',
    // A bucket's approvers. `personId` makes it scopable, but its views are
    // finance-or-board and Board with everyones grants; nobody reads their own row.
    'BudgetOwnerApprover',
    // A bucket's treasurer rows. `personId` makes it scopable; read only through
    // BudgetOwnerApprover by finance or board.
    'BudgetOwnerTreasurer',
    // finance-or-board everyones:pii only; nobody reads their own row.
    'PersonMailAlias',
    // Local inventory audit logs. Their `userId` is in SCOPABLE_FIELDS,
    // but it is a local-inventory actor id — not checkin's `selfId` — so it never
    // earns a `their_own` binding; the internal attribution fields stay with the
    // INVENTORY_MANAGER view.
    'InventoryLog',
    'LocationLog',
    // Expense audit log. Its `userId` is the acting checkin Person.id, read
    // only by FINANCE/BOARD (everyones:pii). A "my expense history" view is the
    // plausible future reader; that is when it earns `their_own` on `userId`.
    'ExpenseAuditLog',
    // Receipt audit log. Its `userId` is the acting Person.id, but only
    // FINANCE and BOARD read the log (everyones grants, GET /api/receipts/[id]/
    // audit-logs); a submitter never reads audit rows, so no `their_own` binding
    // is planned.
    'ReceiptAuditLog',
    // Bulk-donation CSV uploads. Not pending: its routes exist
    // (registry/donation.ts). `uploadedByUserId` makes it scopable, but every route
    // is finance-or-board (GET list and blob file route; FINANCE writes) with
    // everyones grants and no owner-scoped view, so it never earns `their_own`.
    'UploadedFile',
    // The in-kind finance queue row (registry/donation.ts). `uploadedByUserId`
    // makes it scopable, but its only route is finance-or-board with everyones
    // grants: the uploader and recorder ids feed the accept screen's conflict
    // warnings, and no uploader-facing view reads the queue.
    'InKindQueueItemView',
    // In-kind receipt gifts gain an uploader id (the accept step), which makes the
    // model scopable, but every route that returns it is finance-or-board with
    // everyones grants: the uploader id feeds the accept step's conflict check, and
    // no uploader-facing view reads it.
    'InKindDonation',
    // Shopify-mirror response rows (registry/shopifyRead.ts). Their `personId` makes
    // them scopable, but every route is board-only with everyones grants: the payment
    // queue and the match audit are board bookkeeping, with no person-facing view.
    'PaymentQueueRow',
    'MatchAuditEnrollmentRow',
    // The unconfirmed Shopify stock screen's rows (registry.ts). Their `programId`
    // makes them scopable, but every route is board-only with everyones grants:
    // settling stock is board bookkeeping, with no program-facing view.
    'UnconfirmedStockRow',
    'UnconfirmedStockSettlement',
    // The reimbursee named on the QuickBooks Vendor link screen (registry/expense.ts).
    // Its `personId` makes it scopable, but the only route is FINANCE with everyones
    // grants, and the reimbursee never reads their own Vendor link.
    'ExpenseReimburseeView',
    // The finance view log (B11). Its `actorId` makes it scopable, but it is
    // Board-only with everyones grants; nobody reads their own view rows.
    'FinanceViewLog',
]);

/**
 * The per-row scope resolver, `(modelName, row, ctx) => Set<Scope>`.
 * access-resolvers.ts re-exports it, so callers may
 * `import { scopesHeld } from './access-resolvers'`.
 */
export const scopesHeld = makeScopesHeld(SCOPE_BINDINGS, ROW_SCOPE_KEY);
