# Shopify live contract tests

The suite in `checkin-app/shopify-live/` drives the app's real `lib/shopify/`
functions against a real Shopify **dev store**, with no fetch mocks. It runs
nightly, never in PR CI.

## What it catches that mocks cannot

A mocked test verifies the request *we* build. It cannot see what Shopify does
with it. Three classes only a live store answers:

- **Semantics we depend on.** That a fixed-amount discount is valued per unit
  rather than once per cart — the multi-child household overcharge — and that a
  deny inventory policy actually refuses oversell, and that resending a keyed
  inventory write never applies it twice (whether the key or the
  compare-and-set refused it is logged).
- **API-version sunsets.** The Admin API version is pinned. Shopify retires
  versions quarterly, and a lapsed pin is silently served by a different version
  rather than refused. The canary suite turns that into a red nightly instead of
  a quiet change in production behaviour.
- **Contract shape.** Fields, headers and scopes as Shopify actually stores and
  enforces them, not as fixtures remember them. The first live run is what caught
  the member-discount mint depending on a REST scope no store app grants.

## Running it

- **Nightly and on demand** via `.github/workflows/shopify-live.yml`
  (`workflow_dispatch`), gated on the `SHOPIFY_LIVE_ENABLED` repo variable.
  Serialized against the dev store's rate budget. Failures notify; the suite
  gates no deploy.
- **By hand:** `npm run test:shopify-live` from `checkin-app/`, with dev-store
  credentials in the environment.
- **Credentials a run needs:** `SHOPIFY_STORE_DOMAIN` and
  `SHOPIFY_LIVE_ALLOWED_DOMAIN` (both the dev store), plus `SHOPIFY_CLIENT_ID` /
  `SHOPIFY_CLIENT_SECRET` for the dev store app. Scopes: `write_products`,
  `write_inventory`, `write_discounts`, `read_locations`.
- **The filenames are load-bearing.** Suites are `*.shopify-live.ts`, not
  `*.test.ts`, which keeps them structurally invisible to every other jest
  invocation — including the coverage scripts, which override the ignore list on
  the command line and would otherwise pick them up. Keep the suffix.

## Dev-store-only — never relax this

The suite creates and deletes real catalog objects, so pointing it at the
production store has to be impossible by construction, not by convention.
`shopify-live/guard.ts` refuses to run unless all three hold:

1. the domain is not the production store — refused outright, whatever else is
   configured;
2. `SHOPIFY_STORE_DOMAIN` equals `SHOPIFY_LIVE_ALLOWED_DOMAIN`, which a human
   provisions separately from the workflow that pins the domain, so retargeting
   the suite takes two deliberate edits in two places;
3. the domain is a `*.myshopify.com` storefront.

Collapsing these into one setting is the change to refuse. Any single-variable
version means one mistaken value points a destructive suite at the live store.

The guard is a pure module with no jest or app imports, covered by the normal
unit run (`src/lib/__tests__/shopifyLiveGuard.test.ts`) — so the thing standing
between the suite and production is verified in CI even though the suite itself
never runs there. The janitor goes through the same guard.

## Cleanup

Every resource the suite creates is titled `citest-…` (minted discount codes use
a reserved `PRG9999999xx-` program-id range instead, since their title is the
code) and is registered the moment its id is known, so a failed assertion still
cleans up in `afterAll`.

`scripts/shopify-live-janitor.ts` sweeps tagged resources before each run with a
24-hour cutoff, clearing anything a crashed run left behind, and again afterwards
on `always()` with a 0-hour cutoff — a red run must not leak catalog objects. It
is safe to run by hand:

```bash
npx tsx scripts/shopify-live-janitor.ts
```
