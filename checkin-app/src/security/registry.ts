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
 */
import { defineRoute, defineOutbound } from './core';

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
//   led_households — Visit.personId is in a household the caller LEADS (AT3,
//                    #1254: the lead is the responsible adult for members who
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

// Staff insert of a past visit for ANOTHER person (AT3, #1254) — the walk-in
// neither the kiosk (live only, personId from the badge) nor the event roster
// mark (program-scoped, event window) can record. Unlike the self-service
// routes above, the target personId comes from the REQUEST BODY, so the role
// gate is the entire subject boundary — there is no 'their_own' leg to fall
// back on and no scope resolver in play. Sysadmin and board only: the same set
// the sibling GET/PATCH/DELETE on /api/facility/visits carry and the same set
// facility-ops/visits gates the page on, which must stay equal (their drifting
// apart was AT13/#1259). Widening to isOperations was answered NO: #1633 puts
// operations' reach into attendance at aggregate only (the trends, printing ID
// badges), so one person's visit record stays outside it. #1476, closed.
//
// Its own endpoint rather than a POST on /api/facility/visits: adding a verb to
// an existing legacy route file cannot satisfy this registry's own lints in any
// PR ordering — registry-first trips `orphan-registry` (the file exports no such
// verb yet), route-first trips `new-route-old-authz`, and shipping both together
// trips boundary isolation. A new path has no route file, which is exactly the
// register-first state `orphan-registry` warns for. See #1491.
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

// Board/sysadmin review of recent attendance-correction activity (AT12,
// #1258). The handler does not query Visit directly — it reads AuditLog rows
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
// snapshot with every suite green. The route PR carries the assertion instead
// (correctionsAPI.integration.test.ts). No pagination — nothing else here would
// give total/page/pageSize a legal home under any envelope value (handler.ts
// strips before the envelope wraps), so the handler caps rows and over-fetches
// by one to signal "more" instead.
//
// This entry also settles the open question #1497 left to the route PR: how a
// before/after pair crosses the boundary. A separate bag key is not expressible
// — stripBag drops any top-level key that is not a model name, so there can be
// exactly one Visit key — and a before row and its after row share a Visit.id,
// so no field distinguishes them. Array position is the only discriminator, and
// it survives because stripValue maps arrays element-wise and preserves order.
//
// Served by src/app/api/facility/corrections/route.ts. Its flagged-only default
// view is complete only once every Visit audit write persists
// newData.significance (#1523, PR #1558) — an unscored write never surfaces.
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
        // FINDING for the CODEOWNERS reviewer: this widens live traffic. The route
        // already returns full-row Person selects outside the participant bag —
        // `volunteers.include.person` and `leadMentor` — so a lead/core-vol now
        // receives, for any program volunteer or lead mentor who is also a household
        // lead of an in-scope household (a parent volunteer, the common case):
        // email/phone from this pii grant, plus dateOfBirth/allergies/
        // notificationSettings/emailSuppressed from the pre-existing :personal token,
        // which now resolves on those rows too. Those rows held `everyones` only
        // before. Narrowing the two selects to what the roster renders is a route
        // change, not a boundary one.
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

// Staff directory SEARCH for un-enrolled participants to add to a program. The
// rows are NOT in the program (by definition), so the per-row
// their_program_participants scope grants nothing here — admission is the real
// boundary: 'program-lead-mentor' (resolveAccess also admits sysadmin/board)
// restricts callers to a lead of THIS program. Once admitted, staff see the
// directory's contact band (name[public]/email[pii]); dateOfBirth is 'personal'
// (the strict tier), so it reaches only sysadmin/board (everyones:personal) —
// a program lead may NOT enumerate the whole directory's DOBs. The UI degrades
// cleanly: the age-warning badge in the enroll picker needs dob, and only
// sysadmin/board can enroll anyway. FINDING for the CODEOWNERS reviewer:
// 'everyones:pii' here is a deliberate global-directory contact grant, not a
// per-program scope.
defineRoute({
    endpoint: 'GET /api/programs/[id]/eligible-participants',
    authorize: 'program-lead-mentor',
    envelope: 'members',
    // Bag: { Person }.
    returns: ['Person'],
    orderedView: [
        ['isSysadmin',        ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember',     ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['programLeadMentor', ['everyones:pii', 'member', 'public']],
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
//
// Landed registry-first, ahead of the route's handler() migration, per the
// AGENTS.md boundary-isolation rule: an unused defineRoute is inert, so the
// grant is reviewable on its own before anything serves it.
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

// Board opens an individual membership agreement for one adult child (#1224).
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
// Landed registry-first, ahead of the route in #1387, per the AGENTS.md
// boundary-isolation rule: an unused defineRoute is inert, so the grant is
// reviewable on its own before anything serves it.
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

// Sysadmin-only cleanup path for a BackgroundCheckAttestation the participant-
// merge route refuses to carry forward: its collision check ("Both attested
// the same background check", merge/route.ts) means the same human reviewed
// under two Person identities, and nothing removes the duplicate row today.
// Sysadmin-only, NOT board — attestations are review artifacts, not a
// membership decision (#1456 Decision 3). No bag: the response is
// { success: true }, no model data.
//
// Landed registry-first, ahead of the route, per the AGENTS.md boundary-
// isolation rule: an unused defineRoute is inert, so the grant is reviewable
// on its own before anything serves it.
defineRoute({
    endpoint: 'DELETE /api/membership-ops/bg-attestations/[id]',
    authorize: { anyRole: ['isSysadmin'] },
    envelope: null,
    orderedView: [
        ['isSysadmin', ['public']],
    ],
});

// Tombstone census (#1456 §2a). Lists merged-away Person rows and, per tombstone,
// the residue still parked on it — the surface a sysadmin/board uses to triage the
// existing stock before the LIVE_PERSON removal deletes those rows. The bag is
// { Person } (each tombstone's id/name/email + its survivor via mergedInto, plus a
// _count of the residue relations) and { PersonMerge } (fromId only, so the page
// can flag a legacy tombstone that has no archive row). Exposes tombstone identity,
// so isSysadmin/board only — the same band that already sees applicant PII.
//
// The grant is pii + public: email is the one pii field, name/id/mergedInto are
// public, and every _count rides its relation's public id, so a broad band is not
// needed to keep the residue counts intact.
//
// Landed registry-first, ahead of the route, per the AGENTS.md boundary-isolation
// rule: an unused defineRoute is inert, so the grant is reviewable on its own.
defineRoute({
    endpoint: 'GET /api/membership-ops/participants/tombstones',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: null,
    // Bag: { Person } (tombstones, with mergedInto Person for the survivor and a
    // _count of the residue relations) and { PersonMerge } (archive rows, fromId).
    returns: ['Person', 'PersonMerge'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'public']],
        ['isBoardMember', ['everyones:pii', 'public']],
    ],
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
// deciding — wasOrgMemberAtApproval is only stamped on approval). Board/sysadmin
// only, and they hold everyones:* so they see every field — the win is the
// declared policy: any role later added to this view is field-stripped
// automatically.
defineRoute({
    endpoint: 'GET /api/finance-ops/payment-plans',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: null,
    returns: ['ProgramParticipant', 'Person', 'Program', 'Household', 'OrgMembership', 'BoardSettings'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
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
// membership + household nested. Board/sysadmin only, and they hold everyones:*
// so they see every field — the win is the declared policy: any role later added
// to this view is field-stripped automatically.
defineRoute({
    endpoint: 'GET /api/finance-ops/membership-payment-plans',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: null,
    returns: ['OrgMembershipProcess', 'OrgMembership', 'Household', 'Person'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// Shop member roster (for certifying tools). Admins/board see the full row incl.
// email (pii). Certifiers only need to NAME the member they certify, so they get
// name (public) + member-tier — NOT everyones:pii. This deliberately TIGHTENS the
// pre-migration behavior, which leaked every member's email to any certifier.
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

// Standalone (one-time) events list — admin surface. Registered ahead of its
// handler() conversion (inert until then; AGENTS.md boundary-isolation rule).
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

// Facility visit log (latest 50, all people) — admin surface. Registered ahead
// of its handler() conversion (inert until then). Nested person carries email
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

// Raw badge scan log (latest 200) — admin surface, registered ahead of its
// handler() conversion (inert until then). RawBadgeLog rows are
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

// Server error log (latest 100) — admin surface, all internal tier. Registered
// ahead of its handler() conversion (inert until then).
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
// Registered ahead of its handler() conversion (inert until then). The response
// key is `errors` for back-compat with the existing UI.
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

// Parked kiosk scans awaiting review (docs/rules/attendance-checkin.md, kiosk
// resilience) — the
// RawBadgeLog rows a replay parked instead of toggling (reviewReason set,
// reviewedAt still null). Landed registry-first, ahead of the route.
//
// Same everyones band as the sibling GET /api/facility/badges, MINUS pii:
// the panel names the person and nothing more, so the route selects person
// { id, name } only (both public-tier) and there is no email/phone in the
// bag for a pii grant to cover. Narrower than the sibling ON PURPOSE —
// widening it later is a boundary PR, which is the point. 'personal' is
// required for RawBadgeLog.timestamp (the "scanned 2:14pm" the row copy is
// built on) and location; 'internal' for the row's own bookkeeping —
// reviewReason, clientEventId, personId, and the two new reviewedAt/reviewedBy
// columns.
//
// Q15 admits keyholders. isOperations stays out: #1633 / the attendance rule
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
// resolver: minting a Visit from a parked scan inherits the open §5.26/B4
// staleness question, so the panel's other action is a deep link to the manual-
// visit tool, which carries its own registered grant. Landed registry-first.
defineRoute({
    endpoint: 'POST /api/system-status/unsynced-scans/[id]',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember', 'isKeyholder'] },
    envelope: null,
    orderedView: [],
});

// In-memory kiosk last-seen. No DB row: the stamp
// lives on the task, so the bag is a synthesized SystemMetricLog (metric
// `kiosk_last_seen`, timestamp = last verified kiosk request, value = age
// in seconds). Empty array means never seen since this task started (or
// overnight after scale-to-zero). Landed registry-first, ahead of the route.
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
// surface, registered ahead of its handler() conversion (inert until then). GET
// is a pure findMany (create/delete live on other HTTP methods).
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

// The caller's own visit history (±7-day window). Registered ahead of its
// handler() conversion (inert until then). their_own:personal delivers
// arrivedAt/departedAt on the caller's rows — the Visit binding keys on
// row.personId, so the conversion PR's select MUST include personId or the
// scope fails closed and the timestamps strip (#1137 finding 1). Nested event
// name is public.
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
// internal tier) — admin surface, full row.
defineRoute({
    endpoint: 'GET /api/settings/membership',
    authorize: { anyRole: ['isSysadmin', 'isBoardMember'] },
    envelope: 'settings',
    returns: ['BoardSettings'],
    orderedView: [
        ['isSysadmin',    ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
        ['isBoardMember', ['everyones:pii', 'everyones:personal', 'everyones:internal', 'member', 'public']],
    ],
});

// ─── Outbound surfaces ─────────────────────────────────────────────────────

defineOutbound({
    surface: 'shopify.product.create',
    // Program name + prices + maxParticipants — all 'public' tier.
    tiers: ['public'],
});

defineOutbound({
    surface: 'email.admin-notify',
    // Email address is 'pii' tier; the address is the entire payload here.
    tiers: ['public', 'pii'],
});
