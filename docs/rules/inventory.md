# Inventory

The inventory domain: the shared catalog of what the organization's parts,
tools, and consumables *are* (reference data), and — as later work lands — the
on-hand holdings that draw on it. Today only the global catalog has shipped, so
every rule below is a catalog rule; local-inventory holdings add their rules to
this same file when that work lands.

The architecture these rules sit on — the library-isolation seam, the injected
org identity, the own-database packaging — is described in
`docs/designs/COMPONENT_ARCHITECTURE.md`, not here.

## Assumptions

- Who may curate the catalog is decided through checkin's role system: a
  sysadmin or board member grants `INVENTORY_MANAGER`, and the flag represents
  that grant. The catalog does not decide its own curators.

- The initial production catalog is entered by hand through the UI from a
  maintained source sheet. There is no bulk-import path, so first-load catalog
  correctness rests on that manual entry, not on an import the app validates.

## Procedure

### Identity and codes

- An item is identified by its GTIN-13, and the GTIN is the item's key: one
  GTIN, one item, across the whole catalog. A change must not create a second
  item for the same GTIN or reassign a GTIN to a different item. `[Decision]`

- Categories are keyed by a letter and subcategories by a number within their
  category; an item carries category, subcategory, and a sequence. The letter
  and number are part of how items are named and must stay stable once in use —
  renumbering a category in use renames every item under it. `[Decision]`

- A reference's conversion factor — inventory units per receipt-line unit — is a
  whole number system-wide. There are no fractional packs; a change must not
  introduce a non-integer factor. `[Decision]`

### Proposals, provisionals, conflicts

- An item-reference proposal is pending until a manager reviews it, and a later
  proposal may supersede an earlier one rather than overwrite it. A superseded
  proposal is kept with its supersession recorded; a change must not delete the
  superseded history to "clean up." `[Decision]`

- A provisional item holds a provisional GTIN until it is approved and mapped to
  a real GTIN. A provisional GTIN is allocated once and not reused, and the
  mapping from provisional to real GTIN is recorded; a change must not recycle a
  provisional GTIN or drop the mapping log. `[Decision]`

- A reference conflict records the existing and proposed GTINs for a receipt
  line and is closed by resolving it (an outcome plus a resolution time), never
  by deleting the row. `[Decision]`

### Access

- The catalog is public reference data and carries no personal data: item,
  category, reference, and conversion fields are `public`; the only non-public
  fields are actor attribution, free text, and cross-app plumbing, all
  `internal`. A change that adds a field carrying personal data (email, DOB,
  address) breaks this and needs its own tier decision, not a default to
  `public`. `[Decision — *Principle: least privilege*]`

- Read is admitted by the broad Treehouse-volunteer gate — any of several staff
  role flags, a program leader, or a holder of a volunteer designation — while
  write is admitted for `INVENTORY_MANAGER` only, with no admin auto-admit on
  the write path. The read audience is deliberately wider than the board-only
  operations areas because the data is non-personal reference data; the narrow
  write path is what keeps that proportionate. Widening read further, or
  widening write, is a decision on the record, not a casual change.
  `[Decision — *Principle: least privilege*]`

- `INVENTORY_MANAGER` is a single write role that collapses the two manager
  tiers the catalog was ported from. Splitting it back into distinct
  catalog-manager and org-manager roles is intended strategic work, not done;
  until then one role governs all catalog writes. `[Decision — deliberate limit]`

### Org stamping

- Every org-scoped catalog row — proposals, provisional items, conversion
  challenges, org events, and the provisional mapping log — carries the one
  injected org identity (`org_id`, plus an `org_name` snapshot). The app is
  single-org today and stamps every such row with the one registered org; a
  change must not leave an org-scoped row unstamped or let it carry an org the
  caller was not acting as. The `org_name` is a point-in-time snapshot that
  travels with the row, because exported rows reach consumers that cannot look
  the org up. `[Decision]`
