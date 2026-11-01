# Claim first: the app owns all program seats

Design for the Board's 2026-10-27 decision on whether the store should sell program seats: "try this design: a seat must first be claimed in the app, and seats are hidden in the store." The refund ruling of the same day is folded in: a refund flags the enrollment for a person and never removes a child.

Code read at `main` `8f77baf1c`. Paths are under `checkin-app/src/`. No code, no PR, no model run, and no production data was read.

Updated with the owner's rulings: a seat freed by a Board removal goes back on sale; unpaid claims never return seats on their own; everyone needs a Google account; the trial covers all programs in a narrow time window.

## The design in short

1. The public store item is taken off the store (Shopify status draft, the call `setProgramProductOffSale` already makes). The hidden reserved-seat item stays and takes every payment.
2. The app's count of enrollment rows is the only count. It already gates every claim (`lockProgramAndCheckCapacity`, `program/capacity.ts:41`). Shopify stock stops being written and nothing replaces it.
3. Claims work as they do now. There is no new expiry clock and no new state. The one app change a shopper sees is that signing in returns them to the program.
4. The trial is one Board switch and a guard in the stock writer, for all programs, in a narrow window. Turning it off at the end is an expected step, not a failure: stock is re-counted from rows the app is still stamping, with programs mid-sale at both ends.
5. Nothing is deleted during the window. If the Board later keeps the design, about 850 of the 1,015 lines in `shopify/stock.ts` go, plus two Board screens, one enrollment state and nine columns.

The refund change ships first and does not depend on the trial.

## 1. The public item

**Decision: removed from the store, by setting it to draft. It is not deleted.**

| Option | Result | Why or why not |
|---|---|---|
| Draft (chosen) | The store page and old cart links stop working. | The Board said "hidden". The code exists and is retried until Shopify confirms (`hideEndedProducts`, `saleSweep.ts:55`). Draft keeps the item for old orders and for reversal. |
| Listed but unbuyable | Stock 0 shows "Sold out". A real pointer to the app needs a store theme edit. | "Sold out" is false while seats are open. An uncapped item has no stock to zero, so it stays buyable. The Board's earlier option text said "visible for information", but its ruling says hidden. |
| Deleted | Same as draft for a shopper. | It can't be undone, and turn-off would have to re-create items. |

**How a store shopper reaches the app:**

- One store menu link, "Programs", goes to the app's `/programs`. A person adds it at the start of the window and removes it at the end.
- A redirect is added only for an item the Board knows is linked from somewhere else, such as a newsletter, because every redirect is hand work at both ends of a short window. It goes from the old `/products/<handle>` path to the program's page, or `/programs` for a members-only program that is not publicly visible. An anonymous visitor to that hidden program's page is told it doesn't exist (`docs/rules/programs.md:389`), so it would be a dead end.
- Items created after the switch are never public, so they need no redirect.

Redirects by hand avoid a new Shopify permission, and the count of live programs is small.

**To confirm on the dev store:** Shopify documents a redirect target as a full outside URL. I found nothing that says a redirect fires on a draft item's path. If it doesn't, the menu link is the only route and an old link shows the store's "not found" page. The design still works.

**The hidden item is not locked.** Anyone with the link can buy it, and its id is in the public program list (owner accepted, 2026-10-12). So "nothing is bought first in the store" is true for shoppers, not for someone deliberately using the link. Such an order seats nobody and goes to a person, as the rules already say (`programs.md:297-301`). It no longer costs a seat, because no stock exists to take.

## 2. Who owns the count

**Decision: the app alone.**

- **Reserved-seat item:** already untracked, and never sells out (#2023).
- **Public item:** its leftover stock number is frozen and nobody reads it.
- **Carry, lease, parked writes, daily stock heal:** replaced by nothing. They exist to keep a second count in step, and there is no second count. A manual Shopify edit can no longer matter.
- **The planned drift check:** no longer needed; there is nothing to compare.

The daily `reconcile-shopify` job stays. It still recovers missed payments, raises reversals and runs the sale sweep. Only its `healProgramStock` step goes.

A scholarship request's seat is already counted: a PENDING row counts in `ENROLLED_PARTICIPANT` (`person/filters.ts:18`). "Hold" therefore stops meaning anything, and "the hold failed" can no longer happen.

| Today's rule | With claim first |
|---|---|
| Never enrolls beyond capacity, except a confirmed Board override | Unchanged; same lock |
| Overfill holds the store at 0 and keeps a shortfall owed | Gone; an overfilled program just refuses claims until it has room |
| Off-sale date stops new claims; families who claimed can still pay | Unchanged. The check is on the claim route (`participants/route.ts:123`), and the hidden item stays up |
| After the off-sale date no seat goes back on sale | True by construction, since claims are refused |
| Board reopens a sale by moving the date, which resets stock | Moving the date is enough; no reset |
| Price change goes to both items | Unchanged. A draft item taking a price is harmless and keeps turn-off clean |

## 3. Claims

**Who can claim: the same people as now.** Every existing check stays (`participants/route.ts:116-165`).

- **Non-members:** may claim any program not marked members only, and pay full price. A household whose fee covers the program gets the member discount code as today.
- **People with no account:** sign in with Google and go through the existing intake panel. Registration already works this way, and a public workshop still asks for no membership agreement or mailing address.
- **People with no Google account:** Google is the sign-in system, so they need one (owner ruling). Nothing is built for them, and this design has no by-hand path for them.
- **Youth:** still enrolled by a household lead. The store never checked this; the app does.

Nothing that worked is lost for walk-up buyers: a store purchase has never enrolled anyone. It only ever produced an order for the Board to match by hand. What goes is taking money from someone with no account.

**One fix is needed.** An anonymous shopper who presses Enroll is sent to `/` and loses the program (`useProgramEnrollment.ts:181`, also `:202` and `:257`). They must go to `/signin?callbackUrl=/programs/<id>`, which the sign-in page already honors. Without this fix the redirect from the store is a dead end. Open PR #2804 changes first sign-in, so it may need rebasing.

**How long a claim lasts: with no automatic end (owner ruling: people talk to people).** Automating it may come someday, not soon. The owner confirmed on 2026-11-01 that production runs no grace period and no automation removes a family, so the grace sweep does nothing there; its code goes after a keep. A family denied after a failed hold goes back on the unpaid reminders and the Board digest, which makes the scheduling check below more important. The rules say overdue is a classification, not an action (`programs.md:164`), and the warnings at days 1, 3 and 6, the Board digest and the off-sale reminder all stay. Check that `cron/pending-participants` is actually scheduled: its schedule lives outside this repo, and an earlier note says only two jobs were scheduled. If it isn't, nobody is being warned, which matters more under this design.

The new cost is that an unpaid claim now really does block the last seat from everyone, where before a store buyer could overtake it. That is the point of the decision, and section 6 measures it.

**Path to payment: the existing one.** Claim, then server-signed checkout, then cart link to the reserved-seat item, then the paid-order webhook, then activation. An unpaid family can return and pay at any time. Payment-plan requests, approval and denial are unchanged apart from taking no stock.

One predicate has to change. `isProgramCheckoutBroken` (`programCheckout.ts:30`) looks only at the public variant. With the store closed it must require the reserved-seat variant, because `checkoutVariantId` would otherwise fall back to a draft item nobody can pay for. The `PROGRAM_CHECKOUT_BROKEN_WHERE` half and the nav count change with it. The refusal already exists (`participants/route.ts:184`).

## 4. Cutover

Before the switch, in order:

1. **Confirm the hidden item works by cart link.** #2023 left this to an owner test plan, and I found no recorded result. Real paid orders on a reserved-seat variant in production would prove it. If it fails, the fallback is a draft-order invoice per claim (recommendation.md §9, option B), and this design stops until that is built.
2. **Give every unfinished paid program a reserved-seat item**, using the existing **Sync to Shopify** button. The switch refuses to hide an item without one, as the sale sweep does.
3. **Clear store buyers who hold no row.** They hold money and a store unit, but the app counts no seat for them, so the app could sell that seat twice. The Board runs the match audit (`finance/matchAudit.ts`) and gives each unclaimed paid order a place or a refund. This is the one piece of cutover that needs people.

At the switch and after:

| What | What happens |
|---|---|
| Programs on sale now | The switch hides each public item at once, and the daily sweep retries any failure. Enrollment stays open in the app. |
| Enrolled and claimed families | Nothing changes. Their rows stand, and the app already checks out on the hidden item. |
| Paid public orders, past and in flight | Still honored. `programVariantIds` keeps matching both variants, so `shopifyVariantId` and `shopifyProductId` stay for good, as do income mapping (`income/appItems.ts:22`) and the audit. A paid webhook arriving late for a claim activates normally; one with no claim goes to the Board. |
| Refund on an old public order | Flagged only. Shopify may raise a draft item's stock, which nobody can buy. |
| Stock in Shopify | Left alone. Zeroing it adds calls and helps nothing. |
| Owed carry, pending and parked writes | Frozen, not settled. The re-count at turn-off resolves them; the contract step drops them. |
| Scholarship rows, including failed holds | Stay as they are. The hold-failed queue stops growing. A person clears what is left before the contract step (see "Clearing rows before the state merge" below). |

### Clearing rows before the state merge

Rollout step 6 stops looking at `inventoryHeldAt`, which changes how two kinds of existing row are read:

| Row today | Who sees it today | After the merge | Risk |
|---|---|---|---|
| Hold failed: PENDING, no hold, request flag set, no denial | Holds queue | An ordinary request | None; it joins the payment-plan queue |
| **Denied with no hold:** PENDING, no hold, no request flag, denial stamped (invariant I4 broken) | Only the nightly report; `classify()` returns null | "Denied" | **If a grace period were ever set, the grace sweep would delete the enrollment on its first run when the denial is older than that period.** Its filter requires a hold today (`cron/scholarship-grace-expiry/route.ts:38`). Production runs no grace period, so the risk is latent until the sweep is removed. Either way, these rows sit in no queue and nobody is reminded about them |

The second kind is what the holds screen's deny-without-a-hold button writes today (proposal: "denying a scholarship request whose seat hold failed"). The fix is settled (owner ruling, 2026-11-01) but not shipped: denying a hold-failed request returns the row to unpaid and keeps the denial in the audit log, and the normal deny refuses a hold-failed row. A row denied after the fix stays unpaid through the state merge. Only rows written before the fix need the clearing step.

Before step 6, in order:

1. A person clears the hold-failed queue. Until the fix ships, "clear" must not mean pressing that deny button, because it writes the second kind of row.
2. A person resolves every denied-with-no-hold row, using the nightly `lifecycle-reconcile` report or a production query: keep the family on the normal path, or remove them with a stated decision.
3. **Gate:** step 6 does not merge until `scanLifecycleViolations` reports no enrollment violations in production. Other off-diagram rows have the same problem: the merged states would name them without anyone having looked.

That proposal's step 0 and step 2 here are the same work, done once.

## 5. Refunds

The new rule: **every refund, chargeback and cancellation is raised for the Board and removes nobody.** Only the Board removes a paid place, with a written reason (existing rule).

**This ships first, on its own.** The smallest change is in `removeRefundedEnrollment` (`finance/reconcile/reversals.ts:325`). The branch for an ACTIVE row deletes nothing and returns 1, so the restocked seat is taken back off sale by the code already below it (`:296`). While the store is open the seat stays off sale, and the child who still holds it can't be oversold. The rules at `revenue.md:110-127` and transition T10 change with it.

The refunded child keeps the seat until the Board acts, which can block a full program. The ruling accepts that. A family who wants to stay after a refund is removed and re-enrolled; I added no "keep the place, pay again" path.

| Path | During the trial | After the Board keeps it |
|---|---|---|
| Raise for the Board: webhook and daily pass | Stays | Stays |
| Reversal ledger; a refunded order never activates | Stays | Stays |
| Under-seated order raised, nobody removed | Stays | Stays |
| Board removes a paid place | Stays; the freed seat goes back on sale in the app at once | Stays |
| Withdraw or remove a comped, approved or held seat: +1 | Runs, writes no stock | Gone; the row leaving frees the seat |
| Restock take-backs, after-sale take-back, restock records, once-only settlement | Run, write no stock | Gone. Audit rows already written stay |
| Test-order give-back and its refund | Runs, writes no stock | Gone. A test order still activates nobody |
| Refund nudge against a shortfall | Does nothing | Gone |

**A rule that changes (owner ruling).** When the Board removes a paid place, the seat goes back on sale: the row leaving makes it claimable in the app at once. The Board member doing the removal is the person deciding, and can lower capacity in the same visit. This replaces `programs.md:190` while the store is closed. Outside the window the store-open behaviour is unchanged, and the re-count at turn-off gives that seat back to the store anyway.

**What goes away, by construction, once stock is gone:**

| Known problem | Source |
|---|---|
| The store sells a seat a family has claimed | findings 10-25, F1 |
| A take-back cancels against owed stock, leaving a seat on sale after the date | N1 |
| A refunded test order puts one seat too many on sale | N3 |
| A store sale between read and write takes stock to −1 | findings §4.4 |
| A crash loses a capacity edit's stock change | crash limit, findings 4.5 |
| Failed holds, deny on a failed hold, relying on a person to edit Shopify | P3, P12, P13, Q9 |
| Stale read, lost capacity update, capacity cut racing enrollment, uncapped holds | P2, P11, P14, P25, P26 |
| Paid place withdrawn leaves a unit lost (`keptUnits`) | accepted low, 10-25 |
| Partial restock on sale twice; re-arm forgetting outside stock; failed activation stock change | ledger review 3, 10, 11 |

**What does not go away:**

- A refund recorded during activation still activates (N2). Open PR #2913 fixes it; keep that PR.
- A refund Shopify hasn't reported yet can still activate. That is a reporting gap, not a stock one.
- Duplicate payments and overpaid orders are still raised.
- An order on the hidden item with no cart details shows only in the on-demand match audit. No flag is raised, so the review must include the audit.

The rows the failed-hold denial bug has already written do not go away by themselves; section 4 clears them. The open fixes for N3 and the failed-hold denial still matter until the contract step, because turn-off and the store-open periods around it need correct data. They become deletions after it.

## 6. "Try"

The trial is all programs, in a narrow window with a set end date. A person turns it off on that date and the Board reviews afterwards. Keeping the design is a separate later decision; the window does not run on while the Board decides.

**The trial's mechanism:**

- `BoardSettings.programStoreClosedAt`, nullable, set and cleared by the Board. Setting it is audited and hides the public items.
- A guard in the stock writer: while set, no carry is recorded and no push is made. `changeProgramStock`, `changeProgramStockWith` (its row change still commits) and `pushProgramStock` all check it. That one spot also covers heal, nudge and re-arm.
- Callers keep stamping `inventoryHeldAt` and `seatTakenWithoutSaleAt`. Those stamps are what makes the re-count and later seat returns exact.
- New paid programs create the public item as draft, so `shopifyVariantId` stays filled and turn-off needs no new item.

**Turning it off, in order:**

1. A Board member clears the switch. Stock writes resume.
2. The same action re-counts each program whose sale has not ended, using `setProgramInventory`: capacity minus seats taken. This path already exists; it settles any pending write and clears parked ones. It reports each program, and it clears `productHiddenAt` on that program so the later off-sale sweep hides the item again once it is re-listed. That clearing is new.
3. Only after a program's re-count is confirmed, a person re-lists its public item in Shopify. Stock is right before the item can sell. The rules already make re-listing a hand step (`programs.md:346`).
4. A person removes the menu link and any redirects.

No data migration is needed, and the refund rule stays on, as the Board decided it separately.

**Programs mid-sale at each end:**

| Situation | At turn-on | At turn-off |
|---|---|---|
| Family with an unpaid claim | Pays on the hidden item; unaffected | Pays on the hidden item; unaffected. Their claim takes no store stock again, so **a store buyer can take that seat**, today's known problem. Claims made in the window count here too |
| Paid or approved family | Row stands | Counted as taken by the re-count |
| Scholarship request | Stamped as today, no stock moved | Counted as taken; a later release gives back +1 correctly |
| Comp in the window | Stamped, no stock moved | Counted as taken; a later removal gives back +1 correctly |
| Seat freed in the window | Claimable in the app | Goes back to the store through the re-count |
| Paid webhook crossing the boundary | Normal; a claim activates, no claim goes to the Board | Normal. Its stock change and the re-count share the Program row lock |
| Off-sale date passes in the window | n/a | Not re-counted and not re-listed; stays hidden. Unpaid families still pay |
| Sale already ended at turn-on | Left as it is | Left as it is |
| Program created in the window | Public item starts as draft | Re-counted, then listed by hand like the rest |
| Store buyer with no row | Must be cleared before turn-on (section 4) | Can arise again only after the item is re-listed, as today |

**What is measured.** All from existing data. Comparing with last sale doesn't work over a short window, so these are counts and checks, not rates against a baseline.

| Question | Source | What a good answer looks like |
|---|---|---|
| Did the switch work on every program? | Hide results at turn-on; store check by a person | All hidden, no retries left |
| Did turn-off restore the right numbers? | For each program, Shopify stock against capacity minus seats taken, after the re-count | Every one equal |
| Could families claim and pay? | Claims and payments in the window, by program | Payments went through on the hidden item, and no failed checkouts were reported |
| Did anyone buy around the app? | Match audit, unclaimed paid orders on hidden items | None or an explained few |
| Did people get stuck? | The Board tallies help requests about signing up | Few, each answered |
| Were there stock alerts? | Board email | None during the window |

**Read later, at no extra cost:** a few weeks after turn-off, how many claims made in the window have been paid.

**The review** happens soon after turn-off and answers three things: did both switches work, did anyone get hurt, and is another window or a keep worth discussing.

**What a short window can't teach:**

- Whether claims turn into payments as often as before, or how long families take. Slow payers fall outside the window.
- Whether unpaid claims block seats at the off-sale date, unless a date falls inside the window. Even then there is one example.
- Whether programs fill as well. Sign-ups come in bursts, and small numbers say little.
- Whether people go around the app. A rare event won't show, and word of the hidden link spreads slowly.
- How refunds behave. There may be none in the window.
- How much Board work drops over a term.
- Who gave up. A shopper who leaves at the store or at Google sign-in leaves no record, and click-through isn't tracked.

So the window can show the design works and is safe to switch. It can't show that it is better for sign-ups over a season. A keep would rest on that mechanical result, the simpler system and the model, not on enrollment numbers.

## Rollout

Per `docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`. Each line is one PR unless noted. Migrations finish before old code stops serving, so each schema step must be safe for the code before it.

| Step | What ships | Rule | Note |
|---|---|---|---|
| 1 | Refund flags only, with the rule text | none | No schema |
| 2 | Sign-in returns to the program | none | No schema |
| 3 | Add `programStoreClosedAt` with its `@sensitivity` tag | 1, expand | Inert. If the settings route's grant must change, that goes first in its own boundary PR |
| 4 | Guard, checkout predicate, draft on create, hide and re-count actions | 2 | Off until the switch |
| — | Dev-store checks; section 4's three steps on production | | People |
| 5 | **Switch on for the window.** A short dated note goes in `programs.md` and `revenue.md`: which rules are paused and until when | | Board |
| — | Window ends: turn off and re-count (section 6). Note removed | | Board and a person; expected |
| — | Board review, then a separate decision | | Steps below only on a keep |
| 5a | Keep only: switch on for good, with rule text and `PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md` rewritten | | Board |
| 5b | Clear hold-failed and denied-with-no-hold rows; confirm no enrollment violations (section 4) | | People; gate for step 6 |
| 6 | Stock writer removed from callers, enrollment states reduced, switch treated as always on | 2, cut over | Includes scripts, seed, tests, `shopify-live` |
| 7 | Stock screens, manual-hold route and outbound entries removed | 7, route kills | Boundary change ships as its own certified decommission PR |
| 8 | A later release, once 6 and 7 are fully rolled out: drop columns | 3, contract; 5, wrapped | Never with step 6 or 7 |

## What gets deleted, only after a keep

- **`shopify/stock.ts`:** everything except `syncProgramPrice` and `setProgramProductOffSale`, about 850 lines, including its in-memory mock.
- **`finance/reconcile/reversals.ts`:** `settleRestockedSeats`, `removeRefundedEnrollment`, `settleUnrecordedRestock`, `takeBackRestockedSeats`, `takeBackAfterSale`, `recordRestock`, the once-only claims and `returnTestOrderStock`.
- **Reversals webhook:** `netRestockAgainstShortfall`.
- **Sale code:** `saleStockDelta`, the re-arm, `hideEndedProducts` and the no-reserved-item alert.
- **`programs/activateEnrollment.ts`:** `publicStockDelta` and the line accounting.
- **`program/capacity.ts`:** `countStockTakenSeats` and `seatReturnDelta`.
- **`lifecycleDrift.ts`:** the repair for an active row with a hold.
- **Program create:** the public item, for new programs.
- **Grace sweep:** `cron/scholarship-grace-expiry`, its Board setting `scholarshipDenialGraceDays` and the grace rules. It could also be removed separately sooner; nothing here depends on it.
- **Screens and routes:** Revenue Ops > Unconfirmed Shopify stock, Shopify Hold Reconciliation, `payment-plans/manual-hold`, the capped/uncapped warning.
- **Enrollment states:** `PENDING_HELD` and `PENDING_HOLD_FAILED` become one "requested" state, and `PENDING_HELD_DENIED` becomes "denied", which no longer looks at a hold. Six states become five, and invariants I1 to I4 mostly fall away. This runs only after the section 4 gate.
- **Columns:** `Program.shopifyStockCarry`, `PendingWrite`, `Unconfirmed`, `Parked`, `PushNeededAt`, `LeaseUntil`, `LeaseToken`; `ProgramParticipant.inventoryHeldAt`, `seatTakenWithoutSaleAt`. `productHiddenAt` and the switch column can go with them.
- **Live tests:** the stock parts of `product-inventory.shopify-live.ts` and `idempotency.shopify-live.ts`.

**Kept:** `shopifyVariantId`, `shopifyProductId`, both variant helpers, the order entitlement check, match audit, all PaymentException kinds, and every audit row already written.

## Conflicts

**`docs/in-design/PROGRAM_INSTANCE_RESTRUCTURE.md` (on hold).** This design doesn't depend on it, and the two conflict in one place. Its §2 and §2a move the stock columns to the instance and call for one public item and one stock writer per instance. If this trial is kept, those rows disappear and that plan gets smaller. If that work resumes during the trial, it should not copy the stock columns until the Board decides. The reserved-seat item per instance and the capacity lock moving to the instance are unaffected.

**Rules that change if the design is kept.** During the window a dated note covers them. All are Decision tier, none Policy: `programs.md:190-198` (returning seats), `:290-295` (fallback to the public item), `:303-309`, `:315-328`, `:330-349`, `:354-379`; `revenue.md:110-127`.

**Board doc wording.** It says the Board's policy needs each purchase matched to a checked Member and a completed background check before joining a program. The register says a public workshop needs no agreement. This design doesn't change either, and claims apply the same checks as today.

## What I skipped

| Skipped | Add it when |
|---|---|
| Locking the hidden item (a draft-order invoice per claim) | Repeated purchases around the app, or the cart-link check fails |
| Dropping the discount code for two hidden prices, which the Board doc floated | The code causes trouble. It works today and is a separate change |
| Taking payment inside the app, the Board's "buy in the app first" note | Never needed here: Shopify checkout follows the claim |
| Waitlist | Full programs show families turned away |
| Automatic release of unpaid claims | Owner ruling: not soon |
| Any path for people with no Google account | Owner ruling: nothing is built |
| Per-program trial | Owner ruling: all programs |
| Store theme edit, click tracking, zeroing leftover stock, automated redirects | Not needed for the trial |
| A list screen for refunded enrollments | The existing payment-problem list falls short |

## What the coordinator should model

Start from `ProgImpl_main.tla`. The `MCCand_closed_*` configs already cover a closed store, but under the older absolute-write candidate, so they don't answer the questions below.

1. **Trial state.** Store events removed, no stock writes, reserved-seat payments only. Check `NoOverEnroll` (Board override excepted), holders can always pay, and strangers' orders seat nobody. F1's configs should now pass.
2. **Refund flag.** New property: no refund, chargeback or cancellation path ever removes or withdraws a row. Check it in both webhook orderings, with duplicates and with lost webhooks. Include step 1 running while the store is still open: a restocked seat stays off sale, and `StockMatches` needs its refund term updated.
3. **Cutover.** Start with store buyers holding no row, a pending write in flight, a parked write, and a late paid webhook on the public item. Find what over-enrollment appears if the Board skips clearing unclaimed orders. This is the design's main remaining risk.
4. **Turn-off, as a normal step.** Run the window with programs mid-sale: claims, comps, holds, denials, withdrawals and paid removals, then turn it off. After the re-count, `StockMatches` must hold, including a pending write older than the 23-hour resend limit, a re-count racing a seat change, an off-sale date passing inside the window, and a later sweep hiding a re-listed item. Also later seat returns for rows stamped in the window (each exactly once), and how many window claims can end up over-promised once the store reopens. Then run on after turn-off, and a second window on top of the first.
5. **Switch race.** A push that passed the guard just before the switch, and a hide that fails and retries while a store sale lands.
6. **State merge.** Start with denied-with-no-hold and other off-diagram rows present, run the merge and the grace sweep, and confirm the gate is what prevents a removal nobody decided.
7. **Freed seat.** Paid-place removal puts the seat back on sale in the app, against `NoOverEnroll` and the off-sale rule.

Not worth modeling: Google sign-in, the redirects, or the price sync.

## Unverified

- The hidden item's cart link: no recorded test result.
- A Shopify redirect firing on a draft item's path.
- Whether `cron/pending-participants` is scheduled in production. If it isn't, nobody sees unpaid claims, including families denied after a failed hold.
- How many hold-failed and denied-with-no-hold rows exist in production.
- How many programs are on sale, or how many unclaimed orders exist, so the hand work at each end of the window is not sized. No production data was read.
- Line references are to `8f77baf1c`; open PRs #2912, #2913 and #2804 touch nearby code.

Shopify source for the redirect target: [Admin REST, Redirect](https://shopify.dev/docs/api/admin-rest/latest/resources/redirect.md).
