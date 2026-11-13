# Filing a conversion challenge

## Problem

When the catalog knows a store's name for a part, it also records how many
stock units one unit on that store's receipt stands for: a box of 50 screws
counts as 50. That number is the conversion factor. When it is wrong, every
future receipt for that part puts the wrong count into stock.

The catalog has a review queue, Conversion Challenges, where an inventory
manager accepts or rejects a proposed correction to a factor. Nothing in the
app files a challenge, so the queue is always empty. Managers can't edit a
factor directly either. Today the only way to correct a wrong factor is by
hand in the catalog database.

## Owner decisions

- **Inventory managers file challenges.** No one else may file one. This keeps
  to the rule that only inventory managers write to the catalog.
  `[Decision — owner]`
- **A manager may accept a challenge they filed.** The challenge then works as
  a recorded, versioned edit: it keeps who changed the factor, from what, to
  what, and why. `[Decision — owner]`
- **Accepting a challenge changes the catalog reference only.** Receipt lines
  already mapped but not yet applied keep the factor they were mapped with. A
  manager who wants the new factor on an open receipt clicks Change on that
  line. `[Decision — owner — deliberate limit]`
- **Filing starts only from a catalog item's References dialog**, for now.
  There is no entry point from Part mapping. A receipt line knows its part and
  factor, but not which reference produced them. `[Decision — owner]`

## Objective

An inventory manager who sees a wrong conversion factor can propose the right
one from the screen where the factor is shown. The proposal lands in the
Conversion Challenges queue, and accepting it changes the factor for goods
received from then on.

## Summary

- **Inventory managers** get a "Challenge" action on each reference in an
  item's References dialog. It takes a new factor and a reason. No one else's
  access changes.
- **The review queue** is unchanged: the same page, the same accept and reject
  actions, still limited to inventory managers.
- **Unchanged on purpose:** stock already counted is never recalculated;
  receipt lines already mapped keep their factor; managers still can't edit a
  factor directly.
- **Cost:** two PRs. The first is a one-line registry PR; the second is about
  a day of library and host work, with tests.

## Rules relied on

From `docs/rules/inventory.md`:

- A conversion factor is a whole number everywhere. A challenge proposing a
  fraction must be refused.
- A changed factor applies only to goods received after the change.
- Only inventory managers write to the catalog.
- The review queues, conversion challenges included, are read and worked by
  inventory managers only.
- Every org-scoped catalog row carries its org's id and a snapshot of its name.
  A challenge is org-scoped.

This design adds one rule: "Accepting a conversion challenge changes the
catalog reference only; receipt lines already mapped keep the factor they were
mapped with. `[Decision — owner — deliberate limit]`"

## What a conversion challenge is

This is inferred from the code. The global-catalog package has no README.

- A challenge targets one item reference (a store's or manufacturer's name for
  a catalog item). It records the factor at the time of filing, the proposed
  factor, a free-text reason, who filed it, and their org's id and name.
- One org may have at most one pending challenge per reference. A second one
  is refused with 409 while the first is pending.
- A challenge is pending, accepted or rejected. Accepting moves the
  reference's factor from the recorded current factor to the proposed one and
  adds one to its conversion version. Accepting is refused if the factor
  changed after the challenge was filed. Both outcomes write a workflow
  transition and an org event.
- The catalog was built to be shared by several orgs, each one flagging the
  shared data. In this deployment there is one org, and a single
  inventory-manager role covers both catalog and org writes. So the people who
  file challenges are the same people who review them.

## Where filing starts

On the Items page, an item's References dialog lists each reference with a
"Conv. Factor" column. For an inventory manager, each row gets a "Challenge"
button, which opens a small form:

| Field | Rule |
|---|---|
| Current factor | Shown read-only, as loaded |
| Proposed factor | Whole number, at least 1, different from the current one |
| Reason | Required, trimmed, up to 500 characters |

On submit, a toast says "Challenge filed for review", and the badge on the
Conversion Challenges tab goes up by one. A 409 ("A pending challenge already
exists…") is shown as written.

Archived references don't get the button. A challenge to one would have no
effect on matching.

## The route

None of the existing routes fits: the challenge routes list, accept and
reject, and none of them creates. A new route is needed:

```
POST /api/catalog/conversion-challenges
body: { itemReferenceId: int, proposedFactor: int ≥ 1, reason: string 1..500 }
→ the created ConversionChallenge
```

The library route factory reads the principal for the filer's id and the
catalog runtime's org for the id and name stamp, then calls the existing
service. The host's re-export stub at
`checkin-app/src/app/api/catalog/conversion-challenges/route.ts` already
serves the GET, so the POST is added to that file.

**Security registry entry** (`checkin-app/src/security/registry/catalog.ts`):

```ts
defineRoute({ endpoint: 'POST /api/catalog/conversion-challenges', authorize: 'inventory-manager', envelope: null, returns: ['ConversionChallenge'], orderedView: CATALOG_MANAGER_VIEW });
```

The returned row carries `localUserId` and `reason`, both internal tier, and
the manager view grants that tier.

Under the boundary isolation rule in `AGENTS.md`, this entry ships alone, in
its own PR, ahead of the route. A `defineRoute` with no route behind it does
nothing.

### Validation gaps closed by the build

Nothing calls the service yet, so these gaps are not live. The build PR
closes them:

- A non-integer proposed factor reaches the integer column and fails as a
  500. It must be refused as a 400.
- An empty reason is accepted. It must be refused after trimming.
- A proposed factor equal to the current one can be filed and accepted, and
  accepting it still adds one to the conversion version. Filing it must be
  refused.

The route's request schema covers all three. The service checks them again,
so a later caller is held to the same rules.

## After filing

- The challenge waits in the Conversion Challenges queue, oldest first. The
  nav badge already counts pending challenges.
- The reviewer sees the reference (part number, retailer, manufacturer, item
  name), the org, the current and proposed factors, and the reason. The
  existing page already shows all of these, so it needs no change.
- If the challenge is accepted, the reference's factor and version change.
  Receipts matched from then on use the new factor; goods already in stock
  are not recounted, and lines already mapped keep their old factor. If it
  is rejected, nothing changes. Either way, the challenge leaves the queue,
  and the transition log records who decided and when.
- The filer gets no notification. They can see the new factor in the
  References dialog, and a 409 tells them when a challenge is still pending.
  A history of past challenges is left out until someone needs one.

## PRs, in order

1. **Registry entry (boundary PR).** The `defineRoute` line above, and its
   line in the catalog admission test that lists the manager-only catalog
   routes (`checkin-app/src/security/__tests__/`). Nothing else.
2. **Route, form and validation.** Based on `main` once PR 1 has merged, not
   stacked on PR 1's branch:
   - library: a `create` factory in `routes/conversionChallenges.ts` with its
     zod schema; the three validation checks in the service; the Challenge
     button and form in `ItemReferencesModal`.
   - host: the POST export in the existing route stub, and its line in
     `checkin-app/scripts/migrated-routes.txt` if new catalog routes are
     still listed there.
   - tests: the three validation checks and a self-accept (Vitest, package
     tier); route admission and the form (Jest).
   - docs: the deliberate-limit rule above into `docs/rules/inventory.md`,
     and this file deleted.

## Alternatives considered

- **Let managers edit the factor directly in the References dialog.** This is
  smaller, but it loses what the challenge flow already provides: the reason,
  the before-and-after record, the per-org stamp, and the guard against a
  factor that changed in the meantime. The owner asked for the queue to be
  fed, not replaced.
- **Retire the queue.** This deletes a working review flow and its tests, and
  leaves a wrong factor with no way to fix it inside the app.
