# Key Volunteer role and agreement

## Problem

The organisation requires certain volunteers to sign an elevated agreement — the
Key Volunteer Agreement (KVA) — beyond the standard membership agreement. Policy
names two groups explicitly: every background-check reviewer
(*Membership Policy, Art. VI §VI.2*) and every board member
(`docs/rules/membership.md` assumption).

In practice, the same obligation extends to anyone carrying risk beyond the base
membership agreement — keyholders, finance, credit-card holders,
complex-procurement participants, people with access to donor PII.

The app does not know this agreement exists. Board and reviewer role grants
assume the person has already signed it, with no record and no check. The
assumption holds today because the population is small and personally known, but
it is invisible: nothing stops a role being granted to someone who has not signed.

## Objective

Being a Key Volunteer is a role the Board grants. Holding it asks the person to
sign the KVA, and the app records the signature. The roles that carry risk —
BOARD, BG_REVIEWER, KEYHOLDER and FINANCE — can be granted only to a Key
Volunteer who has signed the current agreement.

## Executive summary

- **A new role, `KEY_VOLUNTEER`**, granted and removed by the Board on the
  existing role-management screens. The Key Volunteers are the people holding it;
  there is no separate list.
- **Granting it opens the agreement.** A `KEY_VOLUNTEER_AGREEMENT` process opens
  for the person and settles on their signature, through the same Zoho Sign /
  mock-signing flow and webhook as the membership agreement. The Board's existing
  record-by-hand action covers a paper signature.
- **The four risk roles are gated at grant.** BOARD, BG_REVIEWER, KEYHOLDER and
  FINANCE are granted only to a `KEY_VOLUNTEER` holder who has signed the current
  KVA version. Someone already holding one keeps using it: the gate is on the
  grant, not on use.
- **Order is enforced both ways.** `KEY_VOLUNTEER` cannot be removed while the
  person holds any of the four; the bigger role goes first.
- **Signed once.** A person signs again only when the Board bumps the agreement
  version after a material change. A bump asks every holder to re-sign, and nobody
  loses a role.
- **Current holders are grandfathered.** A one-off data migration gives everyone
  holding one of the four roles today `KEY_VOLUNTEER` and a KVA already signed at
  version 1, on @thpr's statement that they are known to have signed. No Zoho
  request is created for them.
- **What this does not build:** procurement-tier enforcement or card-holder
  tracking. The Board grants `KEY_VOLUNTEER` to whoever owes the agreement, and
  supplies the KVA document itself for e-signature.

---

## Standing rules this relies on

- Every reviewer has signed the key volunteer agreement.
  — *Membership Policy, Art. VI §VI.2* (`docs/rules/membership.md`, Policy)
- Reports are reviewed by people who have signed the key volunteer agreement and
  either serve on the board or are authorised in writing by it.
  — *Membership Policy, Art. VI §VI.2* (`docs/rules/membership.md`, Policy)
- A non-board reviewer was authorised in writing by the board before the reviewer
  role was granted; granting the role represents that authorisation.
  — `docs/rules/membership.md`, Assumptions
- Agreements are signed through an outside e-signature service, which carries the
  legal weight of the signature. — `docs/rules/membership.md`, Assumptions
- *Principle: least privilege*, *Principle: accountability*, *Principle: people
  decide about people* (`docs/rules/principles.md`).

## Standing rules this would change

The current assumption in `docs/rules/membership.md`:

> Every board member has signed the key volunteer agreement and is a designated
> background-check reviewer. Board membership alone therefore qualifies someone
> wherever a reviewer is required — the queue, the attestation, and the sensitive
> fields that go with it.

**Replacement.** The first clause moves from assumption to procedure. The second
(board = qualified reviewer, and everything that follows from it) is unaffected
and stays an assumption. The Policy-tier lines above stay as they are; the
entries below record how the app enforces them.

Extracted into `docs/rules/membership.md` at merge of the implementation, under
Procedure, in a new "Key Volunteers" subsection:

- BOARD, BG_REVIEWER, KEYHOLDER and FINANCE are granted only to a person who
  holds `KEY_VOLUNTEER` and has signed the current version of the key volunteer
  agreement. The check is at the grant; it is not repeated when the role is used.
  [Decision — @thpr, 2026-10-30; *Policy: Membership Policy, Art. VI §VI.2*]

- Using a role is not gated on the agreement. A person who holds one of those
  roles keeps using it while a re-sign is outstanding, and the app does not block
  review or board action on an unsigned agreement. The agreement is confirmed
  offline, person to person, before anyone is given a reviewer or board role.
  [Decision — deliberate limit, @thpr, 2026-10-30, against *Membership Policy,
  Art. VI §VI.2*]

- `KEY_VOLUNTEER` is granted and removed by the Board alone. It cannot be removed
  while the person holds any of the four roles above; that role is removed first.
  [Decision — @thpr, 2026-10-30]

- The agreement is signed once and signed again only when the Board marks it
  materially changed by bumping its version. A bump asks every `KEY_VOLUNTEER`
  holder to re-sign and removes no one's role. [Decision — @thpr, 2026-10-30]

- Everyone who held one of the four roles when the gate went live was recorded as
  a Key Volunteer who had signed version 1, on the date of that migration, without
  a signing request. [Decision — @thpr, 2026-10-30]

The assumption's replacement first clause, kept under Assumptions:

- A person grandfathered as a Key Volunteer at go-live had signed the key
  volunteer agreement on paper before then; the record dated at the migration
  stands for that signature.

---

## Design

### The role

`KEY_VOLUNTEER` is a new `PersonRoleKind`. It joins `FLAG_TO_KIND` in
`checkin-app/src/lib/roles.ts` as `isKeyVolunteer`, so it is granted, revoked and
audited through `setRoleFlag` like every other role, and appears on the existing
Roles screen (Membership Ops → Roles) and in `RoleBadge`.

It grants no access. No registry entry, nav gate or `withAuth` gate names it; it
is not a `BusinessRole` and is not added to `VALID_ROLES` in
`checkin-app/src/security/core.ts`. It has no legacy mirror column on `Person`.

The Board grants it for any reason the person owes the agreement: ahead of one of
the four roles, or for card holding, procurement or donor-PII access, which the
app does not track. The app records the role, not the reason.

### Rules in `setRoleFlag`

`setRoleFlag` is the single write path for roles (the Roles screen's
`PATCH /api/roles`, bootstrap promotion, dev seeds). The new rules sit there,
beside the last-board-member and denied-household guards:

| Change | Rule |
|--------|------|
| Grant `KEY_VOLUNTEER` | Board actor only (a sysadmin-only actor is refused). Opens a KVA for the current version unless one signed at the current version, or one open, already exists. |
| Revoke `KEY_VOLUNTEER` | Board actor only. Refused while the person holds BOARD, BG_REVIEWER, KEYHOLDER or FINANCE. Its open, unsigned KVA: see open question 7. |
| Grant BOARD, BG_REVIEWER, KEYHOLDER or FINANCE | Refused unless the person holds `KEY_VOLUNTEER` and their latest signed KVA is at the current version. Applies to every actor, system actors included, like the denied-household guard. |
| Revoke any of the four | Unchanged. |

Each refusal is its own error class, mapped by `PATCH /api/roles` to a 409 with a
message naming what is missing ("Sign the current Key Volunteer agreement first",
"Remove Board, BG reviewer, Keyholder and Finance first").

`PATCH /api/roles` takes several flags in one request and applies them in
`ROLE_FLAGS` order. It orders the writes so that one request can do what the
rules allow: revocations of the four roles before a `KEY_VOLUNTEER` revocation.
A grant of `KEY_VOLUNTEER` together with one of the four in the same request is
still refused, because the agreement it opens is not yet signed.

### The agreement process

- **New enum value:** `KEY_VOLUNTEER_AGREEMENT` on `OrgMembershipProcessKind`.
  Per-person shape: `orgMembershipId` null, `subjectPersonId` set, the same as
  `PERSON_BG` and `PERSON_AGREEMENT`.
- **Opens** at `PENDING_EXTERNAL_ACTION`, inside the `setRoleFlag` transaction
  that grants `KEY_VOLUNTEER`, or on a version bump.
- **Settles on signature**, straight to `ACTIVE`, like `PERSON_AGREEMENT`. It
  joins `SETTLES_ON_SIGNATURE` in `lifecycle.ts`, and `markContractSigned` treats
  it as it treats `PERSON_AGREEMENT`: one conditional write stamps
  `contractSignedAt` and `ACTIVE`, and `advanceExternalIfComplete` is skipped.
  The lifecycle table gains the ∅ → `PENDING_EXTERNAL_ACTION` and
  `PENDING_EXTERNAL_ACTION` → `ACTIVE` edges for the new kind, and
  `ALL_KINDS`/`ProcessKind` gain the value.
- **Records its version:** a new nullable `agreementVersion Int` on
  `OrgMembershipProcess`, set when the process opens to the current
  `BoardSettings` version and never changed. Null on every other kind.
- **Signed at the current version** means: the person's latest `ACTIVE`
  `KEY_VOLUNTEER_AGREEMENT` has `agreementVersion` equal to the current version.
  This is the one check the grant gate reads.

### Signing

**Self-service.** `resolveSigningProcess` (`checkin-app/src/lib/membership/external.ts`)
picks the household INITIAL/RENEWAL process for a lead and the caller's
`PERSON_AGREEMENT` otherwise, so a board member who is a household lead would
never reach a KVA through it. The KVA gets its own entry point: a
"Sign Key Volunteer Agreement" button on the person's own membership page, shown
while they have an open KVA, backed by three routes that resolve the caller's open
`KEY_VOLUNTEER_AGREEMENT` directly and never fall through to
`resolveSigningProcess`:

- `GET /api/membership/key-volunteer` — the caller's own status: whether they owe
  a signature, the version, whether a request has started, and whether the
  document is configured.
- `POST /api/membership/key-volunteer/sign` — creates the Zoho request on the
  first click (the same claim-before-create, dead-request recovery and watermark
  logic as `getOrCreateContractSigningUrl`, factored to share it) and returns an
  embedded sign URL. Redirects return to the membership page.
- `POST /api/membership/key-volunteer/sync` — the return-from-signing status pull,
  the KVA counterpart of `syncContractStatus`.

A Zoho request is created only by that first click. Opening a process, granting
the role, and bumping the version create none, because each request costs money.

**Webhook.** Unchanged: `POST /api/webhooks/zoho` matches the envelope with
`findProcessByEnvelope` and calls `markContractSigned`, which handles the new kind
as above.

**By hand.** The Board's existing record-by-hand action
(`POST /api/membership-ops/applications/external`, action `mark-contract`,
`markContractSigned(..., true)`) records a paper signature and clears the Zoho
signer, as it does for membership agreements. Its conflict-of-interest check
already covers per-person processes through `applicantHousehold`. That route
admits sysadmins today: see open question 8.

**Document.** The KVA PDF is a separate object in the agreement bucket
(`AGREEMENT_PDF_S3_BUCKET`), under a new `KVA_PDF_S3_KEY` that defaults to
`key-volunteer-agreement.pdf`, loaded the way `loadAgreementPdf` loads the
membership agreement. Zoho credentials and the mock-signing switch are shared.
When the object is missing, signing reports "agreement not configured" and the
self-service button says the agreement is not ready; nothing else is blocked. The
config-health check gains a line for it.

### Versions

`BoardSettings` gains `keyVolunteerAgreementVersion Int @default(1)`.

A bump is a deliberate Board act for a material change, made after the new
document is in place in S3. In one transaction it:

1. increments the version;
2. opens a KVA at the new version for every live `KEY_VOLUNTEER` holder who has
   no signed or open KVA at that version;
3. archives any open KVA at an older version, recalling its Zoho request first
   when it has one (as `resetSigning` does), since that request carries the old
   document;
4. writes one audit row for the bump and one per process opened or archived.

Nobody loses a role. A holder signed only at an older version can keep every role
they have, but cannot be granted another of the four until they re-sign.

A wording fix that is not material leaves the version alone, and nobody is asked
to sign again.

### Grandfathering current holders

A one-off data migration, run in the release that turns the grant gate on. For
every live person (not merged) holding BOARD, BG_REVIEWER, KEYHOLDER or FINANCE
at that moment, it inserts:

- a `PersonRole` row `KEY_VOLUNTEER`, with no `grantedById`;
- a `KEY_VOLUNTEER_AGREEMENT` process: status `ACTIVE`, `agreementVersion` 1,
  `contractSignedAt` and `stageEnteredAt` set to the migration time,
  `zohoSignerPersonId`, `zohoEnvelopeId` and `zohoActionId` null — the shape of a
  Board-recorded signature with no Zoho request;
- an audit row for each, under the system actor
  `migration:key-volunteer-grandfather`.

It is idempotent (it skips anyone already holding `KEY_VOLUNTEER`) and opens no
unsigned agreement, so it creates no Zoho request. It leaves no temporary UI and
no code to remove later.

It rests on @thpr's statement of 2026-10-30 that current holders are known to have
signed. The extracted rules record it as such.

### Board UI

- **Roles screen** (Membership Ops → Roles, the existing page): a "Key Volunteer"
  toggle like the other roles, Board-only. Each `KEY_VOLUNTEER` holder's row shows
  whether they have signed the current version, with the date. The other four
  toggles are disabled, with the reason, for someone who cannot be granted them
  yet. `GET /api/roles` adds the signed-version fields to its rows.
- **Membership settings:** the current KVA version, whether the document is
  configured, and a Board-only "New version (material change)" action with a
  confirmation that says how many holders will be asked to re-sign.
- **No separate list page.** The Roles screen, filtered to `KEY_VOLUNTEER`, is the
  list.

### What it does not gate

- Using any role: a board member with an outstanding re-sign can still act as
  board, and a reviewer can still review.
- Check-in, program participation, membership: none affected.

---

## Security boundary

**What does not change.** The new role kind grants nothing: it appears in no
registry `authorize` or `orderedView`, no scope binding and no nav gate, and is
not a `BusinessRole`, so `core.ts`'s role switches are untouched. `PersonRole`
stays in `OPT_OUT_PENDING_ROUTE`. `OrgMembershipProcess` gains no binding. The
Zoho webhook, `PATCH`/`GET /api/roles` and the record-by-hand route are legacy
`withAuth` routes; their changes are app code, not boundary.

**New fields** (additive annotations, which the isolation check exempts):
`OrgMembershipProcess.agreementVersion` (`internal`, like its other signing
fields) and `BoardSettings.keyVolunteerAgreementVersion` (`public`, like
`bgRecheckMonths`). `GET /api/settings/membership` returns the full row, so the
version reaches the settings page through its existing entry.

**New routes**, which the route-coverage ratchet requires to be registered and
served through `handler()`:

| Endpoint | Authorize | Returns | View |
|----------|-----------|---------|------|
| `GET /api/membership/key-volunteer` | authenticated | `KeyVolunteerSelfStatus` | `their_own:internal`, `public` |
| `POST /api/membership/key-volunteer/sign` | authenticated | `KeyVolunteerSigning` | `their_own:internal`, `public` |
| `POST /api/membership/key-volunteer/sync` | authenticated | `KeyVolunteerSelfStatus` | `their_own:internal`, `public` |
| `POST /api/settings/membership/key-volunteer-version` | `isBoardMember` | `KeyVolunteerVersionBump` | `everyones:internal`, `public` |

The three self routes return synthetic models, since the stripper drops any bag
key that is not a model. A new `keyVolunteerSyntheticClassifications.ts` defines
them, joins `CLASSIFICATION_SOURCES` in `core.ts`, and `scopeBindings.ts` binds
`their_own` on `personId` for `KeyVolunteerSelfStatus` and `KeyVolunteerSigning`.
Every field is `internal` except that binding key. The bump returns the new
version and the count opened, all `internal`; no person leaves.

## Build split

1. **Registry PR** (boundary only, based on `main`): the four `defineRoute`
   entries, the synthetic classifications file and its `CLASSIFICATION_SOURCES`
   line, the two scope bindings, and strip tests.
2. **Expand PR** (based on `main`, mergeable alongside 1): the migration adding
   the two enum values, `agreementVersion` and `keyVolunteerAgreementVersion`,
   with their annotations and regenerated classifications, and nothing that
   writes them. An old Prisma client fails reading an enum value it does not
   know, so no row may carry either value until every serving task runs a client
   that knows them. This PR is that client. It must reach production before
   PR 3 deploys.
3. **Implementation PR** (draft, based on `main`; ready once 1 has merged and 2
   is in production): the role in `roles.ts`, the `setRoleFlag` rules and route
   ordering, the process and lifecycle changes, `markContractSigned`, the signing
   entry point and the four routes, the version bump, the KVA document loader and
   config health, the Roles screen and settings UI, the self-service button, dev
   seeds that give seeded role holders `KEY_VOLUNTEER` and a signed KVA, the
   grandfathering data migration, the rules extraction into
   `docs/rules/membership.md`, and deletion of this doc. `Fixes #1317`.

The grandfathering migration must ship in the same release as the gate. Earlier
and it would write enum values an older client cannot read; later and the gate
would refuse every grant to existing holders in the meantime.

---

## Open questions

IDs are fixed; decided ones stay so earlier references still resolve.

1. **Does the KVA gate role exercise?** Decided: no — ruling (a), @thpr,
   2026-10-30: the agreement is confirmed offline, person to person, before the
   role is given. Grant-time gating (decided 2026-10-30) is the mechanism that
   checks the signature. See [What it does not gate](#what-it-does-not-gate).
2. **Is the KVA annual?** Decided: signed once, re-signed on a version bump. See
   [Versions](#versions).
3. **Does losing the roles close an open KVA?** Superseded: the four roles no
   longer open a KVA; `KEY_VOLUNTEER` does, and it cannot be removed while any of
   them is held. What happens to an open KVA when `KEY_VOLUNTEER` itself is
   removed is question 7.
4. **Which document is signed?** Decided: a KVA-specific document, which the
   Board provides; stored under `KVA_PDF_S3_KEY` in the agreement bucket. See
   [Signing](#signing).
5. **Are card holders and procurement tracked here?** Decided: no. The Board
   grants `KEY_VOLUNTEER` to whoever owes the agreement; the app records the role,
   not the reason. Supersedes the earlier Board-added list with a free-text
   reason.
6. **How does a new installation get its first board member?** Granting BOARD
   needs a signed Key Volunteer, and only the Board grants `KEY_VOLUNTEER`. An
   existing deployment is covered by grandfathering; an installation with no
   board member at all is not, and a sysadmin cannot break the loop. Open.
   Proposed: while no board member exists, a sysadmin may grant `KEY_VOLUNTEER`
   and record its signature by hand, mirroring bootstrap promotion.
7. **Removing `KEY_VOLUNTEER` while its KVA is open and unsigned.** Open.
   Proposed: the removal archives the open process in the same write, recalling
   its Zoho request if it has one, with an audit row; it is a Board act, so no
   automation removes anything.
8. **Who records a KVA signature by hand?** The record-by-hand route admits
   sysadmins as well as the Board, and the Board-only rule for KVA actions was a
   coordinator call, not an explicit @thpr decision. Open. Proposed: for a
   `KEY_VOLUNTEER_AGREEMENT` process the route refuses an actor who is not on the
   Board.

---

## Provenance

- Backlog item **RB5** (`docs/backlog/INDEX.md`)
- TOPDOWN analysis: `docs/backlog/TOPDOWN.md` lines 143, 189, 195
- GitHub issue: #1317
- Role, grant gate, grandfathering and version-bump decisions: @thpr, 2026-10-30
- Nav placement, `KVA_PDF_S3_KEY`, Board-only actions: coordinator calls,
  2026-10-30, for review
