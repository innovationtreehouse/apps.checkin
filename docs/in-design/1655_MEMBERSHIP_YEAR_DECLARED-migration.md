# Cutover: the membership year a settlement buys is stated, not inferred

Everything here expires when the change has run. The design is in
`1655_MEMBERSHIP_YEAR_DECLARED.md`.

## Where it stands

Nothing is built. There is no year column on the settlement record and no per-year
variant table; the coverage probes still infer the year from `stageEnteredAt`; and
the single variant id `BoardSettings.orgMembershipVariantId` is read in eight
production files. The prerequisites have landed: coverage follows the live
membership year (#1812), and both board grants pay a real application through
`certifyPaymentPlan` (#2003), so no grant is a bare status change any more.

Ten pull requests finish this. The owner has answered every question; one PR waits
on an operations step in production (the board entering variants).

## Decisions settled

Stable IDs; a resolved question is marked in place, never renumbered.

- **`MY-0` (resolved):** this design and the program year (`Program.appliesToYear`)
  describe one membership-year rule. They share the field name `appliesToYear`, the
  opening-year integer, and the helpers in `checkin-app/src/lib/programYear.ts`.
- **`MY-1` (resolved):** from the day the renewal window opens, a joining family's
  checkout sells the coming year, the same as a renewal's.
- **`MY-2` (resolved):** no correction of existing rows. The fill freezes the year
  today's rule already reads; the board corrects any family by hand.
- One year per settlement; no multi-year purchase.
- No proration in the app; a partial year's price is a Shopify discount.
- Refunds and a wrong year are handled by people. Nothing auto-unwinds a refunded
  settlement or re-opens a skipped renewal.
- An order whose variant is in no year's row settles nothing and goes to the board,
  as an order without the membership product does today.
- **`MY-3` (resolved): which year does a board grant record?** The year on the
  button pressed. The two grant buttons stay, and each names its year ("Grant
  2026-2027"), computed from the year in progress and the coming year, never
  written into the page. Inside the renewal window both show to any household with
  an application awaiting payment, joining or renewing; outside it only the year in
  progress shows. There is no separate prompt and no year chosen for the Board. Two
  grants on one application at once: the row lock lets the first settle, and the
  second is told it is already paid.

Only production can say how many paid rows the fill cannot place (no
`stageEnteredAt`); PR 3 leaves them empty and its run reports the count.

## Build plan

Order: **1 → 2 → 3 → 4**, then **5**, then **6 → 7 → 8 → 9**, then **10**. The
fix families feel lands at PR 4. The per-year catalogue (6–9) can start any time
after PR 2, and PR 5 any time after PR 2, but none of them is built while another
edits the same file.

This differs from building the catalogue first. Until the board has per-year
variants, PR 2 maps the existing single variant to the live year at payment time.
That is already the fix: the year is fixed when the family pays, not when review
finishes. Building in this order delivers it without waiting on the board to set up
Shopify products.

### PR 1: schema expand [mig]

- **Files:** `checkin-app/prisma/schema.prisma`: `appliesToYear Int?` on
  `OrgMembershipProcess` (`/// @sensitivity:public`); new model
  `MembershipYearVariant` (`membershipYear Int @id`, `shopifyVariantId String
  @unique` and `productUrl String?`, both `/// @sensitivity:internal`). One new
  migration: `ALTER TABLE "OrgMembershipProcess" ADD COLUMN "appliesToYear"
  INTEGER;` and the `CREATE TABLE` with its unique index. Regenerated
  `checkin-app/src/security/generated/classifications.ts`.
- **Tests:** full `npm run test:ci`. The classification drift tests are the net, and
  a new model can trip security oracles that count models; a narrowed run hides
  that.
- **Migration safety:** additive; the old release ignores both for the whole drain
  window. The regenerated classifications are a pure addition, which the
  boundary-isolation check accepts beside a schema change.
- **Blocked on:** nothing.

### PR 2: stamp the year on every payment [app]

- **Files:**
  - `checkin-app/src/lib/membership/payment.ts`: `settle` takes `appliesToYear:
    number | null` and writes it in the same update as `paidAt` on the move out of
    `PENDING_PAYMENT`; the `BLOCKED` branch writes none. `activateByProcessId`
    takes the year instead of `hasMembershipItem` (no year means no membership
    item). `certifyPaymentPlan` takes an optional year and records it; without
    one it records the live year
    (`membershipYearCycle(boundary, now).cycleStart.getUTCFullYear()`, null when no
    boundary is set). Until PR 5 every caller passes none.
  - `checkin-app/src/lib/finance/reconcile/membership.ts`:
    `membershipVariantIdSet` becomes a variant-to-year map read from
    `MembershipYearVariant`, plus two transitional entries: the
    `BoardSettings.orgMembershipVariantId` variant, when no row claims it, mapped
    to the live year at the order's paid time; and the dev mock variant, when the
    mock is active, mapped to the live year. Its reconciler call site passes the
    year.
  - `checkin-app/src/app/api/webhooks/shopify/route.ts`: looks up the order's
    membership line in the map and passes the year.
  - `checkin-app/src/lib/finance/matchAudit.ts`: uses the map's keys.
- **Tests:** unit and integration. The map adds a `membershipYearVariant` query to a
  shared library, so every test that mocks prisma for the webhook, the reconciler or
  the match audit without it fails at runtime with tsc green; run the full
  `npm run test:ci`, then the integration suites for
  `webhookShopify`, `membershipPaymentAPI`, `reconcile`,
  `api/dev/shopify/orders-paid` and the grant paths (a heavy run). New cases: a
  June payment cleared after the window opens keeps June's year; each of the four
  board paths stamps the live year; an unmapped variant is `no_item`.
- **Migration safety:** no schema change. During the drain the old release settles
  payments with no year; PR 3 fills them.
- **Blocked on:** PR 1.

### PR 3: fill existing rows [mig]

- **Files:** one migration, wrapped in `BEGIN;`/`COMMIT;` with the block marked for
  extraction. It sets `appliesToYear` on every `INITIAL` or `RENEWAL` process that
  has none, has a `stageEnteredAt`, and is `ACTIVE` or (`PENDING_BG_CLEARANCE` with
  `paidAt` set). The year is the one whose renewal-window start is on or before
  `stageEnteredAt` and whose next window start is after it, reading the boundary
  month and day from `BoardSettings`: add two months to `stageEnteredAt` and take
  the membership year that date falls in. It does nothing when no boundary is set.
  Archived rows get no year; the sweep keeps reading their date (design, "What the
  readers become").
- **Tests:** an integration test (heavy) that extracts the block, runs it twice, and
  checks each row's year against `membershipYearCycleForLabel` for every day of a
  sample year, so the SQL month arithmetic and the TypeScript cannot drift; rows
  with no `stageEnteredAt` stay empty; the second run changes nothing.
- **Migration safety:** updates only empty rows; idempotent. It must deploy in a
  release after PR 2 is deployed, so the rows the old release settled during PR 2's
  drain are filled.
- **Blocked on:** PR 2 deployed.

### PR 4: the readers switch to the year [app]

- **Files:**
  - `checkin-app/src/lib/membership/lifecycle.ts`: `settledThisCycleWhere(liveYear)`
    and `handledThisCycleWhere(liveYear, windowStart)` as in the design; delete the
    `KNOWN LIMIT` note and the comments that describe the date test.
  - Callers pass the live year: `checkin-app/src/app/api/membership-ops/households/route.ts`
    (detail and list), `membershipValidThrough` in `checkin-app/src/lib/orgMembership.ts`,
    `checkin-app/src/lib/outreach/recipients.ts`, `runRenewalSweep` in
    `checkin-app/src/lib/membership/renewal.ts`.
  - `checkin-app/src/app/api/people/search/route.ts`: the year picklist count and
    the badge roster filter compare `appliesToYear` with the label's opening year
    instead of a `stageEnteredAt` range. The `MAX_DATE` sentinel there and in the
    callers above goes where nothing else reads it.
- **Rules:** applies the Renewal block in [Destination](#destination-docsrulesmembershipmd).
- **Tests:** unit for the fragments (`lifecycle.test.ts`, `renewal.test.ts`), then
  integration (heavy) for every suite whose fixtures make a paid process settled by
  its `stageEnteredAt`: `householdsListGrantableAPI`, `membershipArchiveAPI`,
  `membershipBulkRenewalAPI`, `membershipRenewalAPI`, `peopleSearchRoster`,
  `programAnnounceRecipients`, `programDiscountCodeAPI`, `programsIdAPI`,
  `api/outreach/recipients`, plus `src/lib/__tests__/orgMembership.test.ts` and
  `src/security/__tests__/payment-plans-strip.test.ts`. Re-run the grep for
  `stageEnteredAt` in test files across all three test roots before building; the
  list moves.
- **Migration safety:** no schema change. Before merging, run in production: count
  the paid `INITIAL`/`RENEWAL` rows with no year whose `stageEnteredAt` is inside
  the live year's window. It must be zero, or those households lose coverage at
  deploy.
- **Blocked on:** PR 3 run in production and the count above.

### PR 5: grant buttons name their year [app]

- **Files:**
  - `membershipYearOf(boundary, date)` and `membershipYearLabel(year)` already
    exist in `checkin-app/src/lib/programYear.ts`; reuse them.
  - `checkin-app/src/lib/membership/grant.ts`: `grantCurrentYear` becomes
    `grantMembership(householdId, actor, year)` and passes the year to
    `certifyPaymentPlan`. It already pays an in-flight renewal as well as a joining
    application, so one function serves both buttons.
  - `checkin-app/src/lib/membership/renewal.ts`: delete `grantRenewalPayment`,
    which the shared function covers.
  - `checkin-app/src/lib/membership/lifecycle.ts`: the `grantRenewalPayment`
    transition row becomes the grant's; `grantableRenewalWhere` widens to "an
    application awaiting payment, joining or renewing", which the list route's
    probe uses to show the coming-year button. Regenerate
    `checkin-app/docs/generated/lifecycle/membership.md`.
  - `checkin-app/src/app/api/membership-ops/households/route.ts`: the list response
    carries the years a grant may record now, each with its label (the year in
    progress; inside the window, the coming year too). `POST` takes `year` and
    refuses any year not in that set. The two flag branches become one.
  - `checkin-app/src/app/membership-ops/households/page.tsx`: the two buttons,
    labelled "Grant" plus the year's label from the response, shown as in the
    design; each posts its year.
- **Rules:** applies the grant line in the Destination.
- **Tests:** unit for the helpers at the boundary day, `lifecycle.test.ts` and the
  page test (labels and which buttons show, in and out of the window); integration
  (heavy): `householdsListGrantableAPI`, `householdsMembershipAuditAPI` and the
  grant suites, including a renewal granted for the year in progress, a joining
  application granted for the coming year, a refused year, and two concurrent
  grants on one application.
- **Migration safety:** none in the schema. The old release's page posts
  `active: true` or `comingYear: true` during the drain; keep accepting them for
  one release as the year in progress and the coming year, or accept that a board
  click in those minutes returns an error.
- **Blocked on:** PR 2.

### PR 6: registry entry for the variant rows [security boundary]

- **Files:** `checkin-app/src/security/registry.ts`: add `'MembershipYearVariant'`
  to the `returns` of `GET /api/settings/membership`. Nothing else; it ships alone
  under the boundary-isolation rule, based on `main`, not stacked.
- **Tests:** unit `npm run test:ci` (registry and strip tests).
- **Migration safety:** none; inert until PR 7 returns the rows.
- **Blocked on:** PR 1.

### PR 7: settings slots and the nav count [app]

- **Files:**
  - `checkin-app/src/app/api/settings/membership/route.ts`: `GET` returns the rows
    for the year in progress and the coming year; `PUT` upserts a row by year, with
    the same numeric check the single variant has, and refuses a variant another
    year already holds.
  - `checkin-app/src/app/settings/membership/page.tsx`: the two slots, labelled
    `2026-2027`; an empty coming-year slot shows the red badge; the "extract
    variant from URL" control works per slot.
  - `checkin-app/src/lib/nav/todoCounts.ts`: the misconfiguration count adds one
    when the coming year has no row.
- **Tests:** unit for the route, the page
  (`src/app/settings/membership/__tests__/page.test.tsx`) and the count.
- **Migration safety:** none.
- **Blocked on:** PR 6.

### PR 8: checkout sells the live year [app]

- **Files:**
  - `ensurePaymentLink` in `checkin-app/src/lib/membership/payment.ts`: the variant
    is the live year's row; with the mock active and no row, the mock variant; with
    neither, a null link.
  - `checkin-app/src/app/api/dev/shopify/orders-paid/route.ts`: same choice of
    variant.
  - `checkin-app/src/app/dev/shopify/page.tsx`: "has a variant" reads the live
    year's row.
  - `checkin-app/src/lib/nav/todoCounts.ts`: the single-variant term becomes "the
    live year has no row".
- **Tests:** integration (`membershipPaymentAPI`, `api/dev/shopify/orders-paid`),
  then the flow suite (`npm run test:flow:standalone`, heavy), since every
  membership flow pays through the mock checkout.
- **Migration safety:** none in the schema. Operationally, links disappear for any
  environment whose live year has no row: before deploying, the board enters the
  live year's row in dev and production (it may reuse the existing variant id).
- **Blocked on:** PR 7, and the rows entered.

### PR 9: renewals stop without a coming-year variant [app]

- **Files:** `runRenewalSweep` in `checkin-app/src/lib/membership/renewal.ts`: a
  second early return when the coming year has no row, with a reason naming it.
- **Rules:** applies the sweep line in the Destination, then confirms every block
  there is in `docs/rules/membership.md`.
- **Tests:** unit (`renewal.test.ts`) and integration (`membershipBulkRenewalAPI`).
- **Migration safety:** none.
- **Blocked on:** PR 8.

### PR 10: retire the single variant [mig, contract]

- **Files:** drop `BoardSettings.orgMembershipVariantId` and
  `orgMembershipProductUrl` from the schema and in a migration; remove the
  transitional single-variant entry from the map (PR 2), the fields from the
  settings route and page, and every test that sets them; regenerate
  classifications. Grep `orgMembershipVariantId` and `orgMembershipProductUrl`
  repo-wide to zero.
- **Tests:** full `npm run test:ci`, integration (heavy).
- **Migration safety:** destructive; a separate, later release, after PR 8 has
  drained. A family paying through a link issued before PR 8 settles nothing after
  this lands and goes to the board; confirm first that no such process is still
  awaiting payment. If the boundary-isolation check flags the removed
  classifications, follow the decommission shape in
  `checkin-app/docs/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md` rule 7.
- **Rules:** none; then the Last step below.
- **Blocked on:** PR 9 deployed and drained.

## Ordering against other work

**Program year (`Program.appliesToYear`, #1484).** Shipped. Program pricing needs
no extra step from this plan: its horizon comparison reads `membershipValidThrough`,
which PR 4 moves to the recorded year.

**Unified signup (#1370).** Its member test should be the same horizon comparison,
not equality between a settlement's year and the program's (design, "Program
pricing needs nothing new").

## Destination: `docs/rules/membership.md`

**Replace** the Renewal line beginning "Settling inside the renewal window buys the
coming membership year" with (PR 4):

```markdown
- A membership payment or grant records the one membership year it buys, and
  coverage, the renewal sweep and member pricing read that recorded year. A
  checkout offered from the day the renewal window opens sells the coming year, to
  a family joining exactly as to one renewing; a background check clearing later
  never changes the year bought.  [Decision]
```

**Insert** under Dues, after the line on certifying a payment plan (PR 5):

```markdown
- A board grant records the membership year the Board chooses: the year in
  progress, or, inside the renewal window, the coming year. Each grant control
  names the year it records.  [Decision]
```

**Insert** under Renewal, after the line on when renewals open (PR 9):

```markdown
- Renewals do not open while the coming year has no membership product to pay
  through.  [Decision — *Principle: an unconfigured setting does not act*]
```

Nothing about the column, the variant table, the fill or the reader fragments goes
into the rules file.

## Last step

In PR 10: confirm every block above is in `docs/rules/membership.md`, then delete
both files in this directory.
