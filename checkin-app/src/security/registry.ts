/**
 * THE security policy. One entry per API endpoint and one per outbound surface.
 *
 * Every change here is a change to what data leaves the server, to which
 * role, through which channel. CODEOWNERS-gated, and boundary changes must
 * ship in their OWN PR (enforced by security-boundary-isolation.yml) so a
 * widening/narrowing is always an isolated, reviewable unit.
 *
 * This layer exists to make the policy easy to AUDIT — it is not a substitute
 * for careful route management. Handlers still owe tight selects and
 * deliberate response shapes; the stripper is the declared-policy backstop,
 * not the first line.
 *
 * orderedView is walked top-to-bottom; the first role the caller satisfies
 * decides the view. Order matters — treat reorders as policy changes.
 *
 * Each vendored library keeps its route entries in its own
 * `registry/<lib>.ts` module, registered by the side-effect imports below.
 * Importing this file registers the whole policy.
 */
import { defineRoute, defineOutbound, type OrderedViewEntry } from './core';
import './registry/catalog';
import './registry/inventory';
import './registry/expense';
import './registry/income';
import './registry/donation';
import './registry/workflow';
import './registry/receipt';
import './registry/budgetOwner';
import './registry/shopifyRead';

// ─── Routes ────────────────────────────────────────────────────────────────

defineRoute({
    endpoint: 'GET /api/profile',
    authorize: 'self',
    envelope: 'profile',
    // Bag: { Person } with nested visits (Visit) → event (Event).
    returns: ['Person', 'Visit', 'Event'],
    orderedView: [
        [
            'authenticated',
            ['their_own:pii', 'their_own:personal', 'their_own:internal', 'member', 'public'],
        ],
    ],
});

// Self-correction of a visit the caller may act for: PATCH edits the times,
// DELETE tombstones the row. `[id]` is a Visit id, NOT a person id, so 'self'
// cannot express the gate — it compares the id param against auth.user.id.
// Subject ownership is enforced in the route body, which 404s any id the caller
// may not act for; the two per-row tokens are the field backstop for the two
// legitimate subjects:
//   their_own      — Visit.personId === caller (a member editing their own row)
//   led_households — Visit.personId is in a household the caller LEADS (the
//                    lead is the responsible adult for members who
//                    cannot self-serve). Lead-only, not household-wide: a
//                    non-lead sibling holds neither token and sees nothing.
// Both are needed — under led_households a plain member editing their own visit
// is not a household match, so their_own is what keeps self-correction working.
// The grant stops at 'personal' (arrivedAt/departedAt); 'internal' tombstone
// fields stay stripped.
defineRoute({
    endpoint: 'PATCH /api/attendance/manual/[id]',
    authorize: 'authenticated',
    envelope: 'visit',
    // Bag: { Visit }.
    returns: ['Visit'],
    orderedView: [
        ['authenticated', ['their_own:personal', 'led_households:personal', 'member', 'public']],
    ],
});

defineRoute({
    endpoint: 'DELETE /api/attendance/manual/[id]',
    authorize: 'authenticated',
    // No bag — response is {}, no model data. Tokens are inert over an empty bag.
    envelope: null,
    orderedView: [],
});

// Staff insert of a past visit for ANOTHER person — the walk-in
// neither the kiosk (live only, personId from the badge) nor the event roster
// mark (program-scoped, event window) can record. Unlike the self-service
// routes above, the target personId comes from the REQUEST BODY, so the role
// gate is the entire subject boundary — there is no 'their_own' leg to fall
// back on and no scope resolver in play. Sysadmin and board only: the same set
// the sibling GET/PATCH/DELETE on /api/facility/visits carry and the same set
// facility-ops/visits gates the page on, which must stay equal. Not
// isOperations: operations' reach into attendance is aggregate only (the
// trends, printing ID badges; docs/rules/attendance-checkin.md), so one
// person's visit record stays outside it.
//
// Its own endpoint rather than a POST on /api/facility/visits: adding a verb to
// an existing legacy route file cannot satisfy this registry's own lints in any
// PR ordering — registry-first trips `orphan-registry` (the file exports no such
// verb yet), route-first trips `new-route-old-authz`, and shipping both together
// trips boundary isolation. A new path has no route file, which is exactly the
// register-first state `orphan-registry` warns for.
//
// The response echoes the single Visit just created, so everyones:internal
// covers the tombstone columns the model carries (deletedAt/deletedById — both
// null on a fresh row, declared rather than accidentally stripped).
defineRoute({
    endpoint: 'POST /api/facility/visits/insert',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'visit',
    // Bag: { Visit }.
    returns: ['Visit'],
    orderedView: [
        ['isSysadmin',    ['everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// Board/sysadmin review of recent attendance-correction activity.
// The handler does not query Visit directly — it reads AuditLog rows
// where tableName === 'Visit' and SYNTHESIZES a Visit view per row from the
// audit blob (arrivedAt/departedAt/arrivedVia/departedVia extracted from
// newData). stripValue (stripper.ts) copies any field present on an object
// without checking provenance, so a synthesized row strips exactly like a
// real one — that is what makes this legal, not an exception to it.
//
// 'everyones:personal' is required: Visit.arrivedAt/departedAt are
// personal-tier and this is a review-scope surface, not a self-scope one, so
// no <scope>:<tier> row token applies. 'everyones:internal' is required for
// AuditLog itself — every field on it (id, timestamp, actorId, action, …) is
// internal-tier. 'pii' and 'member' are deliberately NOT granted: no field on
// AuditLog, Person, or Visit needs either for this view.
//
// AuditLog.newData is REBUILT by the handler to { type, significance } before
// it reaches this layer; raw oldData/newData (arbitrary blob shape) must never
// leave the route. Neither obligation is enforceable HERE: 'everyones:internal'
// permits both fields wholesale and a tier does not reach inside a JSON blob,
// so a handler that passed oldData straight through would ship a whole-row
// snapshot with every suite green. correctionsAPI.integration.test.ts carries
// the assertion instead. No pagination — nothing else here would
// give total/page/pageSize a legal home under any envelope value (handler.ts
// strips before the envelope wraps), so the handler caps rows and over-fetches
// by one to signal "more" instead.
//
// How a before/after pair crosses the boundary: a separate bag key is not expressible
// — stripBag drops any top-level key that is not a model name, so there can be
// exactly one Visit key — and a before row and its after row share a Visit.id,
// so no field distinguishes them. Array position is the only discriminator, and
// it survives because stripValue maps arrays element-wise and preserves order.
//
// Served by src/app/api/facility/corrections/route.ts. Its flagged-only default
// view is complete only once every Visit audit write persists
// newData.significance — an unscored write never surfaces.
defineRoute({
    endpoint: 'GET /api/facility/corrections',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: null,
    // Bag: { AuditLog, Person, Visit } — Visit synthesized from AuditLog blobs,
    // not queried. Handler always emits all three keys, even empty: handler.ts
    // unwraps a single-key bag to a bare value.
    returns: ['AuditLog', 'Person', 'Visit'],
    orderedView: [
        ['isSysadmin',    ['everyones:personal', 'everyones:internal', 'public']],
        ['isBoardMember', ['everyones:personal', 'everyones:internal', 'public']],
    ],
});

defineRoute({
    endpoint: 'GET /api/programs/[id]',
    authorize: 'public',
    envelope: null,
    // Bag: { Program } with volunteers (ProgramVolunteer → participant Person),
    // participants (ProgramParticipant → participant Person → household Household
    // → emergencyContacts EmergencyContact), events (Event), leadMentor (Person).
    returns: ['Program', 'ProgramParticipant', 'ProgramVolunteer', 'Person', 'Household', 'EmergencyContact', 'Event'],
    orderedView: [
        ['isSysadmin',             ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember',          ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        // their_program_households delivers the household band leads operationally
        // need: the family's emergency contacts (personal) and the parents' own
        // contact details (pii). Person binds this scope ONLY on isHouseholdLead
        // rows, so the pii grant reaches the two adults a lead would call and no
        // one else — siblings and other household members hold nothing.
        //
        // The route's volunteer and lead-mentor Person selects (id, name, email)
        // carry neither householdId nor isHouseholdLead, so this scope fails closed
        // on those rows. Adding either column to those selects widens what a
        // lead/core-vol receives for a parent volunteer.
        //
        // Still out of reach: the family's home address (Household.line1..postalCode
        // are 'internal', above every token here) and Household.intakeNotes ('pii',
        // but Household binds no scope beyond their_households, so a
        // their_program_households token resolves to nothing on a Household row).
        ['programLeadMentor',    ['their_program_participants:pii',
                                  'their_program_participants:personal',
                                  'their_program_households:pii',
                                  'their_program_households:personal',
                                  'member', 'public']],
        ['programCoreVolunteer', ['their_program_participants:pii',
                                  'their_program_participants:personal',
                                  'their_program_households:pii',
                                  'their_program_households:personal',
                                  'member', 'public']],
        ['authenticated',        ['their_own:pii', 'their_own:personal', 'member', 'public']],
        ['anyone',               ['public']],
    ],
});

// Event roster — embeds participant contact pii (name/email/phone) AND
// personal-tier data (dob, incl. youth) for everyone enrolled in / RSVP'd to
// the program. This route is FAIL-CLOSED,
// staff-only: the handler fn (events/[id]/route.ts) does an inline event->program
// lead/core-vol/admin gate and throws 403 for everyone else, so non-staff never
// receive the roster at all. That gate is NOT here in `authorize` because the
// roster's identities (name/id, and the existence of each enrollment/RSVP/Visit
// row) are tier 'public', so per-field stripping cannot hide the "who attends"
// association — only admission can; and the event->program check can't be
// expressed in the program-scoped `authorize` grammar (this [id] is an EVENT id;
// resolveAccess keys those on a PROGRAM id). The orderedView below is therefore
// defense-in-depth over the staff tiers only: admin -> everyones:*, and this
// event's lead/core-vol -> their_program_participants:* via the per-row scope
// resolver (mirrors 'GET /api/trusted-adults/operational'). internal tier is
// granted to that scope so staff keep attendanceConfirmedAt (rendered by
// program-ops/sessions/[id]).
defineRoute({
    endpoint: 'GET /api/events/[id]',
    authorize: 'authenticated',
    envelope: null,
    // Bag: { Event } with program (Program → volunteers ProgramVolunteer → participant
    // Person; participants ProgramParticipant → participant Person), visits
    // (Visit), rsvps (RSVP → participant Person), attendanceConfirmedBy (Person).
    returns: ['Event', 'Program', 'ProgramVolunteer', 'ProgramParticipant', 'Person', 'Visit', 'RSVP'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['authenticated', ['their_program_participants:pii',
                           'their_program_participants:personal',
                           'their_program_participants:internal',
                           'their_own:pii',
                           'their_own:personal',
                           'member', 'public']],
    ],
});

// Staff directory SEARCH for un-enrolled participants to add to a program.
// Admission ('program-lead-mentor'; resolveAccess also admits sysadmin/board)
// is the real boundary. The search returns names only (owner ruling,
// docs/rules/programs.md) as EligibleCandidate rows: id, name and a computed
// age-fit label, all public. Person is not in the bag, so no email or date of
// birth can leave even if the query over-selects.
defineRoute({
    endpoint: 'GET /api/programs/[id]/eligible-participants',
    authorize: 'program-lead-mentor',
    envelope: 'members',
    // Bag: { EligibleCandidate }.
    returns: ['EligibleCandidate'],
    orderedView: [
        ['isSysadmin',        ['public']],
        ['isBoardMember',     ['public']],
        ['programLeadMentor', ['public']],
    ],
});

// Emergency board contact sheet for the front desk. Board email + phone to
// keyholders is DELIBERATE and owner-confirmed: a keyholder on shift needs to
// reach a board member, and this is the sheet they reach for. That makes the
// 'pii' grant an operational one exactly as core.ts describes it ("routinely
// grantable to operational roles: program leads, keyholders"), not a leak.
// Declared here so the recurring audit finding on this route resolves to
// policy instead of being re-litigated each sweep — same move as
// GET /api/shop/certifications below.
//
// Written as 'keyholders:pii' (bound flag-only on Person) rather than
// 'everyones:pii' so the grant reads as what it is. Both resolve identically
// under this route's role gate; the token is the audit signal.
//
// The route's Prisma select stays tight (id/name/email/phone) as defense in
// depth: dateOfBirth and googleId are 'personal'/'pii' on Person and must
// never enter this response even for sysadmin.
defineRoute({
    endpoint: 'GET /api/safety/board-contacts',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember', 'isKeyholder'] },
    envelope: 'members',
    // Bag: { Person }.
    returns: ['Person'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isKeyholder',   ['keyholders:pii', 'member', 'public']],
    ],
});

// Board opens an individual membership agreement for one adult child.
// The response echoes only the obligation it just opened — the route selects
// id/kind/status and nothing else, so no person, household or Zoho field is in
// the bag to begin with. `status` is the sole internal-tier field, hence a grant
// that stops at internal with no pii/personal band: this endpoint has no reason
// to name anyone. Who currently owes an agreement is a different question, asked
// through the compliance dashboard's own entry.
defineRoute({
    endpoint: 'POST /api/membership-audit/person-agreement',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'process',
    // Bag: { OrgMembershipProcess }, no relations.
    returns: ['OrgMembershipProcess'],
    orderedView: [
        ['isSysadmin',    ['everyones:internal', 'public']],
        ['isBoardMember', ['everyones:internal', 'public']],
    ],
});

// Board records a membership refund already made in Shopify. Board-only: a refund
// is a money decision the policy gives the board, and sysadmin has no counterpart
// there. The response echoes the application's id and new status and nothing
// else, so the grant stops at internal with no pii/personal band.
defineRoute({
    endpoint: 'POST /api/membership-ops/applications/refund',
    authorize: { anyRole: ['isBoardMember'] },
    envelope: 'process',
    // Bag: { OrgMembershipProcess }, no relations.
    returns: ['OrgMembershipProcess'],
    orderedView: [
        ['isBoardMember', ['everyones:internal', 'public']],
    ],
});

// Board's in-flight membership applications. Exposes every applicant household's
// PII (parents + children names/emails), so only isSysadmin/board may see it, and
// the field grant is explicit per role.
defineRoute({
    endpoint: 'GET /api/membership-ops/applications',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'processes',
    // Bag: { OrgMembershipProcess } with attestations (BackgroundCheckAttestation),
    // membership (OrgMembership → household Household → householdMembers Person,
    // leads flagged isHouseholdLead).
    returns: ['OrgMembershipProcess', 'BackgroundCheckAttestation', 'OrgMembership', 'Household', 'Person'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// Board's volunteer roster: households on volunteer dues + the emails designated
// ahead of signup. Exposes household leads' addresses and the designated
// addresses (Person.email and VolunteerDesignation.email are both 'pii'), so
// only isSysadmin/board may see it.
//
// The grant deliberately stops short of 'personal'. The roster is standing +
// contact data — household name, lead names, one lead email, memberSince, the
// designated address — and no personal-tier field (dateOfBirth, allergies,
// notificationSettings) belongs in it. 'internal' IS granted: a row's status
// is derived from OrgMembershipProcess.status, so a blocked or in-flight
// application is observable in the response even though the column itself
// never reaches the wire.
//
// Registered ahead of its handler() conversion; inert until the route
// serves it.
defineRoute({
    endpoint: 'GET /api/membership-ops/volunteer-memberships',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'rows',
    // Bag: { OrgMembership } with household (Household → householdMembers Person,
    // leads flagged isHouseholdLead) and processes (OrgMembershipProcess), plus
    // { VolunteerDesignation } for the pre-designated emails.
    returns: ['OrgMembership', 'Household', 'Person', 'OrgMembershipProcess', 'VolunteerDesignation'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:internal', 'member', 'public']],
    ],
});

// Board-only cleanup path for a BackgroundCheckAttestation the participant-
// merge refuses to carry forward: its collision check ("Both attested the
// same background check") means the same human reviewed
// under two Person identities. Board-only, NOT sysadmin — removing a review
// is a membership decision (docs/rules/membership.md). No bag: the response
// is { success: true }, no model data.
defineRoute({
    endpoint: 'DELETE /api/membership-ops/bg-attestations/[id]',
    authorize: { anyRole: ['isBoardMember'] },
    envelope: null,
    orderedView: [
        ['isBoardMember', ['public']],
    ],
});

// Tombstone census. Lists merged-away Person rows and, per tombstone,
// the residue still parked on it — the surface a sysadmin/board uses to triage the
// existing stock before the LIVE_PERSON removal deletes those rows. The bag is
// { Person } (each tombstone's id/name/email + its survivor via mergedInto, plus a
// _count of the residue relations) and { PersonMerge } (fromId only, so the page
// can flag a tombstone that has no archive row). Exposes tombstone identity,
// so isSysadmin/board only — the same band that already sees applicant PII.
//
// The grant is pii + internal + public: email is the one pii field; name/id/
// mergedInto are public; PersonMerge.fromId and the `roles`/`rawBadgeLogs` relations
// are internal-tier, and `_count` is gated per-relation on relationVisible (any
// field of the target model visible under these tokens) — without everyones:internal
// those two counts silently drop and PersonMerge always reads empty, understating
// the census (every tombstone reads "no archive" and the no-pathway total
// under-reports).
defineRoute({
    endpoint: 'GET /api/membership-ops/participants/tombstones',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: null,
    // Bag: { Person } (tombstones, with mergedInto Person for the survivor and a
    // _count of the residue relations) and { PersonMerge } (archive rows, fromId).
    returns: ['Person', 'PersonMerge'],
    orderedView: [
        ['isSysadmin',    ['everyones:internal', 'everyones:pii', 'public']],
        ['isBoardMember', ['everyones:internal', 'everyones:pii', 'public']],
    ],
});

// A reviewer withdraws their own approval while the review still waits on its
// second reviewer; the service enforces ownership, APPROVE-only and phase. Same
// admission band as the queue. No bag: the response is {}, no model data.
defineRoute({
    endpoint: 'POST /api/membership/reviews/undo',
    authorize: { anyRole: ['isBackgroundCheckReviewer', 'isBoardMember'] },
    envelope: null,
    orderedView: [],
});

// The caller's own Key Volunteer Agreement: its status, the embedded sign URL
// (the first click creates the Zoho request) and the return-from-signing status
// pull. Each resolves the caller's own open agreement, so the grant is
// their_own; a row for anyone else keeps only its public personId.
const KEY_VOLUNTEER_SELF_VIEW: readonly OrderedViewEntry[] = [
    ['authenticated', ['their_own:internal', 'public']],
];

defineRoute({
    endpoint: 'GET /api/membership/key-volunteer',
    authorize: 'authenticated',
    envelope: null,
    returns: ['KeyVolunteerSelfStatus'],
    orderedView: KEY_VOLUNTEER_SELF_VIEW,
});

defineRoute({
    endpoint: 'POST /api/membership/key-volunteer/sign',
    authorize: 'authenticated',
    envelope: null,
    returns: ['KeyVolunteerSigning'],
    orderedView: KEY_VOLUNTEER_SELF_VIEW,
});

defineRoute({
    endpoint: 'POST /api/membership/key-volunteer/sync',
    authorize: 'authenticated',
    envelope: null,
    returns: ['KeyVolunteerSelfStatus'],
    orderedView: KEY_VOLUNTEER_SELF_VIEW,
});

// Background-check reviewers' queue. Reviewers must see applicant parents' names
// + emails (to look them up on Averity) but NOT internal/personal fields — so the
// grant is deliberately limited to pii + public. Board members are implicit
// reviewers (canReviewBackgroundChecks) and get the same limited band.
defineRoute({
    endpoint: 'GET /api/membership/reviews',
    authorize: { anyRole: ['isBackgroundCheckReviewer', 'isBoardMember'] },
    envelope: 'queue',
    // Bag: { OrgMembershipProcess } with membership (OrgMembership → household Household
    // → householdMembers Person, leads flagged isHouseholdLead) and the process's
    // attestations. Reviewers attest PER ADULT, so the card shows each lead's own
    // approval count; the route selects `subjectPersonId` alone off each attestation.
    // Widening that select is a policy decision, not a convenience: `reviewerId` is
    // public-tier and would tell reviewer B that reviewer A already signed off, which
    // the deliberate `_count`-only shape exists to prevent.
    returns: ['OrgMembershipProcess', 'OrgMembership', 'Household', 'Person', 'BackgroundCheckAttestation'],
    orderedView: [
        ['isBackgroundCheckReviewer', ['everyones:pii', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'member', 'public']],
    ],
});

// The caller's household trusted adults. Household-scoped: members/leads see
// the family context (internal — narrative safeguarding band; the family
// authored it and the renew form prefills it) + the adult's contact + the
// board's shared note (personal) + status/dates. The their_households:internal
// grant nominally also covers TrustedAdultReview.decision/decisionNote (the
// board's private notes) — those are kept out by the handler's SELECT, which
// is pinned by trustedAdultAPI.integration.test.ts ("the family sees
// familyContext + the board shared note, not internal fields"). Do not widen
// that select.
defineRoute({
    endpoint: 'GET /api/trusted-adults/mine',
    authorize: 'household-member',
    envelope: 'trustedAdults',
    // Bag: { TrustedAdult } with reviews (TrustedAdultReview).
    returns: ['TrustedAdult', 'TrustedAdultReview'],
    orderedView: [
        ['authenticated', ['their_households:pii', 'their_households:personal', 'their_households:internal', 'member', 'public']],
    ],
});

// Board's trusted-adult review queue. Full visibility incl. familyContext
// (internal — narrative band) and the board's internal decision notes.
defineRoute({
    endpoint: 'GET /api/safety/trusted-adults',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'trustedAdults',
    // Bag: { TrustedAdult } with household (Household → householdMembers Person,
    // leads flagged isHouseholdLead), trustedAdultPerson (Person), reviews (TrustedAdultReview).
    returns: ['TrustedAdult', 'Household', 'Person', 'TrustedAdultReview'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// Operational pickup view for keyholders (global) and program leads (the
// households whose kids they oversee). They get the board's shared note + the
// adult's name/contact (personal), but NOT the family's board-facing context
// or the board's internal notes (both internal — the strict narrative band
// their personal-only grants never reach). Household address is also internal,
// so the nested Household rows expose name only. The handler restricts which
// rows are returned; this view is the field-level backstop.
defineRoute({
    endpoint: 'GET /api/trusted-adults/operational',
    authorize: 'authenticated',
    envelope: 'trustedAdults',
    // Bag: { TrustedAdult } with household (Household), reviews (TrustedAdultReview).
    returns: ['TrustedAdult', 'Household', 'TrustedAdultReview'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isKeyholder',   ['keyholders:personal', 'their_program_households:personal', 'their_households:personal', 'member', 'public']],
        // Catch-all: program leads (and household members) match here. Scopes are
        // per-row, so a caller only receives 'personal' on rows where they hold
        // their_program_households (a kid in their program) or their_households.
        ['authenticated', ['their_program_households:personal', 'their_households:personal', 'member', 'public']],
    ],
});

// Board's payment-plan approval queue. Returns pending ProgramParticipant rows
// with the full participant + program nested, plus the participant's
// household/orgMembership (so the board can see CURRENT membership while
// deciding — wasOrgMemberAtApproval is only stamped on approval). Board/finance
// only, no sysadmin, and they hold everyones:* so they see every field — the win
// is the declared policy: any role later added to this view is field-stripped
// automatically.
defineRoute({
    endpoint: 'GET /api/finance-ops/payment-plans',
    authorize: 'finance-or-board',
    envelope: null,
    returns: ['ProgramParticipant', 'Person', 'Program', 'Household', 'OrgMembership', 'BoardSettings'],
    orderedView: [
        ['isFinance',     ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
    auditedRead: true,
});

// The "who is 18 as of the member-year start" roster (Membership Audit). Ships
// the CLASSIFIED INPUTS, not a verdict: dateOfBirth plus the board's year
// boundary, so the two as-of ages are derived client-side — the stripper drops
// ad-hoc computed fields, same reason GET /api/finance-ops/payment-plans ships
// startAt + boundary instead of a next-year boolean.
//
// The grant is deliberately NARROWER than the sibling audit views' everyones:*:
// this response needs exactly dateOfBirth ('personal') on top of public identity
// (name, household name, program name). No email/phone, so no ':pii'; no
// lastBackgroundCheck, so no ':internal'. A later widening has to show up here.
//
// ProgramParticipant rides along to mark which of these people are enrolled in a
// program. That edge is all-public-tier — row EXISTENCE is the sensitive part —
// so admission is the real boundary, and this view is board/sysadmin only.
defineRoute({
    endpoint: 'GET /api/membership-audit/turning-18',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: null,
    // Bag: { Person } with household (Household) and programParticipants
    // (ProgramParticipant → program Program), plus { BoardSettings }.
    returns: ['Person', 'Household', 'ProgramParticipant', 'Program', 'BoardSettings'],
    orderedView: [
        ['isSysadmin',    ['everyones:personal', 'member', 'public']],
        ['isBoardMember', ['everyones:personal', 'member', 'public']],
    ],
});

// Board-only attestation history: who reviewed whose background check, when, and
// the outcome. The bag is BackgroundCheckAttestation rows with the reviewer
// (Person), the subject (Person, nullable), and the process
// (OrgMembershipProcess) carrying its own subjectPerson and household context.
// `note` and `result` on the attestation are internal-tier; `reviewer.name` is
// public. Board/sysadmin hold everyones:internal, so they see everything.
defineRoute({
    endpoint: 'GET /api/membership-audit/bg-attestations',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: null,
    returns: ['BackgroundCheckAttestation', 'OrgMembershipProcess', 'Person', 'Household'],
    orderedView: [
        ['isSysadmin',    ['everyones:internal', 'everyones:personal', 'member', 'public']],
        ['isBoardMember', ['everyones:internal', 'everyones:personal', 'member', 'public']],
    ],
});

// Board's membership payment-plan approval queue. Returns PENDING_PAYMENT
// OrgMembershipProcess rows the household asked to pay by plan, with the
// membership + household nested. Board/finance only, no sysadmin, and they hold
// everyones:* so they see every field — the win is the declared policy: any role
// later added to this view is field-stripped automatically.
defineRoute({
    endpoint: 'GET /api/finance-ops/membership-payment-plans',
    authorize: 'finance-or-board',
    envelope: null,
    returns: ['OrgMembershipProcess', 'OrgMembership', 'Household', 'Person'],
    orderedView: [
        ['isFinance',     ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
    auditedRead: true,
});

// Board's unconfirmed Shopify stock screen: programs whose stock write could not
// be confirmed (lib/shopify/stock.ts parks it in Program.shopifyStockParked;
// a program can also hold a parked sum in shopifyStockUnconfirmed), and the per-program settle action
// ("Shopify has it" / "doesn't have it"). Board only: no sysadmin, no finance.
// Rows are computed, all `internal`.
defineRoute({
    endpoint: 'GET /api/finance-ops/shopify-stock',
    authorize: { anyRole: ['isBoardMember'] },
    envelope: null,
    returns: ['UnconfirmedStockRow'],
    orderedView: [
        ['isBoardMember', ['everyones:internal', 'public']],
    ],
});
defineRoute({
    endpoint: 'POST /api/finance-ops/shopify-stock/[id]',
    authorize: { anyRole: ['isBoardMember'] },
    envelope: null,
    returns: ['UnconfirmedStockSettlement'],
    orderedView: [
        ['isBoardMember', ['everyones:internal', 'public']],
    ],
});

// Shop member roster (for certifying tools). Admins/board see the full row incl.
// email (pii). Certifiers only need to NAME the member they certify, so they get
// name (public) + member-tier — NOT everyones:pii, so no certifier receives
// another member's email.
defineRoute({
    endpoint: 'GET /api/shop/org-members',
    authorize: 'certifier',
    // bag-key `Person` (model driving field-strip) vs envelope `orgMembers` (camelCase JSON key) vs path `org-members` (kebab URL) — divergence intentional.
    envelope: 'orgMembers',
    returns: ['Person'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['certifier',     ['member', 'public']],
    ],
});

// Shop tool certifications. PUBLIC BY DESIGN — cert status is physically posted
// in the shop, so any authenticated member may read who is certified on what
// (participantId/toolId/name = public, level = member tier). Admission is
// 'authenticated' (a logged-in member; denied households fail closed at
// authenticateRequest). The route selects only {id, name} (no client needs
// email), but this policy declares participant email as staff-only: if email is
// ever added to the select, only the staff view (everyones:pii) receives it;
// certifiers and members match 'authenticated' and see name + level only. This
// makes the endpoint's public intent machine-readable, so the recurring
// IDOR-shaped audit false-positive resolves to declared policy.
defineRoute({
    endpoint: 'GET /api/shop/certifications',
    authorize: 'authenticated',
    envelope: null,
    // Bag: { ToolStatus } with tool (Tool) and participant (Person).
    returns: ['ToolStatus', 'Tool', 'Person'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['authenticated', ['member', 'public']],
    ],
});

// Standalone (one-time) events list — admin surface.
// The handler selects only public-tier Event columns (id/name/startAt/endAt/
// description). Declared public-only ON PURPOSE: the response is exact, not
// aspirational. If the select later grows to an internal field
// (attendanceConfirmedAt/ById, postEventEmailSent) the strip fails closed and
// forces a boundary PR + CODEOWNERS review, instead of the field shipping
// silently under a pre-granted band.
defineRoute({
    endpoint: 'GET /api/events',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: null,
    // Bag: { Event } — bare-array response (envelope null + single-key bag).
    returns: ['Event'],
    orderedView: [
        ['isSysadmin',    ['public']],
        ['isBoardMember', ['public']],
    ],
});

// Facility visit log (latest 50, all people) — admin surface. Nested person carries email
// (pii) + role flags; the admin everyones band covers them, and the near-raw
// response makes the declared view exact.
defineRoute({
    endpoint: 'GET /api/facility/visits',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'visits',
    // Bag: { Visit } with person (Person).
    returns: ['Visit', 'Person'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// Raw badge scan log (latest 200) — admin surface. RawBadgeLog rows are
// internal/personal tier; nested person name/email for display. Near-raw
// response, so the declared everyones band is exact.
defineRoute({
    endpoint: 'GET /api/facility/badges',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'badges',
    // Bag: { RawBadgeLog } with person (Person).
    returns: ['RawBadgeLog', 'Person'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// Server error log (latest 100) — admin surface, all internal tier.
defineRoute({
    endpoint: 'GET /api/system-status/errors',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'errors',
    returns: ['ErrorLog'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// Integration error log (latest 200) — admin surface, all internal tier.
// The response key is `errors` because LinkStatusPanel reads that key.
defineRoute({
    endpoint: 'GET /api/system-status/links',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'errors',
    returns: ['IntegrationErrorLog'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// Finance view log (B11) — who viewed finance records. Board only: finance
// holders are most of the people it records, and sysadmins are kept out by
// least privilege; anyRole has no sysadmin auto-admit. Not
// `auditedRead`: the log holds no finance content, so reading it is not logged.
//
// FinanceViewLog has no relation to Person, so viewer names travel as a second
// bag key of { id, name } rows, both public-tier. The handler always emits both
// keys, even empty, since a single-key bag unwraps to a bare value. No
// total/page in the body: the stripper drops non-model keys, so the handler
// over-fetches by one to signal another page.
defineRoute({
    endpoint: 'GET /api/system-status/finance-views',
    authorize: { anyRole: ['isBoardMember'] },
    envelope: null,
    // Bag: { FinanceViewLog, Person }.
    returns: ['FinanceViewLog', 'Person'],
    orderedView: [
        ['isBoardMember', ['everyones:internal', 'public']],
    ],
});

// Parked kiosk scans awaiting review (docs/rules/attendance-checkin.md, kiosk
// resilience) — the
// RawBadgeLog rows a replay parked instead of toggling (reviewReason set,
// reviewedAt still null).
//
// Same everyones band as the sibling GET /api/facility/badges, MINUS pii:
// the panel names the person and nothing more, so the route selects person
// { id, name } only (both public-tier) and there is no email/phone in the
// bag for a pii grant to cover. Narrower than the sibling ON PURPOSE —
// widening it later is a boundary PR, which is the point. 'personal' is
// required for RawBadgeLog.timestamp (the "scanned 2:14pm" the row copy is
// built on) and location; 'internal' for the row's own bookkeeping —
// reviewReason, clientEventId, personId, and the reviewedAt/reviewedBy columns.
//
// Keyholders are admitted. isOperations stays out: the attendance rule
// puts operations at aggregate only — they do not read one person's raw
// badge events. The bag is already minimized, so the keyholder grant matches
// board's band rather than growing it.
defineRoute({
    endpoint: 'GET /api/system-status/unsynced-scans',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember', 'isKeyholder'] },
    envelope: 'scans',
    // Bag: { RawBadgeLog } with person (Person).
    returns: ['RawBadgeLog', 'Person'],
    orderedView: [
        ['isSysadmin',    ['everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isKeyholder',   ['everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// Dismiss one parked scan — stamps reviewedAt/reviewedBy and nothing else. No
// bag: the response is `{}`, so the grant is inert by construction and the
// entry is an admission gate only (same shape as DELETE
// /api/attendance/manual/[id]). `[id]` is a RawBadgeLog id. Deliberately NOT a
// resolver: minting a Visit from a parked scan raises an open staleness
// question, so the panel's other action is a deep link to the manual-visit
// tool, which carries its own registered grant.
defineRoute({
    endpoint: 'POST /api/system-status/unsynced-scans/[id]',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember', 'isKeyholder'] },
    envelope: null,
    orderedView: [],
});

// Daily QuickBooks expense posting (stranded recovery + outbox drain), a money
// write, so it answers only to its own secret, never the shared CRON_SECRET.
// Admission gate only: the response carries no rows.
defineRoute({
    endpoint: 'GET /api/cron/qbo-posting',
    authorize: { cronSecret: 'qbo-posting' },
    envelope: null,
    orderedView: [],
});

// In-memory kiosk last-seen. No DB row: the stamp
// lives on the task, so the bag is a synthesized SystemMetricLog (metric
// `kiosk_last_seen`, timestamp = last verified kiosk request, value = age
// in seconds). Empty array means never seen since this task started (or
// overnight after scale-to-zero).
defineRoute({
    endpoint: 'GET /api/system-status/kiosk-heartbeat',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'heartbeat',
    returns: ['SystemMetricLog'],
    orderedView: [
        ['isSysadmin',    ['everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:internal', 'member', 'public']],
    ],
});

// Volunteer designations (dues-discount allowlist; email is pii) — admin
// surface. GET is a pure findMany (create/delete live on other HTTP methods).
defineRoute({
    endpoint: 'GET /api/settings/membership/volunteer-designations',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'designations',
    returns: ['VolunteerDesignation'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// The caller's own visit history (±7-day window). their_own:personal delivers
// arrivedAt/departedAt on the caller's rows — the Visit binding keys on
// row.personId, so the route's select MUST include personId or the scope fails
// closed and the timestamps strip. Nested event name is public.
defineRoute({
    endpoint: 'GET /api/profile/visits',
    authorize: 'authenticated',
    envelope: 'visits',
    // Bag: { Visit } with event (Event).
    returns: ['Visit', 'Event'],
    orderedView: [
        ['authenticated', ['their_own:personal', 'member', 'public']],
    ],
});

// The first-sign-in question: does this adult join the household that added
// them? Only Household.name leaves, and only to the person being asked.
defineRoute({
    endpoint: 'GET /api/profile/household-question',
    authorize: 'authenticated',
    allowJoinPending: true,
    envelope: 'household',
    // Bag: { Household }.
    returns: ['Household'],
    orderedView: [
        ['authenticated', ['public']],
    ],
});

// Records the answer. The bag is empty; the status tells the client the outcome.
defineRoute({
    endpoint: 'POST /api/profile/household-question',
    authorize: 'authenticated',
    allowJoinPending: true,
    envelope: null,
    returns: ['Household'],
    orderedView: [
        ['authenticated', ['public']],
    ],
});

// App-localization singleton (timezone/locale) — sysadmin-only surface,
// wholly public-tier data; the gate is about who may see admin settings
// screens, not the fields. Declared public-only ON PURPOSE: AppSettings is the
// natural home for a future integration key / webhook secret, and a public-only
// view makes that field fail closed (forcing a boundary PR) instead of shipping
// to sysadmin through an entry nobody revisited.
defineRoute({
    endpoint: 'GET /api/admin/settings/localization',
    authorize: { anyRole: ['isSysadmin'] },
    envelope: 'settings',
    // Bag: { AppSettings } (singleton row).
    returns: ['AppSettings'],
    orderedView: [
        ['isSysadmin', ['public']],
    ],
});

// Email identity settings (From/Reply-To/scholarship notify) — admin surface.
// BoardSettings singleton, narrow select in the handler.
defineRoute({
    endpoint: 'GET /api/settings/email',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'settings',
    returns: ['BoardSettings'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// Membership settings singleton (dues, year boundary, Shopify variant ids —
// internal tier) and the per-year variant rows — admin surface, full rows.
defineRoute({
    endpoint: 'GET /api/settings/membership',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'settings',
    returns: ['BoardSettings', 'MembershipYearVariant'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// Board bumps the Key Volunteer Agreement version, opening a new agreement for
// every current Key Volunteer. Board-only: the agreement is a Board document.
// The response is the new version and the count opened; no person leaves.
defineRoute({
    endpoint: 'POST /api/settings/membership/key-volunteer-version',
    authorize: { anyRole: ['isBoardMember'] },
    envelope: null,
    returns: ['KeyVolunteerVersionBump'],
    orderedView: [
        ['isBoardMember', ['everyones:internal', 'public']],
    ],
});

// ─── Outbound surfaces ─────────────────────────────────────────────────────
// A surface's tiers are enforced only for a caller that goes through
// outboundCall(), and an entry's comment says when that is so. Every other
// entry is an inventory, not a guarantee: its tiers state what the code sends
// today, and changing them changes nothing on the wire.

// src/lib/shopify/ surfaces → <SHOPIFY_STORE_DOMAIN> Admin API. Every caller of
// these write surfaces goes through outboundCall(); each entry names its callers.

defineOutbound({
    surface: 'shopify.product.create',
    // src/lib/shopify/products.ts: the public and reserved-seat product creates.
    // Program name, nonOrgMemberPriceCents and maxParticipants ('public'), plus a
    // handle built from the program's id and name.
    // Enforced: createShopifySingleVariantProgram and createClaimantProduct
    // (src/lib/shopify/products.ts) build the product request inside outboundCall(),
    // so the Program fields are stripped to these tiers.
    tiers: ['public'],
});

defineOutbound({
    surface: 'shopify.product.update',
    // src/lib/shopify/products.ts (unlist the reserved-seat product) and
    // src/lib/shopify/stock.ts (variant price sync, product off sale). Program
    // shopifyProductId / claimantShopifyProductId, shopifyVariantId /
    // claimantShopifyVariantId and nonOrgMemberPriceCents ('public').
    // Enforced: createClaimantProduct (src/lib/shopify/products.ts) and
    // syncProgramPrice and setProgramProductOffSale (src/lib/shopify/stock.ts)
    // build their requests inside outboundCall(), so the Program fields are
    // stripped to these tiers.
    tiers: ['public'],
});

defineOutbound({
    surface: 'shopify.inventory.activate',
    // src/lib/shopify/stock.ts inventoryActivate. Program id ('public') inside the
    // idempotency key, plus Shopify's own inventory item and location ids.
    // Enforced: drainStock (src/lib/shopify/stock.ts) builds the activate request
    // inside outboundCall(), so the Program id is stripped to these tiers.
    tiers: ['public'],
});

defineOutbound({
    surface: 'shopify.inventory.adjust',
    // src/lib/shopify/stock.ts inventoryAdjustQuantities. The bag carries the whole
    // Program.shopifyStockPendingWrite ('internal', a JSON string). The request takes
    // from it the idempotency key (program id and stock reason), the delta (a seat
    // count taken from shopifyStockCarry) and Shopify's inventory item and location
    // ids; its reason, owedPart and sentAt are not sent.
    // Enforced: sendStockWrite (src/lib/shopify/stock.ts) builds the adjust request
    // inside outboundCall() from the stripped pending write, so it is stripped to
    // these tiers.
    tiers: ['public', 'internal'],
});

defineOutbound({
    surface: 'shopify.discount.create',
    // src/lib/shopify/discounts.ts discountCodeBasicCreate. Program id and checkout
    // variant id, Household id ('public') in the code's prefix, and the member
    // discount (the gap between the two 'public' prices).
    // Enforced: mintMemberDiscountCode (src/lib/shopify/discounts.ts) builds the
    // discount request inside outboundCall(), so the Program and Household fields
    // are stripped to these tiers.
    tiers: ['public'],
});

defineOutbound({
    surface: 'email.admin-notify',
    // Email address is 'pii' tier; the address is the entire payload here.
    tiers: ['public', 'pii'],
});

// packages/* and *-function surfaces. These callers use fetch or an SDK
// directly, not outboundCall(), except where an entry says otherwise.
// check-route-coverage confines each surface to the files PACKAGE_EGRESS_FILES
// (egressAllowlist.ts) maps to it, and only for a host it can see in a literal
// or SDK import.

defineOutbound({
    surface: 'quickbooks.query',
    // packages/quickbooks/src/client.ts → (sandbox-)quickbooks.api.intuit.com.
    // Query literals: date windows, QBO ids, and account/class names ('public').
    // Vendor/Customer name lookups are quickbooks.vendor. Never an email, address or phone.
    tiers: ['public'],
});

defineOutbound({
    surface: 'quickbooks.create',
    // packages/quickbooks/src/client.ts → (sandbox-)quickbooks.api.intuit.com.
    // Purchase/Bill/Deposit only: amounts, dates, account/class/vendor ids, line
    // descriptions and memos ('internal'; memos may name a program participant,
    // accepted by the owner).
    // Enforced for one caller: packages/expense's poster builds its Purchase/Bill
    // inside outboundCall() (the expense `outbound` port, bound in
    // lib/expense/configure.ts), so its rows are stripped to these tiers. The
    // income and bulk-donation (Benevity) posters still call directly; for them
    // this entry is inventory.
    tiers: ['public', 'internal'],
});

defineOutbound({
    surface: 'quickbooks.vendor',
    // packages/quickbooks/src/client.ts → (sandbox-)quickbooks.api.intuit.com.
    // Vendor create and Vendor/Customer lookup carry the vendor display name only
    // ('public'). Never an email, address or phone.
    tiers: ['public'],
});

defineOutbound({
    surface: 'quickbooks.oauth',
    // packages/quickbooks/src/oauth.ts → oauth.platform.intuit.com. The app's client
    // credentials, an authorization code or a refresh token; no model data.
    tiers: [],
});

defineOutbound({
    surface: 'shopify.admin-read',
    // packages/s-ingest-core/src/config.ts builds the Admin GraphQL endpoint that
    // s-read-function calls. Read-only bulk/order queries and cursors; no model data.
    tiers: [],
});

defineOutbound({
    surface: 'shopify.oauth',
    // s-read-function/src/shopify/token.ts → <shop>.myshopify.com/admin/oauth/access_token.
    // The app's client credentials for a client-credentials grant; no model data.
    tiers: [],
});

defineOutbound({
    surface: 'anthropic.receipt-ocr',
    // packages/receipt/src/lib/ocr.ts → api.anthropic.com via @anthropic-ai/sdk.
    // The receipt file's bytes (Receipt.fileBlob, 'pii'): a receipt can show a
    // purchaser's name, address and partial card number. Bytes only, never a URL.
    tiers: ['pii'],
});

defineOutbound({
    surface: 'gmail.read',
    // packages/receipt/src/lib/gmail.ts → gmail.googleapis.com. Read-only by intent:
    // the token comes from gmail-refresher-function, whose consent CLI refuses any
    // scope but gmail.readonly. The app does not check the scope at runtime.
    // List/get requests only: a date-window query string and message/attachment ids;
    // no model data. Mail read back is tiered by the receipt models that store it.
    tiers: [],
});

defineOutbound({
    surface: 'gmail.oauth',
    // gmail-refresher-function/src/oauth.ts → accounts.google.com, oauth2.googleapis.com.
    // The app's client credentials, an authorization code or a refresh token; no model
    // data. The consent URL also carries the mailbox address as login_hint: the org's
    // own mailbox, named by the operator running consent, not a model field, so no tier.
    tiers: [],
});
