# Email Templates — deploy-free email content

**Status:** approved (merged in #1334), ready to build. Its sub-decisions are settled below.
**Goal:** change any email's subject/body *without* a code change or deploy, and make it
structurally impossible to ship an email that bypasses the shared template + branding.

## Problem (as it stands today)

- **The shared layout is used by 3 of ~20 flows.** `baseEmailLayout` wraps only checkin,
  household, and post-event. Everything else (`membership/*`, `trusted-adult/*`, scholarship,
  shopify-error, cron warnings, `notifications.ts`) assembles `<p>...</p>` by hand at each
  call site with no branded shell. A new flow has to *remember* to use the wrapper — nothing
  enforces it, so drift is the default.
- **Subjects and body copy are hardcoded in `.ts` files.** Rewording "Welcome to Treehouse"
  is a code edit, PR, and deploy.
- **Two deploy-free systems already exist** and prove the pattern works here:
  - **Outreach** — subject/body in `BoardSettings`, `{{token}}` substitution
    (`src/lib/outreach/`), edited at `settings/outreach`.
  - **Scholarship ACK** — subject/body in `BoardSettings`, edited at `settings/email`
    (`scholarshipAckCopy.ts`, `renderAckBody`).

This design **generalizes those two into one system** that every email goes through.

## Design

### 1. Storage — `EmailTemplate` table

One row per email type, keyed by a stable string `key`:

| column      | notes                                                   |
|-------------|---------------------------------------------------------|
| `key`       | unique, e.g. `membership.congrats` (see registry below) |
| `subject`   | token string                                            |
| `body`      | **plain text**; blank line = paragraph                  |
| `updatedBy` | Person id, audit                                        |
| `updatedAt` | audit                                                   |

Editing a row changes the live email — **no deploy**. Single global set (no multi-tenant, no
per-board override — confirmed out of scope).

### 2. Body is plain-text-with-tokens, never raw HTML

Editors (board members) write plain text. `blank line = new paragraph`. The HTML shell,
branding, and links come from code, not the editor. This is exactly today's `renderAckBody`
contract, and it is the whole XSS/broken-markup safety story: **there is no HTML-authoring
surface**, so a non-dev editor cannot inject markup or break the layout. (See the sandboxed
`<iframe>` preview history noted in `scholarshipAckCopy.ts` — this design avoids that class of
problem by construction.)

### 3. Token registry — `src/lib/email-templates/registry.ts`

The registry is the **only** per-key code. It does not hold copy (copy is in the DB); it holds
the *contract* for each key:

```ts
type TokenKind = "text" | "link";
interface TokenSpec { kind: TokenKind; label?: string } // label: anchor text for link tokens
interface TemplateSpec {
  allowedTokens: Record<string, TokenSpec>;
  sampleCtx: Record<string, string>;   // powers the admin preview
  defaultSubject: string;              // seed + never-blank fallback
  defaultBody: string;                 // seed + never-blank fallback
}
export const REGISTRY: Record<string, TemplateSpec> = { ... }
```

- `text` tokens are **HTML-escaped** and inserted as text — **in the body only**. The
  **subject** is not HTML; it substitutes tokens **raw/unescaped** (see §4), so "Arts & Crafts"
  and "O'Brien" arrive intact. (Escaping a subject is the existing outreach wart at
  `outreach/render.ts:76` — this design fixes it rather than generalizing it to all 27 flows.)
- `link` tokens render as `<a href="{value}">{label}</a>` — the URL is a system value in the
  send `ctx`, the anchor label lives in the registry. The editor places `{{actionLink}}` in the
  body; they never type a URL or an `<a>`, and the label is not editable (D-2 below).
- Save-time validation rejects any `{{token}}` not in the key's `allowedTokens`
  (generalizes the existing `findUnknownTokens`).

### 4. Render + send — one door, `sendTemplated`

```
sendTemplated(key, to, ctx) → Promise<boolean> {
  row   = EmailTemplate[key]  ?? REGISTRY[key].{defaultSubject,defaultBody}   // never blank
  subj  = substitute(row.subject, ctx, REGISTRY[key], { escape: false })      // RAW — subject isn't HTML
  body  = substitute(row.body,    ctx, REGISTRY[key], { escape: true }) → split blank lines → <p>
  html  = baseEmailLayout(body)                                               // branding for free
  return sendEmail(to, subj, html)                                            // existing choke-point, returns boolean
}
```

`substituteTokens` / `findUnknownTokens` change from a **fixed 4-token global switch** to
**registry-driven per-key** substitution over a `Record<string,string>` ctx, with an `escape`
flag (body escapes, subject does not). Both existing consumers (outreach server render +
`settings/outreach` client preview, and the scholarship preview) are updated to the new
signature as part of the sweep (see §7).

**Preference gate + retry contract (do NOT swallow into `sendTemplated`).** `sendNotification`
today does two things beyond building copy: (a) checks the recipient's opt-out
(`notificationSettings.email !== false`, plus per-flow flags like `emailCheckinReceipts`,
`emailDependentCheckins`, `notifyNewPrograms`), and (b) returns a **boolean** its callers branch
on for retry (`participants/route.ts:148`, `programs/route.ts:241`). Those pref checks are
per-flow and recipient-specific, so they **stay at the call sites** — `sendTemplated` only owns
copy→render→send. `sendTemplated` **returns the `sendEmail` boolean** so the retry contract is
preserved; a caller must still gate on preferences before calling it. The enforcement test
(§5) checks the door; it does **not** relieve callers of the opt-out check. Losing either (a)
or (b) in the sweep = opted-out members get emailed / failed sends stop retrying — an explicit
non-goal.

### 5. Enforcement — the template is the only path

- `sendTemplated` is the public API. The raw-HTML `sendEmail(to, subject, html)` becomes
  internal to `email.ts` + the renderer.
- **One grep-to-zero test** asserts no `sendEmail(` call exists outside `email.ts` and the
  renderer. A new flow physically cannot ship inline copy — it won't pass CI.

### 6. Never-blank guarantee — seeds are today's copy

- The migration seeds every `key` with the **exact current** subject/body.
- `sendTemplated` falls back to the registry default if a row is missing or blank.
- Result: the sweep is **copy-neutral** — no email's wording changes. Editing is an override,
  not a requirement.

### 7. The sweep — one conversion, no partial state

Migrate all ~27 flows to `sendTemplated` in a single pass. Because seeds == current copy, the
diff is behavior-neutral on wording. The old inline builders and hardcoded subjects are
**deleted**, not left beside the new path. Folds the two existing deploy-free systems in too
(see D). After the sweep there is exactly one way to send mail.

### 8. Admin UI — new Settings tab, board-gated

- New top tab **"Email Templates"** in `SettingsTabs` (`src/components/admin/SettingsTabs.tsx`),
  route `src/app/settings/templates/page.tsx`. The `settings` layout already admits
  board + sysadmin; the page self-gates `useRequireRole(["isSysadmin","isBoardMember"])`
  like its siblings.
- List keys (grouped by prefix) → edit subject + body → **live preview** rendered from
  `sampleCtx` (client-side, reusing the shared substitute fn so preview can't drift from send)
  → save (token-validated) → optional **send-to-self** (reuse the outreach test-send pattern).

## Key list (27)

Grouped by prefix. `link` tokens noted; everything else is `text`.

### checkin (attendance) — 2
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `checkin.receipt` | `sendCheckinNotifications` participant (`checkinReceiptTemplate`) | participant | name, action, date, time |
| `checkin.householdMember` | `sendCheckinNotifications` household leads (`householdMemberTemplate`) | household lead | leadName, memberName, action, date, time |

> Resolved (flag A): `sendNotification` CHECKIN/CHECKOUT is **dead** — test-only, no prod
> caller. The live check-in mail is the two rows above. No `checkin.notify`/`checkout.notify`
> keys. No separate `checkin.leadAlert` — the lead notice *is* `checkin.householdMember`.

### notifications — 3
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `enrollment.confirm` | `sendNotification` PROGRAM_ENROLLMENT (`participants/route.ts:148`) | family | name, programName |
| `program.assignment` | `sendNotification` PROGRAM_ASSIGNMENT (`programs/route.ts:241`) | lead mentor | programName, `actionLink` |
| `program.announced` | `notifyNewProgramAnnounced` | families | name, programName, `actionLink` |

> `program.assignment` migrates the **already-shipped** `programAssignmentTemplate` (#1220,
> `email-templates/program-assignment.ts`), which renders a `manageUrl` link
> (`/program-ops/programs/{programId}`). That link is **required** — the seed body must include
> the `{{actionLink}}` token so the sweep doesn't regress #1220's lead welcome email down to a
> link-less version. (An earlier draft of this doc called PROGRAM_ASSIGNMENT a live "System
> Action" bug — that was stale: #1220 fixed it on `main` before this design; the row above
> mirrors the shipped template.)

### post-event — 1
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `event.postEvent` | `postEventTemplate` | attendees | eventName, `actionLink` |

### membership — 3
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `membership.reviewNeeded` | `notifyReviewers` | review team | applicantName, `actionLink` |
| `membership.paymentOpen` | `notifyPaymentOpen` | family | `actionLink`, deadline |
| `membership.congrats` | `sendCongrats` | family | householdName, `actionLink` |

### board — 3
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `board.paidReject` | `notifyBoardPaidReject` | board | processId, `actionLink` |
| `board.paymentException` | `notifyBoardPaymentException` | board | kind, **blurb**, exceptionId, `actionLink` |
| `board.pendingDigest` | pending-participants digest | board | listItems, `actionLink` |

> See sub-decision B (blurb) below.

### participant — 1
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `participant.pendingWarning` | pending-participants warning | family | participantName, deadline |

### shopify — 1
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `shopify.error` | `reportShopifyFailure` | board/sysadmin | errorDetail, `actionLink` |

### trustedAdult — 7 (flag C, fully spelled out — no "resolve at build")
| key | trigger (`service.ts`) | recipient | tokens |
|-----|------------------------|-----------|--------|
| `trustedAdult.boardReview` | `notifyBoard` :580 | board | `actionLink` |
| `trustedAdult.requestInfo` | REQUEST_INFO :421 | family | note, `actionLink` |
| `trustedAdult.deniedRevoked` | DENY + `revokePriorApprovals` :429 | family | adultName, `actionLink` |
| `trustedAdult.changeNotApproved` | DENY, prior approval survives :442 | family | adultName, until, `actionLink` |
| `trustedAdult.notApproved` | DENY, nothing survives :448 | family | adultName, `actionLink` |
| `trustedAdult.overrideDecided` | `overrideReview` deny/revoke :521 | family | adultName, action, `actionLink` |
| `trustedAdult.expiring` | `runExpirySweep` :545 | family | deadline, `actionLink` |

> `deniedRevoked` (:429, from the normal decide path) and `overrideDecided` (:521, from the
> sysadmin override path) share a subject but keep **separate keys** — different code paths,
> different bodies (`overrideDecided` carries an `{{action}}` = denied/revoked token). Deliberately
> not merged: collapsing them is exactly the "resolve at build" shortcut we're avoiding.
> The static `<a>View your trusted adults</a>` footer that `notifyHouseholdFamily` appends
> today becomes the `{{actionLink}}` token in each family template.

### scholarship — 4 (flag D: folded in from `BoardSettings`)
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `scholarship.membershipReview` | membership request-payment-plan | review team | applicantName, `actionLink` |
| `scholarship.programReview` | program request-payment-plan | review team | applicantName, programName, `actionLink` |
| `scholarship.ackMembership` | `sendScholarshipAck` membership (was `DEFAULT_ACK_MEMBERSHIP_BODY`) | family | — |
| `scholarship.ackProgram` | `sendScholarshipAck` program (was `DEFAULT_ACK_PROGRAM_BODY`) | family | programName |

> Fold detail: the ACK copy currently lives in `BoardSettings.scholarshipAck{Subject,Membership
> Body,ProgramBody}` and is edited on `settings/email`. The sweep migrates those values into the
> two `scholarship.ack*` rows and moves editing to the new tab. The three `BoardSettings` columns
> + their `settings/email` controls are **dropped in the follow-up contract release** (build
> order step 8), not here — old pods still read them during the drain. The
> `scholarship.ackProgram` subject == `scholarship.ackMembership` subject at seed
> time; each row owns its own subject field going forward.

### outreach — 2 (flag D: folded in from `BoardSettings`)
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `outreach.opening` | outreach batch opening (was `outreachOpening{Subject,Body}`) | prospects | name, deadline, actionWord, `actionLink` |
| `outreach.reminder` | outreach reminder (was `outreachReminder{Subject,Body}`) | prospects | name, deadline, actionWord, `actionLink` |

> Fold detail: outreach carries extra machinery the transactional flows don't — join/renew
> **variants**, a conditional **unsubscribe footer** appended after substitution, and a
> boundary-derived `{{deadline}}`. That render *wrapper* (`renderOutreachEmail`) stays; only the
> **source of subject/body** moves from `BoardSettings` columns to the two `outreach.*` rows.
> The unsubscribe footer and variant `actionWord` remain outreach-specific ctx, not editor-facing
> copy. The four `outreach*` `BoardSettings` columns + the `settings/outreach` page are removed in
> the follow-up contract release (step 8), not here. Its sandboxed-iframe preview is superseded by
> the plain-text preview (no HTML authoring → no iframe needed).

## Sub-decisions

**B — `board.paymentException` blurb: B-1, a `{{blurb}}` token with the blurbs in code.**
The reconciler maps 11 exception kinds to a one-line human description
(`PAID_WHILE_BLOCKED → "a household paid but its application is blocked…"`, etc.). Those 11
descriptions stay in the registry, in code. There is one `board.paymentException` row, and the
editable copy is the sentence around `{{blurb}}`. The descriptions are reconciliation
diagnostics rather than board-tuned copy, so changing one is a code change and a deploy.

The alternative, B-2, was 11 keys (`board.paymentException.PAID_WHILE_BLOCKED`, …), each fully
board-editable. It cost 11 near-identical rows for one flow, 11 extra seeds and 11 list entries
in the admin UI, for copy the board does not need to tune.

**D-2 — link anchor label: fixed in code with its link.**
Link tokens render as `<a href="{url}">{label}</a>`. The URL is a runtime ctx value; the
**label** ("Review application", "Open payment problems", "View your trusted adults") is fixed
per key in the registry, next to the destination it names. The editor cannot change it, so a
link cannot be mislabelled; changing a label is a code change. The alternative, a third
editable field on the row, was not taken.

**Layout: every email gets the branded layout.**
Today ~17 flows send bare `<p>` with **no** `baseEmailLayout`. Routing everything through
`sendTemplated` wraps them all in the branded shell, and no flow stays plain. Copy is
unchanged, but the *visual shell* gains a header and footer for those flows, so the sweep is
not a zero-visual-change one. Uniform branding is a stated goal of this work.

## Build order

1. `EmailTemplate` model + migration (RENAME-safe; seed all 27 keys from current copy).
2. `registry.ts` (27 specs) + generalize `substituteTokens`/`findUnknownTokens` to per-key.
3. `sendTemplated` + generalized `renderAckBody`-style body→`<p>` + `baseEmailLayout` wrap.
4. Sweep all call sites to `sendTemplated`; delete inline builders + hardcoded subjects.
5. Fold outreach + scholarship — **expand only**: migrate `BoardSettings` copy → rows, update
   render wrappers + both preview consumers to read from `EmailTemplate`. **Leave the old
   `BoardSettings` columns in place and still populated** this release.
6. Grep-to-zero enforcement test (`sendEmail(` only in `email.ts` + renderer).
7. Admin tab: `settings/templates` page + API route (list/get/save + validate + send-to-self),
   add `"templates"` to `SettingsTabs`.
8. **Follow-up release (contract): drop the moved `BoardSettings` columns + old
   `settings/email`/`settings/outreach` controls** — only after step 5 has fully deployed and
   the drain window has passed. Per `DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`: during a rolling
   deploy, old pods keep selecting those columns (`scholarshipEmails.ts`, `api/settings/email`,
   the settings page, `outreach/render.ts`), so dropping them in the same release as the sweep
   500s every scholarship-ack and outreach send/preview mid-drain. The DROP is a separate PR.

## Explicitly out of scope

Multi-tenant / per-board overrides · rich HTML or markdown bodies · editor-authored links/URLs ·
scheduling/queuing changes (uses the existing `runPaced`/`sendEmail` path).
