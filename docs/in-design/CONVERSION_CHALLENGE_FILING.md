# Filing a conversion challenge

## Problem

When the catalog knows a store's name for a part, it also records how many
stock units one unit on that store's receipt stands for: a box of 50 screws
counts as 50. That number is the conversion factor. When it is wrong, every
future receipt for that part puts the wrong count into stock.

The catalog has a review queue, Conversion Challenges, where an inventory
manager accepts or rejects a proposed correction to a factor. Nothing in the
app files a challenge, so the queue is always empty. Managers also cannot edit
a factor directly. Today the only way to correct a wrong factor is by hand in
the catalog database.

## Open questions for the owner

### Q1. Who may file a challenge?

The catalog rules allow only inventory managers to write to the catalog, and
they say that widening write access at all is a decision on the record. Filing
a challenge is a write.

- **A. Inventory managers only.** No rule changes. In this single-org
  deployment the people who file are the people who review.
- **B. Inventory managers, plus anyone who may map a receipt's lines.** The
  people who handle the goods notice a wrong count first. This widens catalog
  writing, so the decision goes on the record in `docs/rules/inventory.md`.
- **C. Anyone in the catalog audience** (everyone who can read the catalog).
  This is the widest option, and it opens the queue to noise.

**Recommendation: A.** The queue is new and empty. The people who correct
counts today are inventory managers, and A needs no rule change. Moving to B
later is one registry line plus a rule entry.

### Q2. May a manager accept a challenge they filed?

Under A, the filer and the reviewer hold the same role.

- **A. Yes.** The challenge then works as a recorded, versioned edit: it keeps
  who changed the factor, from what, to what, and why.
- **B. No, another inventory manager must review it.** This is a four-eyes
  check, and the app refuses a self-accept. It stalls whenever only one
  manager is active.

**Recommendation: A**, unless the organisation has two or more active
inventory managers. A wrong factor costs stock counts, not money, and the
change applies only to goods received afterwards.

### Q3. When a challenge is accepted, what happens to receipt lines already mapped but not yet applied?

Each receipt line stores the factor it was mapped with. Accepting a challenge
changes the catalog reference only. No consumer rewrites open lines, and
nothing in this design adds one.

- **A. Leave them as they are (deliberate limit).** A manager who wants the
  new factor on an open receipt clicks Change on that line.
- **B. Re-stamp the open, editable lines that matched this reference.** This
  needs a new event consumer in the receipt-mapping library, and a way to
  tell which lines came from this reference. Lines store the part's GTIN, not
  the reference.

**Recommendation: A.** Recorded as a deliberate limit.

### Q4. Where does filing start?

- **A. The catalog item's References dialog only.** Each reference row already
  shows its factor. A "Challenge" action sits beside it.
- **B. The References dialog, and also a receipt line in Part mapping.** A
  receipt line knows its part and factor, but not which reference produced
  them, so this entry point needs a lookup to find the reference.

**Recommendation: A.** Add B only if managers ask for it.

## Objective

An inventory manager who sees a wrong conversion factor can propose the right
one from the screen where the factor is shown. The proposal lands in the
Conversion Challenges queue, and accepting it changes the factor for goods
received from then on.

## Summary

- **Inventory managers** get a "Challenge" action on each reference in an
  item's References dialog. It takes a new factor and a reason. On the
  recommended answers, nobody else's access changes.
- **The review queue** is unchanged: the same page, the same accept and
  reject actions, already limited to inventory managers.
- **Unchanged on purpose:** stock already counted is never recalculated;
  receipt lines already mapped keep their factor (Q3); managers still cannot
  edit a factor directly.
- **Cost:** two PRs. The first is a one-line registry PR; the second is about
  a day of library and host work, with tests.

## Rules relied on

All from `docs/rules/inventory.md`:

- A conversion factor is a whole number everywhere. A challenge proposing a
  fraction must be refused.
- A changed factor applies only to goods received after the change.
- Only inventory managers write to the catalog; widening writing is a decision
  on the record (Q1 option A keeps to this; B or C changes it).
- The review queues, conversion challenges included, are read and worked by
  inventory managers only.
- Every org-scoped catalog row carries its org's id and a snapshot of its name.
  A challenge is org-scoped.

On Q3 option A, this design adds one rule: "Accepting a conversion challenge
changes the catalog reference only; receipt lines already mapped keep the
factor they were mapped with. `[Decision — deliberate limit]`"

## What a conversion challenge is

This is inferred from the code. The global-catalog package has no README.

- A challenge targets one item reference (a store's or manufacturer's name for
  a catalog item). It records the factor at the time of filing, the proposed
  factor, a free-text reason, the person filing, and their org's id and name.
- One org may have at most one pending challenge per reference. A second one
  is refused with 409 while the first is pending. Different orgs may each have
  one.
- The challenge has three states: pending, accepted, rejected. Accepting moves
  the reference's factor from the recorded current factor to the proposed one
  and adds one to its conversion version. If the factor changed after the
  challenge was filed, accepting is refused. Both outcomes write a workflow
  transition and an org event.
- The review page's text says challenges come from "organization managers".
  The catalog was built to be shared by several orgs, each flagging the shared
  data. In this deployment there is one org, and one inventory-manager role
  covers both catalog and org writes. So the filer is, in practice, an
  inventory manager.

## Where filing starts

On the Items page, an item's References dialog lists each reference with its
"Conv. Factor" column. For an inventory manager, each row gets a "Challenge"
button. It opens a small form:

| Field | Rule |
|---|---|
| Current factor | Shown, read-only, as loaded |
| Proposed factor | Whole number, at least 1, different from the current one |
| Reason | Required, trimmed, up to 500 characters |

On submit, a toast says "Challenge filed for review", and the Conversion
Challenges tab badge goes up by one. A 409 ("A pending challenge already
exists…") is shown as written. The button stays visible to all managers; the
server decides.

Archived references are not offered. Challenging one has no effect on matching.

## The route

No existing route fits. The existing challenge routes list, accept and reject;
none creates. A new route is needed:

```
POST /api/catalog/conversion-challenges
body: { itemReferenceId: int, proposedFactor: int ≥ 1, reason: string 1..500 }
→ the created ConversionChallenge
```

The library route factory reads the principal for the filer's id and the
catalog runtime's org for the id and name stamp, then calls the existing
service. The host adds a re-export stub at
`checkin-app/src/app/api/catalog/conversion-challenges/route.ts`, which already
serves the GET, so the POST joins it.

**Security registry entry** (`checkin-app/src/security/registry/catalog.ts`),
for Q1 option A:

```ts
defineRoute({ endpoint: 'POST /api/catalog/conversion-challenges', authorize: 'inventory-manager', envelope: null, returns: ['ConversionChallenge'], orderedView: CATALOG_MANAGER_VIEW });
```

The returned row carries `localUserId` and `reason`, both internal tier, which
the manager view grants. For option B, `authorize` becomes the receipt-mapping
write gate and the view gains a matching entry. That is a separate registry
decision, made once Q1 is answered.

Per the boundary isolation rule in `AGENTS.md`, this entry ships alone in its
own PR, ahead of the route. An unused `defineRoute` is inert.

### Service hardening in the same change

Three checks the service does not make today. Each belongs in the route PR,
because nothing calls the service yet:

- The proposed factor must be a whole number. Today a fraction reaches the
  integer column and fails as a 500 instead of a 400.
- The reason must not be empty after trimming.
- The proposed factor must differ from the reference's current one. Today a
  no-op challenge can be filed and accepted, and accepting it still adds one
  to the version.

The route's request schema covers the first two. The service repeats them so
that any later caller is held to the same rules.

If Q2 is answered B, `acceptChallenge` also refuses when the reviewer is the
filer (403, "You filed this challenge; another inventory manager must
review it").

## After filing

- The challenge is pending in the Conversion Challenges queue, oldest first.
  The nav badge already counts pending challenges.
- The reviewer sees the reference (part number, retailer, manufacturer, item
  name), the org, the current and proposed factors, and the reason. The
  existing page shows all of these. No change is needed.
- Accept: the reference's factor and version change. Receipts matched from
  then on use the new factor, and goods already in stock are not recounted.
  Reject: nothing changes. Either way, the challenge leaves the queue, and the
  transition log records who decided and when.
- The filer is not notified. They can see the new factor in the References
  dialog, and the 409 tells them when one is still pending. A history view of
  past challenges is left out until someone needs it.

## PRs, in order

1. **Registry entry (boundary PR).** The one `defineRoute` line above, plus
   its line in the catalog admission test that lists manager-only catalog
   routes (`checkin-app/src/security/__tests__/`). Nothing else.
2. **Route, form and hardening.** This PR is based on `main` after PR 1
   merges, not stacked on PR 1's branch:
   - library: a `create` factory in `routes/conversionChallenges.ts` with its
     zod schema; the three service checks; the Challenge button and form in
     `ItemReferencesModal`.
   - host: the POST export in the existing route stub, and its line in
     `checkin-app/scripts/migrated-routes.txt` if that list still applies to
     new catalog routes.
   - tests: service checks (Vitest, package tier); route admission and the
     form (Jest).
   - docs: the Q3 rule into `docs/rules/inventory.md`, and this file deleted.

If Q1 is answered B, PR 1 carries the wider gate, and PR 2 also adds the
Part mapping entry point (Q4 B) and the rule recording the widened write.

## Alternatives considered

- **Let managers edit the factor directly in the References dialog.** This
  is smaller, but it drops the reason, the before-and-after record, the
  per-org stamp, and the stale-factor guard that the challenge flow already
  has. The owner asked for the queue to be fed, not replaced.
- **Retire the queue.** This deletes a working review flow along with its
  tests, and leaves wrong factors with no fix inside the app.
