# Shopify Member-Segment Pricing

**Status: PROPOSAL — not built.** Verified in tree: no customer/tag/segment code
exists (`shopify.ts` creates only Products/Variants and consumes `orders/paid`).
The **interim** mechanism shipped instead (#930): single-pool capacity +
per-enrollee server-minted single-use discount codes (`createShopifySingleVariantProgram`,
`mintMemberDiscountCode`; see `docs/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md` §2) —
which is exactly option (d) below, the narrow stopgap. Segment-gated automatic
discounts remain the intended **end-state**. The current wiring (one variant per
program at the non-member price, `buildMembershipCheckoutUrl`, the #739
variant-presence guard) is ground truth in the code; this doc keeps only the
constraint that makes the feature hard, the options, and the open questions.

**Addresses:** #270 (member-segment allowlist for program pricing), #278
(volunteer discount honor-system). **Related:** #739 (the variant-*presence*
guard this simplifies), `SHOPIFY_DEV_STORE_WEBHOOK.md` (dev-store + mock reused).

## The central design constraint (code-independent, the crux)

Both honor-system holes (#270 program tier, #278 volunteer discount) share one
root cause: **checkout is an anonymous Shopify cart permalink.** A bare
`.../cart/{variant}:{qty}?discount=...&attributes[...]` URL has no notion of *who*
is buying — cart attributes are customer-controlled query-string values, not
authenticated claims, which is why #739's and #278's guards exist and are still
incomplete. As long as tier/eligibility is a client-side choice over publicly-
checkoutable variants, **no server-side check on the *order* can recover who was
*entitled*** — the decision has to move to a point Shopify itself enforces before
checkout completes.

This is why tagging members in Shopify does **not** by itself fix anything:
**customer segments apply only where checkout is attributed to an identified,
tagged Shopify customer** — evaluated against the customer attached to the
checkout, not against anything in the cart URL, and (per Shopify's documented
discount-eligibility model) generally **not against a guest checkout**, even one
with a prefilled email. Everything in this proposal is secondary to solving that.

## Proposal shape (if built)

- **Component 1 — member registry → Shopify.** The app is the writer; segment
  membership is derived state from a live tag sync on the existing membership/
  volunteer status-change hook points (all already exist — no new lifecycle).
  Best-effort/non-blocking (a Shopify outage must never block `activate()`), so a
  nightly **reconciliation cron** diffs and repairs drift. Tag **every household
  member with a non-null email**, not just leads — whichever family member ends up
  at checkout must already be tagged.
- **Component 2 — program pricing.** One variant per program at the non-member
  rate + a segment-gated **automatic discount** for `org-member`. Prefer
  **per-program fixed-amount** discounts (parity with today's independent per-
  program pricing) over one storewide percentage rule (only fits if the member
  discount is a consistent percentage, which today's data isn't). Collapsing to
  one variant also makes Shopify inventory a valid single source of truth for the
  parallel capacity effort and closes the tier-confusion bug class by construction.
- **Component 3 — membership dues (#278).** Same mechanism on the membership
  variant: a `volunteer`-segment automatic discount retires
  `BoardSettings.volunteerFamilyDiscountCode` and the `discount=` URL param. Smaller
  migration than component 2; could ship first.

## The identity-at-checkout options (a/b/c/d — tombstones)

- **(a) Require Shopify customer sign-in at checkout *(recommended primary)*.**
  Shopify's "new customer accounts" (email + one-time code). Near-zero new app
  code — component 1's tag sync is the only prerequisite; it's what segment-gated
  discounts are *built* for. Honest cost: an **extra login step at checkout** on
  top of our own login — real friction, not hand-waved.
- **(b) Prefill email, hope guest checkout gets segment-matched. REJECTED as a
  foundation.** Shopify's model evaluates against the *attached customer*; a guest
  checkout with a matching email isn't documented to establish that attachment
  before the discount decision. Unconfirmed and likely unreliable — needs an
  empirical dev-store spike before *any* code, don't build on faith either way.
- **(c) App-generated draft orders via Admin API *(fallback)*.** The app already
  knows the buyer (our login) and maintains their tagged customer record, so it
  creates a Draft Order assigned to that customer and sends the hosted
  `invoice_url`. Sidesteps the anonymous-cart problem entirely; smallest UX cost
  (no second login) but a **materially bigger build** (new scope, new route, a
  shifted webhook trigger). Don't build speculatively alongside (a).
- **(d) Per-checkout single-use minted codes.** No segments, no identity problem.
  Kills #278's *shareability* hole but says nothing about #270 (a variant-
  selection problem, not a code problem). **This is what shipped as the #930
  interim** — useful as a fast stopgap while segments are built properly.

**Recommendation:** (a) primary, (c) fallback only if (a)'s friction proves
unacceptable; do not build (b) on faith; ship component 1 first, alone, with no
pricing change (lowest risk, fully reversible).

## Open questions

- **Minors / members without their own email** — a parent buys on their behalf;
  fine as long as *that adult's* email is tagged. Confirm it holds for every
  enrollment path.
- **Non-lead adults** — component 1 tags every household member with an email,
  not just `HouseholdLead` rows; a reviewer should explicitly sign off on that
  scope (leads-only would silently break for a non-lead adult at the keyboard).
- **Guest checkout despite (a)** — if a member checks out as a guest under (a),
  the discount silently doesn't apply and they're charged full price with no error
  surfaced. Acceptable failure mode, or does it need a nudge / post-purchase
  reconciliation? Decide before phase 2 ships.
- **Segment propagation delay** — Shopify segments update automatically but not
  synchronously; a household paying membership then immediately buying a program
  within the propagation window could get charged non-member price on their first
  eligible purchase. Worth a "give it a few minutes" note in the confirmation email.
- **The mock cannot model this feature** — the in-process Shopify mock self-fires
  a synthesized `orders/paid` and never touches Shopify's real checkout/discount
  engine, which is exactly where the identity-at-checkout question lives. Promote real-dev-store
  checkout testing (currently valuable-but-not-blocking in `SHOPIFY_DEV_STORE_WEBHOOK.md`)
  to **required** before phase 2 — the one place the mock's zero-infra runs out.
