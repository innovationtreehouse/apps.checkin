# Inventory

Rules for the inventory domain: the shared catalog that says what the
organization's parts, tools and consumables *are* (reference data), and the
organization's own holdings drawn from it (local inventory: stock counts, the
receive queue for backordered receipt lines, and provisional items waiting for a
catalog GTIN, the item's barcode number).

It also covers receiving, where a manager matches each line of a purchase
receipt to a catalog item before the goods are counted into stock. What a
receipt costs and what a donated item is worth fall under the expense rules
(`expenses.md`) and the donation rules (`revenue.md`); this file covers only the
goods.

How the pieces are built is described in
`docs/architecture/COMPONENT_ARCHITECTURE.md`.

## Policy

- Inventories of products, materials and supplies, and their invoices, are
  kept for seven years. — *Records Policy, Art. VI §VI.4.J*

- No policy governs the catalog itself or how stock is counted and received;
  the rules below are Assumptions and Procedure.

## Assumptions

- Checkin's role system decides who may curate the catalog: a sysadmin or board
  member grants the inventory-manager role, and the role stands for that grant.
  The catalog does not choose its own curators.

- The first production catalog is entered by hand from a maintained source
  sheet, so its accuracy rests on that entry, not on anything the app checks.

## Procedure

### Identity and codes

- Each item is identified by its GTIN-13, and the GTIN is its key: one GTIN, one
  item, across the whole catalog. A change must not create a second item for the
  same GTIN or move a GTIN to a different item. `[Decision]`

- A GTIN shown to a person uses its short form: `P000123` for a provisional GTIN,
  `03B0042` for one minted from the catalog's category and sequence, and the 13
  digits for a manufacturer's GTIN. CSV exports, URLs and API values keep the raw
  digits. `[Decision]`

- A person picks a part from the catalog rather than typing its GTIN. A new org
  item or part-bucket mapping takes only a GTIN-13 with a valid check digit that
  names an active catalog item or a pending provisional part of the org. A
  provisional part the catalog approved or mapped is refused, naming the real
  part that replaced it; a rejected one is refused. Rows stored before this
  check are kept as they are. `[Decision]`

- A category is keyed by a letter, and a subcategory by a number within its
  category; each item carries a category, a subcategory and a sequence number.
  The letter and number are part of how items are named, so they must not
  change once in use: renumbering a category in use renames every item in it.
  `[Decision]`

- An archived category keeps its letter, so no new category reuses it.
  `[Decision]`

- A reference's conversion factor (inventory units per receipt-line unit) is a
  whole number everywhere. There are no fractional packs; a change must not
  introduce a fractional factor. `[Decision]`

- A changed conversion factor applies only to goods received after the change.
  Stock already counted is never recalculated. `[Decision]`

### Proposals, provisional items, conflicts

- An item-reference proposal stays pending until a manager reviews it. A later
  proposal may supersede an earlier one instead of overwriting it; the earlier
  one is kept, with a record that it was superseded. A change must not delete
  that history to tidy up. `[Decision]`

- A provisional item holds a provisional GTIN until it is approved and mapped to
  a real GTIN. A provisional GTIN is allocated once and never reused, and each
  provisional-to-real mapping is recorded. A change must not recycle a
  provisional GTIN or drop the mapping log. `[Decision]`

- A reference conflict records the existing and proposed GTINs for a receipt
  line. It is closed by resolving it, which records an outcome and when it was
  resolved, never by deleting it. `[Decision]`

- An open reference conflict shows the item its part is on now, and says so when
  that is no longer the item it was raised against. The reviewer then acts as
  normal: "keep existing" keeps the current item. A resolve is refused only if
  the part moved between the page loading and the click, and the page reloads
  with the updated question. If the part is already on the proposed item, nothing
  is left to decide and the conflict is closed as resolved. A resolved conflict
  records the item it was decided against; its audit entry keeps the item raised.
  This screen offers no way back to the original item; that is fixed by hand in
  the global catalog. `[Decision]`

### On-hand stock

- A receipt or a donation of goods adds to stock once. Sending it again never
  double-counts, and a resend with different lines is refused instead of
  silently changing stock. `[Decision]`

- Every change to an on-hand count, including removing an org item, writes an
  inventory-log entry together with the change, naming who made it (or no one,
  for an automatic change); neither happens without the other. Removing an org
  item logs a copy of the removed row, so the count can be recovered. A change
  must not add a stock write that skips the log. `[Decision]`

- A receive-queue line is never deleted. Cancelling it records who cancelled it
  and when, and logs it; a cancelled line can't be fulfilled. A line is
  fulfilled at most once, and its stock is added together with the
  fulfilment. `[Decision]`

- A backorder is cancelled only with a reason. The reason is kept on the
  cancelled line and written to the inventory-log entry; a blank reason is
  refused. `[Decision — owner]`

- Receipts, fulfilments, merges and conflict resolutions that hit one GTIN at
  the same time must never lose an add. `[Decision]`

- A provisional item's stock merges into its real GTIN only when both counts use
  the same conversion factor. Otherwise the merge records a unit-mismatch
  conflict for a person to resolve. The factor used is the one the catalog event
  carried, even when the event arrives before the provisional item.
  `[Decision]`

- When provisional stock lands on a real item the organisation holds none of,
  it keeps its received count as is: the person who received it counted it.
  The factor must match only when merging into existing stock.
  `[Decision — owner]`

- A receipt's or donation's stock change, or a catalog decision, that fails
  to apply stays failed with its error and the time it first failed. Nothing
  retries it automatically: a person retries it from the Problems list on
  System Status. The error shows only on the item's own inventory page.
  `[Decision — owner]`

### Receiving

- Receiving is the only way a receipt's goods reach stock, and only after every
  line is linked to a catalog item, proposed as a new item, or marked as not
  inventory. Expense approval neither holds up nor repeats this. `[Decision]`

- When a manager links a receipt line to a catalog item, the link takes effect
  at once. If the manager also proposes a new reference (a retailer's name for
  that item) or reports a conflict with an existing one, the catalog reviews it
  separately: the receipt does not wait for that review, and its outcome never
  changes a receipt whose goods are already in stock.
  `[Decision — deliberate limit]`

- When a receipt arrives while the catalog is unavailable, its lines are not
  matched and the receipt shows "Matching pending" while it waits for review.
  An inventory manager runs matching from the receipt, or maps the lines by
  hand; matching never re-runs by itself. Matching fills only lines nobody has
  decided, and a receipt whose every line is then decided is sent to apply, as
  on arrival.
  `[Decision — owner]`

- A receipt's lines can be edited only while it waits for review. Once it is
  sent to apply, its lines can't be edited, even when the apply fails. A failed
  apply is never retried automatically: the receipt waits in Apply failed, and
  on the Problems list, for a person, who either retries it with the same lines
  or corrects it by hand outside receiving and closes it as handled by hand. A
  receipt whose part was taken but not confirmed stays applying, on the
  Problems list, until a person retries it. A close-out names, for each part not applied, whether it
  was done by hand or isn't needed, and carries a note; a blank note is
  refused. A closed receipt can't be reopened. `[Decision — owner]`

- The person who uploaded a receipt, or anyone in their household, may map its
  lines in Part mapping (link, propose or mark not inventory) and send it to
  apply. There is no conflict-of-interest check on mapping: it decides what the
  goods are, not what is paid. Finance and the expense sign-off seats decide
  the money side, under the conflict rules in `expenses.md`.
  `[Decision — owner]`

- A receipt reads "Received, N on backorder", not done, while N of its lines
  are open on the receive queue, and "Received" once none are. A cancelled
  line counts as closed. `[Decision — owner]`

### Access

- The catalog is public reference data with no personal data. Item, category,
  reference and conversion fields are public tier; the only non-public fields
  are who-did-what attribution, free text and cross-app linking fields, all
  internal tier. A change that adds a field with personal data (email, date of
  birth, address) breaks this and needs its own tier decision; it must not
  default to public. `[Decision — *Principle: least privilege*]`

- Anyone holding any person role, or an account on the org domain verified by
  the outside sign-in service, may read the catalog with no membership needed;
  so may a program leader, program volunteer or Volunteer Family member, youth included, but only
  while their household membership is ACTIVE. This is the shared catalog
  audience. It is decided from the signed-in session only, never from an email
  address, so a volunteer designation by itself admits no one. Only inventory
  managers may write. Reading
  is deliberately wider than in the board-only operations areas because the
  data is non-personal reference data; keeping writing narrow is what makes
  that proportionate. Widening reading further, or widening writing
  at all, is a decision on the record.
  `[Decision — *Principle: least privilege*]`

- The catalog audience reads finished catalog data: items, categories,
  subcategories, references and the audit trail. The review queues are read
  and worked by inventory managers only. Those queues are provisional items,
  item-reference proposals, reference conflicts and conversion challenges.
  `[Decision — owner]`

- On-hand stock is read by the same audience as the catalog; only inventory
  managers change it. `[Decision — *Principle: least privilege*]`

- Only inventory managers, finance and the board may see receiving, because
  receipts show spending. Only inventory managers act on it, apart from the
  close-out below. `[Decision — *Principle: least privilege*]`

- Inventory managers retry a receipt in Apply failed and close it out as
  handled by hand; the board may also close one out. `[Decision — owner]`

- Board membership is enough to view receipt and inventory data, and to edit it
  wherever the app allows an edit. `[Decision — owner]`

- One inventory-manager role covers all catalog writes. Splitting it into
  separate catalog-manager and org-manager roles is planned.
  `[Decision — deliberate limit]`

### Org stamping

- Every org-scoped catalog row (proposals, provisional items, conversion
  challenges, org events, and the provisional mapping log) carries its org's id
  and a snapshot of its name. A change must not leave such a row unstamped or
  let it carry an org the caller was not acting as. The name is kept as it was
  when written, because exported rows reach consumers that cannot look the org
  up.
  `[Decision]`
