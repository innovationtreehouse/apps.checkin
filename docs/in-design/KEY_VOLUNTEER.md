# Key Volunteer designation

## Problem

The organisation requires certain volunteers to sign an elevated agreement — the
Key Volunteer Agreement (KVA) — beyond the standard membership agreement. Policy
names two groups explicitly: every background-check reviewer
(*Membership Policy, Art. VI §VI.2*) and every board member
(*Membership Policy, Art. VI §VI.2*; `docs/rules/membership.md` assumption).

In practice, the same obligation extends to anyone carrying risk beyond the base
membership agreement — credit-card holders, complex-procurement participants,
people with access to donor PII.

The app does not know this agreement exists. Board and reviewer role grants
assume the person has already signed it, with no record and no trigger. The
assumption holds today because the population is small and personally known, but
it is invisible: a new board member's unsigned KVA is chased by memory, not by a
list.

## Objective

Everyone who owes a KVA is on one list, the **"Needs a Key Volunteer agreement"**
list, whether a role put them there or the Board did. The list shows who has
signed and who has not, and the Board works it.

## Executive summary

- **For board members, BG reviewers, keyholders and finance:** the role grant
  puts them on the list and opens a KVA obligation. They sign through the same
  Zoho Sign / mock-signing flow the membership agreement uses.
- **For anyone else who owes one** (card holders, procurement participants,
  donor-PII access): the Board adds them to the list by hand, with a reason. The
  app does not track why they owe it; card holding and procurement stay outside
  the app.
- **Signed once.** A person signs again only when the Board marks the agreement
  as materially changed, which is expected less often than yearly.
- **For the Board:** the list, alongside the existing BG-review and intake-note
  queues, and an action to close an open obligation that is no longer owed.
- **What deliberately does not change:** the KVA does not gate role exercise.
  A board member who has not yet signed can still act as board. The obligation
  is chased person to person, the same posture as the individual membership
  agreement (`PERSON_AGREEMENT`).
- **What this does not build:** procurement-tier enforcement or card-holder
  tracking. The Board supplies the KVA document itself for e-signature.

---

## Standing rules this relies on

- Every reviewer has signed the key volunteer agreement.
  — *Membership Policy, Art. VI §VI.2* (`docs/rules/membership.md` line 88)
- Every board member has signed the key volunteer agreement and is a designated
  background-check reviewer.
  — `docs/rules/membership.md` assumption (line 145)

## Standing rules this would change

The current assumption in `docs/rules/membership.md`:

> Every board member has signed the key volunteer agreement and is a designated
> background-check reviewer. Board membership alone therefore qualifies someone
> wherever a reviewer is required.

**Replacement:** the first sentence moves from assumption to procedure: the app
tracks the signature, chases it without blocking the role, and asks for it again
only when the agreement changes materially. The second sentence (board =
qualified reviewer) is unaffected.

---

## Design

### What is a Key Volunteer

A Key Volunteer is a person who carries risk beyond the base membership
agreement and is therefore required to sign the KVA. The **"Needs a Key
Volunteer agreement"** list holds everyone who owes one, from two sources:

1. **A role.** Holding any of these PersonRole kinds: BOARD, BG_REVIEWER,
   KEYHOLDER, or FINANCE. BOARD and BG_REVIEWER are named by policy;
   KEYHOLDER carries facility-access risk, and FINANCE handles card data and
   donor PII, both carrying risk beyond the base membership agreement by the
   same reasoning. Granting any of these roles opens the obligation.

2. **The Board.** A board member or sysadmin adds a person to the list for a
   reason no role captures (card holder, procurement participant, donor-PII
   access). The reason is free text, with no picklist of subtypes. The app
   does not know who holds a card or takes part in procurement; the Board does,
   and the list is where it records the result.

A person can come from both sources. They owe one agreement regardless.

### The obligation

When someone joins the list and has not signed the current version of the KVA:

- A `KEY_VOLUNTEER_AGREEMENT` process opens on `OrgMembershipProcess`, using the
  existing per-person process shape (`orgMembershipId` null, `subjectPersonId`
  set, the same as `PERSON_BG` and `PERSON_AGREEMENT`).
- The process starts at `PENDING_EXTERNAL_ACTION` and settles on signature, the
  same flow as `PERSON_AGREEMENT`.
- Signing routes through Zoho Sign (or the mock-signing interstitial in dev),
  using the Board-supplied KVA document instead of the membership agreement.

### Re-signing on a material change

The KVA is signed once. It is not renewed each membership year. A person signs
again only when the agreement itself changes materially, which is expected less
often than yearly.

The marker is a version number the Board bumps: `BoardSettings` holds the
current KVA version, and each signed process records the version it signed.
Bumping the version (alongside uploading the new document) opens a fresh
obligation for everyone currently on the list whose latest signature is for an
older version. A wording fix that is not material leaves the version alone, and
nobody is asked to sign again.

### Triggers

| Event | Action |
|-------|--------|
| BOARD, BG_REVIEWER, KEYHOLDER, or FINANCE role granted | If no signature on the current version and none open, open one |
| Board adds someone to the list | Same |
| Board bumps the KVA version | Open one for everyone on the list whose latest signature is for an older version |
| All qualifying roles revoked, not Board-added | Leaves the list; no new obligation opens. An open, unsigned one stays open (below); a signed one stays signed |
| Board closes an open obligation | The process closes unsigned, with the closer and a note in the audit log |

**Losing the roles does not close an open obligation.** The person still owes
the signature for the time they held the role, so it stays on the list until
they sign or the Board closes it. Closing is a deliberate Board action on the
list, for an obligation that is no longer owed: the person left, or was added in
error. Closing a Board-added person's obligation also takes them off the list.

### What it does not gate

- Role exercise: a board member without a signed KVA can still act as board.
- BG review: a reviewer without a signed KVA can still review.
- Check-in, program participation, membership: none affected.

An unsigned KVA is chased person to person, from the Board's list. This is the
same posture as the individual membership agreement, and for the same reason:
blocking a board member from acting until they sign defeats the purpose of
having them on the board. It is a deliberate limit, and the rule extracted at
merge says so.

### Data model

- **New enum value:** `KEY_VOLUNTEER_AGREEMENT` on `OrgMembershipProcessKind`.
- **Current version:** an integer on `BoardSettings`, starting at 1.
- **On the process:** the version signed, set at signing; and the Board's
  reason, set when the Board added the person and null when a role did. A
  non-null reason is what marks a Board-added person as still on the list after
  they sign, so a version bump reaches them too.

There is no separate designation table and no new `PersonRoleKind`. The list is
the role holders plus the Board-added processes that the Board has not closed,
which the process rows already record.

### Board UI

- **The list:** "Key Volunteer Agreements" alongside "Background Checks" and
  "Intake Notes" in the board's membership-ops navigation. One row per person
  on the list: source (role, Board, or both), the Board's reason, the version
  last signed and when, and whether an obligation is open. The nav badge counts
  open obligations. An **Add person** action (person picker plus reason) and a
  **Close** action per open obligation (with a note).
- **Person detail:** a "Key Volunteer agreement" line showing whether they are
  on the list and their signing status, linking to the list.
- **Settings:** the current KVA version, with a bump action next to the
  document upload.

### Signing flow

Reuses the Zoho Sign / mock-signing infrastructure but **not**
`resolveSigningProcess`. That function (`external.ts:293`) selects the
household INITIAL/RENEWAL process for leads and the PERSON_AGREEMENT for
non-leads — a board member who is a household lead would never reach a KVA
through it.

The KVA needs its own entry point — a dedicated action that resolves the
caller's open `KEY_VOLUNTEER_AGREEMENT` process directly, bypassing the
household/individual agreement resolver. The signing ceremony itself (Zoho
`createRequest` → `submitRequest` → embedded sign URL → callback/sync) is
the same; only the process-selection and the uploaded PDF differ.

**Flow:**

1. Person clicks "Sign Key Volunteer Agreement" (on their dashboard or from the
   board queue). This action queries for the caller's open
   `KEY_VOLUNTEER_AGREEMENT` process — it never falls through to
   `resolveSigningProcess`.
2. App uploads the KVA PDF to Zoho Sign (or routes to the mock interstitial in
   dev) and stores the envelope/action IDs on the process.
3. Zoho callback (or mock completion) flips the process to `ACTIVE`.
4. The signed envelope ID is stored on the process (`zohoEnvelopeId`,
   `zohoActionId`), same as membership agreements.

**Template configuration:** the KVA PDF is a separate document from the
membership agreement. The membership agreement PDF is loaded from S3
(`AGREEMENT_PDF_S3_BUCKET`); the KVA PDF follows the same pattern — a separate
S3 object (e.g. `key-volunteer-agreement.pdf`) loaded by the KVA signing action.
Zoho credentials and API config are shared (env vars); only the uploaded document
differs. If the KVA PDF is not uploaded to S3, the signing action is unavailable
and the queue shows "agreement not configured."

---

## Open questions

None remain. IDs are kept so earlier references still resolve.

1. **Does the KVA gate role exercise?** Decided: no. See
   [What it does not gate](#what-it-does-not-gate).
2. **Is the KVA annual?** Decided: signed once, re-signed on a material change.
   See [Re-signing on a material change](#re-signing-on-a-material-change).
3. **Does losing the roles close an open KVA?** Decided: no; the Board closes it.
   See [Triggers](#triggers).
4. **Which document is signed?** Decided: a KVA-specific document, which the
   Board provides for e-signature. See [Signing flow](#signing-flow).
5. **Are card holders and procurement tracked here?** Decided: no. The Board adds
   whoever owes an agreement to the list. See
   [What is a Key Volunteer](#what-is-a-key-volunteer).

---

## Provenance

- Backlog item **RB5** (`docs/backlog/INDEX.md`)
- TOPDOWN analysis: `docs/backlog/TOPDOWN.md` lines 143, 189, 195
- GitHub issue: #1317
