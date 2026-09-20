# Cutover: the membership year a settlement buys is stated, not inferred

Everything here expires when the change has run. The design is in
`1655_MEMBERSHIP_YEAR_DECLARED.md`.

## Decisions owed before building

Most decisions are settled (see the design's
[Decisions](1655_MEMBERSHIP_YEAR_DECLARED.md#decisions-previously-open)): one year
per settlement (`appliesToYear` is a single integer), no proration in software,
overlap races resolve to the shorter grant, refunds/wrong-year are handled by
people, misconfigured variants flow to the unmatched-payment path, and the variant
mapping is a `MembershipYearVariant` table (one row per year).

**One owner decision is owed before step 4:** which year's variant a *new INITIAL*
checkout link sells inside the renewal-window overlap (`ensurePaymentLink` builds
one link; the year it sells is the year the webhook will stamp). See the design's
[Open questions](1655_MEMBERSHIP_YEAR_DECLARED.md#open-questions). The rest below
are build-time mechanics.

This design targets the post-#1812 reader model (coverage follows the live
membership year via `membershipYearCycle` / `coveredThrough`; `settledThisCycleWhere`
carries a paid-awaiting-BG `OR` arm). If #1655 lands before #1812, re-base step 6
on whatever shape is then on `main`.

Still unknown, and only production can say: how many legacy processes the
backfill (step 5) cannot resolve. It leaves those `appliesToYear` null; the year
readers treat null as "not settled for the live cycle", so they read exactly as
today.

## Sequence

**Expand only for the drain window.** A nullable integer column added to
`OrgMembershipProcess`, tier `@sensitivity:public`. Old code ignores it for the
whole rolling-deploy drain window, so the schema is safe against the previous
release still serving traffic.

1. **Schema:** add `appliesToYear Int?` to `OrgMembershipProcess` with its
   sensitivity annotation. Add the `MembershipYearVariant` table (one row per
   year, keyed by the opening-year integer), and keep
   `BoardSettings.orgMembershipVariantId`
   in place for now — it is the current year's row until the reconcilers move.
   Regenerate `src/security/generated/classifications.ts`.

2. **Stamp on the Shopify path:** in the paid webhook /
   `activateByProcessId` (`src/app/api/webhooks/shopify/route.ts`,
   `src/lib/membership/payment.ts`), look the membership line-item variant up in
   the mapping and write `appliesToYear` as the process activates. A membership
   order whose variant is in no year's mapping is surfaced via the existing
   unmatched-payment path, not stamped with a guess.

3. **Stamp on the grant path, and unify the grant buttons:** `grantRenewalPayment`
   → `activate` and the certify-payment-plan path write `appliesToYear` — auto
   outside the overlap, board's answer required inside. Then fold the two grant
   buttons on `src/app/membership-ops/households/page.tsx` (and their two branches
   in `POST /api/membership-ops/households`) into one "Grant membership" that
   always settles through a process carrying the year: the `active: true` blunt
   status flip and the season-only `comingYear: true` override become one path.
   The current-vs-coming select shows only inside the overlap, and always requires
   a certification reason. On a concurrent grant inside the overlap the shorter
   (current-year) grant wins — the coming-year stamp yields to a current-year
   settlement rather than overwriting it.

   The `active: true` branch today upserts `OrgMembership.status = ACTIVE` with no
   process. It can express only "current year" and cannot grant the coming year at
   all — the reason the second button exists. It must route through the settlement
   path (or be disabled) once the year readers land; left as a bare status flip it
   both blocks the merge and leaves grants with no uniform year-bearing record. See
   the design's grant section for the full breakage.

4. **Checkout builds from the per-year variant:** the membership checkout link
   (`ensurePaymentLink` / `buildMembershipCheckoutUrl` in
   `src/lib/membership/payment.ts`) selects the variant for the year being sold,
   and **fails closed** (surfaced, not a silent dead end) when that year's row is
   absent. For a new INITIAL in the overlap, "the year being sold" is the owner
   decision above.

   Do **not** seed real `MembershipYearVariant` rows: per
   `checkin-app/docs/designs/SHOPIFY_DEV_STORE_WEBHOOK.md` O4, variant ids are
   per-environment config with no placeholder seed (a seeded id fails the real
   store's variant-match guard). Instead, the local/flow mock path already resolves
   `DEV_MOCK_MEMBERSHIP_VARIANT_ID` (`src/app/api/dev/shopify/orders-paid/route.ts`);
   map that mock variant to the **live year** (`membershipYearCycle(...).cycleStart`
   year) so mock checkout and the flow tests stamp a coherent `appliesToYear`
   without a seeded row. Real environments get their rows from the one-time manual
   setup O4 describes, not the seed.

4a. **Renewal-sweep hard stop:** `runRenewalSweep` in
    `src/lib/membership/renewal.ts` gains a second early return alongside its
    existing no-boundary guard: with no coming-year `MembershipYearVariant` row it
    opens nothing and returns a reason. A renewal opened with no product to pay
    through is worse than one not opened.

4b. **Settings surface + misconfig pill:** the membership settings page
    (`src/app/settings/membership/page.tsx`) renders the variant rows for the
    in-play years only — current and coming, derived from the boundary, past years
    filtered out (rows retained). The coming-year row renders as an empty,
    fillable slot with a red "needs variant" badge until set, and the
    `settingsMisconfig` count in `src/app/api/nav/todo-counts/route.ts` includes
    the missing coming-year variant so the nav pill flags it months ahead.

5. **Backfill (one-time, run against production after the column exists):** for
   every `OrgMembershipProcess` whose year today's logic can decide, compute the
   membership year its `stageEnteredAt` fell into — the year
   `settledThisCycleWhere` matches it as settled for today — and write
   `appliesToYear`. Leave it null where the logic cannot decide (e.g. a row with
   no `stageEnteredAt`, or an off-diagram legacy row). It sets nothing it cannot
   derive. This **freezes today's answer** for every already-decided row — no live
   horizon moves at cutover, including the handful of leaked summer INITIALs, which
   read afterwards exactly as they read before. The leak is closed going forward by
   the variant→year stamp, not retroactively. Correcting historical leaked INITIALs
   (deriving from `paidAt`, which moves live horizons) is an optional separate pass
   the owner can call for; the default is freeze.

6. **Switch the readers** (only after step 5 has populated production):
   - `settledThisCycleWhere` / `handledThisCycleWhere` in
     `src/lib/membership/lifecycle.ts`: replace the `stageEnteredAt: { gte:
     settledSince }` clause with `appliesToYear: liveYear`, **keeping the `OR`
     arm** (`{status:"ACTIVE"}` OR `{status:{in:["PENDING_BG_CLEARANCE"]},
     paidAt:{not:null}}`) and, for `handledThisCycleWhere`, its `ARCHIVED`
     addition. The signatures take a year, not a `settledSince` date.
   - The three readers pass `liveYear =
     membershipYearCycle(boundary, now).cycleStart.getUTCFullYear()` instead of
     `cycle.settledSince`:
     `src/app/api/membership-ops/households/route.ts` (both call sites; leave
     `coveredThrough`/`validUntil` and `settledForComingYear` as-is — they consume
     the probe result), `src/lib/orgMembership.ts` (`membershipValidThrough`),
     `src/lib/membership/renewal.ts` (`runRenewalSweep` skip-test). Confirm all
     three move together — the design's invariant is that they stay in lock-step.
   - Tests: `src/lib/membership/__tests__/lifecycle.test.ts` (the `settledThisCycleWhere`
     / `handledThisCycleWhere` `toEqual`s — now the `OR` + `stageEnteredAt` shape —
     rewrite to `OR` + `appliesToYear`; `membershipYearCycle`/`coveredThrough`
     assertions are untouched), `src/lib/membership/__tests__/renewal.test.ts` (the
     sweep assertion), `src/app/__tests__/householdsListGrantableAPI.integration.test.ts`
     (including #1812's bare-grant and paid-awaiting-BG cases), and check
     `src/__tests__/lifecycleStatusLiteralAllowlist.test.ts`.

7. **Move the reconcilers to the variant set** (#625 / #1293 / #1349): every
   reader of `orgMembershipVariantId` as a scalar switches to "any membership
   year's variant": `src/lib/finance/reconcile.ts`, `src/lib/finance/matchAudit.ts`,
   `src/app/api/settings/membership/route.ts`,
   `src/app/api/nav/todo-counts/route.ts`,
   `src/app/api/dev/shopify/orders-paid/route.ts`, and the settings UI
   (`src/app/settings/membership/page.tsx`). Missing one leaves a reconciler that
   matches only the old single variant — a silent undercount. Grep
   `orgMembershipVariantId` repo-wide and drive it to zero (or to only the
   backward-compat shim, if one is kept for the drain window).

## Left alone deliberately

`personAgreementTriggers.ts`'s local `handledThisCycleWhere(personId, floor)`
shares only the function name. It dedups the adult-child yearly-agreement trigger
on `stageEnteredAt ≥ floor`; a signature satisfying a cycle is not a settlement
buying a year, so it keeps its floor and is not touched.

The paid-awaiting-BG arm inside `settledThisCycleWhere` (#1812's
`{status:{in:["PENDING_BG_CLEARANCE"]}, paidAt:{not:null}}`, the shape
`duesSettledAwaitingBg` also expresses) **stays**. #1812 moved it inside the cycle
probe as settled money; this design keeps it and only swaps the date clause beside
it for the year clause. Do not remove it or treat it as a separate horizon — that
would reverse #1812.

`stageEnteredAt` stays on the model. It is the lifecycle machine's stage-timing
field, read by classify/validate and the transition diagram; this design only
stops *the two cycle probes* from keying coverage off it. Do not drop it.

The display/parse helpers already exist — `membershipYearCycle` (produces the
`2026-2027` label, `settledSince`, `cycleStart`, `cycleEnd`) and
`membershipYearCycleForLabel` (parses `2026-2027` back; its test rejects short
forms) in `src/lib/membership/renewal.ts`. Reuse them; do **not** add a
`formatMembershipYear`/`membershipYearOf` pair. The opening-year key is
`membershipYearCycle(...).cycleStart.getUTCFullYear()`; the human label is
`.label`. The prisma-free `nextBoundary` / `landsNextYear` / `memberYearStarts` in
`src/lib/programYear.ts` remain the client-safe boundary helpers. Storage is the
integer key; the `2026-2027` span is never stored.

## Contract stage, later

Once the backfill and normal settlement have populated `appliesToYear` on every
process that could carry one — an operations event, not a deploy — the null
readers can tighten and, if desired, the column can go NOT NULL. Neither is in
this change. Retiring `BoardSettings.orgMembershipVariantId` entirely (once every
reader is on the mapping) is likewise a later contract-stage removal, a
destructive column drop that waits for the drain window on step 7.

## Ordering against other work

**#1484 / `PROGRAM_MEMBERSHIP_YEAR`** shares the representation and the boundary
helpers. If both land, share one `appliesToYear` naming and one set of year/
boundary helpers rather than writing the boundary math twice. Neither blocks the
other; coordinate the helper so it is authored once.

**Unified signup (#1370 stack)** consumes program coverage; once this lands, its
member-pricing term reads "a settlement exists with `appliesToYear` = the
program's `appliesToYear`" rather than a date overlap.

## Destination: `docs/rules/membership.md`

#1812 adds a Renewal bullet — "Coverage is what was bought, not what the calendar
says…" — that states the coverage *policy* (settled ⇒ covered to the closing
boundary; unsettled ⇒ lapsed at the opening one; a membership with no dues recorded
has bought nothing). **That bullet stays.** This design does not change it; it
changes only the *mechanism* by which "settled for the year in effect" is
determined — from a `stageEnteredAt` window to a recorded `appliesToYear`.

**Replace** the older Renewal bullet that begins "Settling inside the renewal
window buys the coming membership year…" with:

```markdown
- A membership settlement records the membership year it buys, and coverage,
  the renewal sweep's skip-test, and program-pricing coverage all read that
  recorded year. A family that buys the coming year — joining (INITIAL) or
  renewing — is covered through the following boundary and is not asked to renew
  the year it just bought; a family that buys the current year is asked to renew
  on the normal schedule. The year is not inferred from when a stage completed.
  [Decision]
```

This sits directly under #1812's "Coverage is what was bought" bullet as the
mechanism beneath that policy — the two are consistent, not competing.

**Insert** under Dues (near the grant/comp rules):

```markdown
- A board grant or comp records which membership year it settles. Where the date
  makes the year unambiguous the app fills it in; inside the renewal-window
  overlap, where both the current and coming year are plausible, the board states
  which. [Decision]
```

Nothing about the column, the variant mapping, the webhook stamp, the backfill,
or the reader reshape goes into the rules file — that is all mechanism.

The shared `appliesToYear` representation with the program year is a code fact, so
nothing extra goes in `membership.md` for it. Note that `docs/rules/programs.md`
does **not** yet carry a program-year rule on `main` — that rule arrives with the
`PROGRAM_MEMBERSHIP_YEAR` proposal's own merge, not this one; do not assume it is
already there.

## Last step

Apply the blocks above, delete both files in this directory.
