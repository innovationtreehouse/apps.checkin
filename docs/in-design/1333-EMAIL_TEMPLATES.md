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

A single line break inside a paragraph is a line break (`<br>`), and a paragraph that is empty
after token substitution is dropped. Today's HTML maps onto plain text like this:

- **A heading** becomes the first paragraph. Emoji stay, as text; the heading size and colour go.
- **Bold** is dropped. The words stay.
- **A line that appears only sometimes** (the check-in "📍 via badge scan" line) is a text token
  the code fills, or leaves empty.
- **Wording that differs between variants** (checked in / checked out) is a text token the code
  fills. When the variants differ in a whole sentence or subject, each variant gets its own key
  (`membership.welcome` / `membership.renewed`).
- **A list** is a text token the code fills with one item per line; **a count** is a text token.
- **A link inside a sentence** keeps its place as a link token with its fixed label ("You can
  manage it {{actionLink}}." with the label "here"). Where today's link text is the URL itself,
  the token has no label and shows the URL. The post-event button becomes a plain link.
- **HTML a caller builds** (the Shopify error intros, the attendance-flag detail) is an escaped
  text token; those callers pass plain text from step 4 on.

### 3. Token registry — `src/lib/email-templates/registry.ts`

The registry is the **only** per-key code. It holds the *contract* for each key and its
default copy; a Board override lives in the DB. The token types and the substitution functions
sit beside it in `src/lib/email-templates/tokens.ts`:

```ts
type TokenKind = "text" | "link";
interface TokenSpec { kind: TokenKind; label?: string } // label: anchor text for link tokens
interface TemplateSpec {
  allowedTokens: Record<string, TokenSpec>;
  sampleCtx: Record<string, string>;   // powers the admin preview
  defaultSubject: string;              // today's copy; sent when no row exists
  defaultBody: string;                 // today's copy; sent when no row exists
}
export const REGISTRY: Record<string, TemplateSpec> = { ... }
```

- `text` tokens are **HTML-escaped** and inserted as text — **in the body only**. The
  **subject** is not HTML; it substitutes tokens **raw/unescaped** (see §4), so "Arts & Crafts"
  and "O'Brien" arrive intact. (Escaping a subject is the existing outreach wart at
  `outreach/render.ts:76` — this design fixes it rather than generalizing it to every flow.)
- `link` tokens render as `<a href="{value}">{label}</a>` — the URL is a system value in the
  send `ctx`, the anchor label lives in the registry. The editor places `{{actionLink}}` in the
  body; they never type a URL or an `<a>`, and the label is not editable (D-2 below).
- Save-time validation rejects any `{{token}}` not in the key's `allowedTokens`
  (generalizes the existing `findUnknownTokens`).

### 4. Render + send — one door, `sendTemplated`

```
sendTemplated(key, to, ctx, headers?) → Promise<boolean> {
  row   = EmailTemplate[key]  ?? REGISTRY[key].{defaultSubject,defaultBody}   // never blank
  subj  = substitute(row.subject, ctx, REGISTRY[key], { escape: false })      // RAW — subject isn't HTML
  body  = substitute(row.body,    ctx, REGISTRY[key], { escape: true }) → split blank lines → <p>
  html  = baseEmailLayout(body)                                               // branding for free
  return sendEmail(to, subj, html, headers)                                   // existing choke-point, returns boolean
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

### 6. Never-blank guarantee — registry defaults are today's copy

- Each registry entry's `defaultSubject`/`defaultBody` is the **exact current** subject/body.
- The table starts **empty**. A row exists only once the Board saves an override, and
  `sendTemplated` sends the registry default whenever a row is missing or blank.
- Result: the sweep is **copy-neutral** — no email's wording changes. Editing is an override,
  not a requirement.
- No migration seeds rows: the registry is the one copy of the default wording, and a
  wording fix in code reaches every un-edited email without a data migration. (Rows seeded
  from code would be a second copy that overrides the registry, so later fixes would not
  ship.)

### 7. The sweep — one conversion, no partial state

Migrate every flow to `sendTemplated` in a single pass. Because the registry defaults == current copy, the
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

## Key list (47)

45 keys are in the registry. The 2 `outreach.*` keys join it in step 5, because outreach has
no default copy in code today (the Board writes it, and it is empty until they do).
`link` tokens are noted; everything else is `text`. Tokens are named after the words they
stand for in today's copy, so a key without a link today has no `actionLink`.

### checkin and attendance — 4
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `checkin.receipt` | `sendCheckinNotifications` participant (`checkinReceiptTemplate`) | participant | name, emoji, visitWord, action, date, time, via |
| `checkin.householdMember` | `sendCheckinNotifications` household leads (`householdMemberTemplate`) | household lead | leadName, memberName, emoji, arrivalWord, action, date, time, via |
| `attendance.selfCorrectionFlag` | significant visit edit/delete (`attendance/manual/[id]`) | board | scope, change, visitId, actorName, verb, whose, score, detail |
| `attendance.keyholderHandover` | last keyholder names a successor (`keyholderGuard`) | named keyholder | leaverName, when, peopleInside |

> Resolved (flag A): `sendNotification` CHECKIN/CHECKOUT is **dead** — test-only, no prod
> caller. The live check-in mail is the first two rows above. No `checkin.notify`/`checkout.notify`
> keys. No separate `checkin.leadAlert` — the lead notice *is* `checkin.householdMember`.
> `emoji`, `visitWord`/`arrivalWord` and `action` carry the check-in/check-out wording; `via` is
> the "📍 via badge scan" line, empty when the source is unknown.

### programs — 7
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `enrollment.confirm` | `sendNotification` PROGRAM_ENROLLMENT (`participants/route.ts`) | family | name, programName |
| `program.assignment` | `sendNotification` PROGRAM_ASSIGNMENT (`programs/route.ts`) | lead mentor | programName, `actionLink` ("here") |
| `program.announced` | `notifyNewProgramAnnounced` | families | name, programName |
| `event.postEvent` | `postEventTemplate` | lead mentor / core volunteer | eventName, rsvpCount, checkinCount, `actionLink` ("Review & Confirm Attendance") |
| `participant.pendingWarning.day1` | pending-participants cron, day 1 | family | programName |
| `participant.pendingWarning.day3` | pending-participants cron, day 3 | family | programName |
| `participant.pendingWarning.day6` | pending-participants cron, day 6 | family | programName |

> `program.assignment` migrates the **already-shipped** `programAssignmentTemplate` (#1220),
> which links to `/program-ops/programs/{programId}`. The default body keeps that link as
> `{{actionLink}}`, so the lead welcome email doesn't lose it.
> The three pending warnings share a body and differ only in subject, which escalates by day;
> each is its own key so the Board can edit each subject.

### membership — 5
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `membership.reviewNeeded` | `notifyReviewers` | review team | `actionLink` (shows the URL) |
| `membership.paymentOpen` | `notifyPaymentOpen` | family | `actionLink` (shows the URL) |
| `membership.paymentOpenExistingCheck` | `notifyPaymentOpenOnExistingCheck` | family | `actionLink` (shows the URL) |
| `membership.welcome` | `sendCongrats`, first membership | family | `actionLink` ("Visit your dashboard") |
| `membership.renewed` | `sendCongrats`, renewal | family | `actionLink` ("Visit your dashboard") |

### board — 5
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `board.paidReject` | `notifyBoardPaidReject` | board | processId, `actionLink` ("Open applications") |
| `board.paymentException` | `notifyBoardPaymentException` | board | kind, **blurb**, exceptionId, `actionLink` ("Open payment problems") |
| `board.pendingDigest` | pending-participants digest | board | approachingCount, overdueCount, approachingList, overdueList |
| `board.unpaidClaims` | program sale sweep | board | programName, names, `actionLink` ("Open the program") |
| `board.programAgeMisfit` | program date/age edit (`programs/update.ts`) | board | programName, count, people, `actionLink` ("Open the program") |

> See sub-decision B (blurb) below.

### finance — 8
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `finance.receiptMailCeiling` | receipt mail intake hits its hold ceiling | FINANCE, else board | unresolved, refused, `actionLink` ("Open the incoming receipt queue") |
| `finance.incomePostCap` | income run stops at its per-run cap | FINANCE, else board | created, limit, remaining, `actionLink` ("Open income reconciliation") |
| `finance.receiptMailAgeing` | receipt mail run leaves messages unread past the window | FINANCE, else board | messages, since, `actionLink` ("Open the incoming receipt queue") |
| `finance.incomeBucketUnusable` | a budget-owner bucket can't take sales | FINANCE, else board | bucketName, issue, itemCount, `actionLink` ("Open income items") |
| `finance.incomeSweepIncomplete` | income orphan sweep reads a full page | FINANCE, else board | since, `actionLink` ("Open income reconciliation") |
| `finance.expensePaymentAccount` | books-map payment account can't post | FINANCE, else board | accountId, accountKind, `actionLink` ("Open the books map") |
| `finance.expenseSweepIncomplete` | expense orphan sweep reads a full page | FINANCE, else board | since, `actionLink` ("Open expenses") |
| `finance.inKindSweepIncomplete` | in-kind orphan sweep reads a full page | FINANCE, else board | since, `actionLink` ("Open the in-kind queue") |

### receipt — 2
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `receipt.mailReplyCredited` | `sendMailReply`, the person a mailed receipt is credited to | credited person | creditedName, from, when, `actionLink` ("Review it in My receipts") |
| `receipt.mailReplySender` | `sendMailReply`, a sender whose receipt is credited to someone else | sender | when, creditedName |

> Both carry the `Auto-Submitted: auto-replied` header, which is why `sendTemplated` takes optional
> headers.

### shopify — 1
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `shopify.error` | `reportShopifyFailure` (Shopify writes, sale sweep, lifecycle drift) | board/sysadmin | intro, errorDetail |

> `intro` is the caller's one-line description of what failed. The callers pass it as plain
> text from step 4 on (today it is HTML with `<strong>`).

### trustedAdult — 8 (flag C, fully spelled out — no "resolve at build")
| key | trigger (`service.ts`) | recipient | tokens |
|-----|------------------------|-----------|--------|
| `trustedAdult.boardReview` | `notifyBoard` | board | `actionLink` ("Review it") |
| `trustedAdult.requestInfo` | REQUEST_INFO | family | note, `actionLink` |
| `trustedAdult.deniedRevoked` | DENY + `revokePriorApprovals` | family | adultName, `actionLink` |
| `trustedAdult.changeNotApproved` | DENY, prior approval survives | family | adultName, until, `actionLink` |
| `trustedAdult.notApproved` | DENY, nothing survives | family | adultName, `actionLink` |
| `trustedAdult.overrideDecided` | `overrideReview` deny/revoke | family | adultName, action, `actionLink` |
| `trustedAdult.expiring` | `runExpirySweep` warning | family | deadline, `actionLink` |
| `trustedAdult.expired` | `runExpirySweep` lapse, adult left unauthorized | family | adultName, `actionLink` |

> `deniedRevoked` (from the normal decide path) and `overrideDecided` (from the
> sysadmin override path) share a subject but keep **separate keys** — different code paths,
> different bodies (`overrideDecided` carries an `{{action}}` = denied/revoked token). Deliberately
> not merged: collapsing them is exactly the "resolve at build" shortcut we're avoiding.
> The "View your trusted adults" link that `notifyHouseholdFamily` appends today is the
> `{{actionLink}}` token (label "View your trusted adults") in each family template.
> `until` is " (valid until YYYY-MM-DD)", or empty when the approval has no end date.

### scholarship — 5 (flag D: folded in from `BoardSettings`)
| key | trigger | recipient | tokens |
|-----|---------|-----------|--------|
| `scholarship.membershipReview` | membership request-payment-plan | review team | householdId, requestKind, `actionLink` (shows the URL) |
| `scholarship.programReview` | program request-payment-plan | review team | personName, programName, requestKind, `actionLink` (shows the URL) |
| `scholarship.ackMembership` | `sendScholarshipAck` membership (was `DEFAULT_ACK_MEMBERSHIP_BODY`) | family | — |
| `scholarship.ackProgram` | `sendScholarshipAck` program (was `DEFAULT_ACK_PROGRAM_BODY`) | family | programName |
| `scholarship.ackProgramHoldFailed` | program request whose Shopify seat hold failed | family | — |

> Fold detail: the ACK copy currently lives in `BoardSettings.scholarshipAck{Subject,Membership
> Body,ProgramBody}` and is edited on `settings/email`. The sweep migrates those values into the
> two `scholarship.ack*` rows and moves editing to the new tab. The three `BoardSettings` columns
> + their `settings/email` controls are **dropped in the follow-up contract release** (build
> order step 8), not here — old pods still read them during the drain. The three
> `scholarship.ack*` subjects are the same at the start; each key owns its own subject going
> forward. Until step 4 the ACK defaults stay in `scholarshipAckCopy.ts` and the registry
> imports them, so the default wording exists in one place.

### outreach — 2 (flag D: folded in from `BoardSettings`; joins the registry in step 5)
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
The reconciler maps each exception kind (15 today) to a one-line human description
(`PAID_WHILE_BLOCKED → "a household paid but its application is blocked…"`, etc.). Those
descriptions stay in code (`EXCEPTION_BLURB` in `membership/boardAlerts.ts`), and the send fills
`{{blurb}}` from them. There is one `board.paymentException` row, and the
editable copy is the sentence around `{{blurb}}`. The descriptions are reconciliation
diagnostics rather than board-tuned copy, so changing one is a code change and a deploy.

The alternative, B-2, was one key per kind (`board.paymentException.PAID_WHILE_BLOCKED`, …), each
fully board-editable. It cost a near-identical row, seed and admin-UI list entry per kind for one
flow, for copy the board does not need to tune.

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

1. `EmailTemplate` model + migration (creates the empty table; no seed, see §6).
2. `registry.ts` (37 specs, whose defaults are today's copy; outreach waits for step 5) + per-key
   `substituteTokens`/`findUnknownTokens` in `email-templates/tokens.ts`. No send path changes;
   `outreach/tokens.ts` and its two consumers move in step 5 with the outreach copy.
3. `sendTemplated` + generalized `renderAckBody`-style body→`<p>` (single newline → `<br>`, empty
   paragraph dropped) + `baseEmailLayout` wrap.
4. Sweep all call sites to `sendTemplated`; delete inline builders + hardcoded subjects.
5. Fold outreach + scholarship — **expand only**: migrate `BoardSettings` copy → rows, update
   render wrappers + both preview consumers to read from `EmailTemplate`. **Leave the old
   `BoardSettings` columns in place and still populated** this release. Add the two
   `outreach.*` registry entries here; their default wording is a Board decision.
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
