# Per-item accounts: every line mapped, nothing defaulted

## Problem

When the app books money into QuickBooks it picks each line's account from the
books map, which holds one account per named role. Four of those roles are too
coarse for how finance actually keeps the books:

- **Online-store sales.** Every sale books to one sales account. Membership fees
  and program fees belong on different income lines, and so may other items.
- **Gifts of goods, expense side.** Every donated item books to one in-kind
  expense account. A donated laptop and donated lumber belong on different
  expense lines, the same lines a purchase of either would use.
- **Gifts of goods, donated equipment.** Every donated capital item books to one
  fixed-asset account, whatever kind of asset it is.
- **Giving-platform gifts.** Every employee gift books to one donations account
  and every employer match to one matches account. Finance already keeps rules
  that say which account each gift belongs on, by employer, campaign, donation
  method and donation type. Those rules decided the account when donations
  booked its own deposits. Since income took over booking those deposits, the
  rules still hold a batch until every gift matches one, but their accounts are
  no longer used: every gift lands on the single books-map account.

A single account per role is also a catch-all. Anything nobody mapped books
there quietly, and finance finds it later and moves it by hand.

Separately, the giving platform charges fees that the app books as an expense.
The owner has ruled that they are a reduction of income, and that each fee
reduces the income line of the money it was taken from.

## Objective

Every sales, gift and donated-goods line books to an account finance chose for
that item. A line with no such account doesn't book: it waits for finance,
which sees exactly what is unmapped. A catch-all exists only where finance
writes one on purpose. Giving-platform fees reduce the income lines they were
taken from, row by row, and always sum to the fee exactly. Every account the
app books to is of a QuickBooks type that fits the line.

## Executive summary

- **Finance** chooses each line's account where it already maps the item:
  - the income items screen, per store item, for sales. An item counts as
    decided only once it has both its bucket and its account;
  - the giving-platform account rules, per rule, for gifts and matches. The
    rules already exist; they gain account pickers that read QuickBooks live;
  - the expense account rules, per part, for donated goods, both the expense
    side and donated equipment. A donated item books where the same purchase
    would.
- **Nothing defaults.** A line no setting covers holds its payout, batch or gift
  for finance, as an unmapped expense line already does. A `*` rule finance
  writes is the only catch-all, and it is a deliberate choice.
- **Custom store items**, typed into an order with no store item behind them,
  book to one account finance sets for them.
- **Six books-map roles retire:** Shopify sales, Benevity donations, Benevity
  employer matches, in-kind expense and fixed assets, because per-item mappings
  replace them; and Benevity fees, because fees now reduce income.
- **Giving-platform fees** stop booking to a fees account. Each spreadsheet
  row's fee is split across that row's amount columns, and each part is netted
  into its column's income line.
- **Account types:** the books map, and every per-item picker, accepts only
  account types that fit the line, as the books map already does for the
  expense payment account.
- **Nothing in QuickBooks changes**, and no stored setting is rewritten. A new
  setting applies to entries created after it is saved.
- **Cost:** about nine small PRs, one or two of them boundary-only, and one
  decommission at the end. No new screen and no new table. The
  giving-platform accounts come back first and on their own, since losing them
  is a regression; the cutover file traces it.

Online-store fees do not change. They are merchant-account fees on direct
revenue, so they stay an expense on "Shopify: fees" (PIA-5).

Every owner question (PIA-1 to PIA-11) is settled; see §10.

## Rules this relies on

From `docs/rules/revenue.md`:

- The books map says which account each named role books to; only finance edits
  it, each edit is recorded, and every area reads it when it books. *This design
  changes it*: sales, gifts and donated goods no longer book through a role, and
  the books map keeps only the roles that are one account by nature (§1, §9).
- Sales are booked as general income only where finance chose that for the
  item, with an exception for custom items, which book as general income without
  asking. *This design changes the exception*: custom items still need no
  per-item decision, but they book to the account finance set for custom items
  (§3, §9).
- A payout with a sale of an item finance has not decided on waits until finance
  does. *Extended*: deciding an item now means choosing its account as well as
  its bucket.
- A change to an item's mapping applies to deposits created afterwards and never
  rebooks one already created. Extended to accounts.
- The app never changes or deletes anything already in the books.
- A giving-platform batch is finished only when every gift has a clear place in
  the books, and a finished batch can't be changed. *Extended*: a clear place
  includes an account for each amount the gift carries. The account is fixed
  when the batch finishes.

From `docs/rules/expenses.md`:

- An account rule names its part by GTIN-13, or `*` for any part.
- Each expense line reaches the books on one account. A line the mappings do not
  resolve to exactly one account waits for finance. *Extended to gifts of
  goods* (§4).
- Donated equipment goes through the same capital thresholds, review and
  register as purchased equipment.
- Accounts are picked one at a time from QuickBooks' live lists; the app never
  imports the chart of accounts and never matches names on its own.

## 1. The pattern

Every sales, gift or donated-goods line resolves its account from a mapping
finance keeps on the item:

1. Find the line's mapping. Each area keys it by what it already knows about the
   line (table below).
2. Exactly one mapping with an account: the line books there.
3. No mapping, a mapping without an account, or several mappings with no single
   winner: the line holds, with the reason, until finance maps it. Nothing books
   in its place.
4. A mapped account that can't be used (deleted or inactive in QuickBooks, or of
   the wrong type) holds the same way.
5. The resolved account id is written on the line when the entry is built, so a
   later settings change can't move a line already handed over.

| Line | Mapping lives on | Keyed by | Exists today |
|---|---|---|---|
| Online-store sale | Income item (`/income/items`) | Store variant | The item row exists (it carries the bucket); the account column is new |
| Custom store item | Books map | One setting, "Shopify: custom items" | New role |
| Giving-platform gift or match | Giving-platform account rule (`/donations/account-map`) | Company name, campaign (`*` allowed), donation method, donation type | Rules exist and already pick a single match; they hold account *names*, not ids |
| Donated goods, expense or capital | Expense account rule (`/expense/account-mapping`), or an account finance sets on the held line | Category, subcategory, GTIN-13 (`*` allowed), capital flag | Rules exist and already resolve expense lines |

**A catch-all is a rule finance writes.** A `*` rule on the expense or
giving-platform screen covers everything else on purpose, and the screen shows
it as one. Nothing else stands in for a missing mapping.

**What stays one account per role** in the books map: the two bank accounts,
Shopify card remainder, adjustments and fees, in-kind income, the in-kind
clearing account, the expense payment account, and the new custom-items account.
These are one account by nature, not a fallback for unmapped items.

## 2. Account types

Each kind of line, and each remaining books-map role, names the QuickBooks
account types it accepts (§7). The books map and every per-item picker refuse
any other on save and filter their lists to the allowed types. A stored account
that later reads as the wrong type holds what would book to it and alerts
finance, as the expense payment account does now.

The table lives beside `BOOKS_MAP_ROLES` in `@checkin/quickbooks`, so the books
map, the three mapping screens and the posting code read one list.

## 3. Online-store sales

- Income items gain a nullable QuickBooks account id beside the bucket. Finance
  sets it with the live picker, filtered to income types.
- An item is decided when it has an account and a bucket choice (a bucket, or
  general income). A payout with a sale of an undecided item waits, in whole, as
  it does today for a missing bucket, and the next run books it once finance
  decides. The income items screen lists items missing an account the way it
  lists items missing a bucket.
- `buildDepositLines` already splits each charge across the order's lines and
  groups the parts by logical account (sales, card remainder, fees, adjustments)
  and bucket. Every sale today shares the one logical account "income". Each
  sale part now carries its item's QuickBooks account id, and sale parts are
  grouped by that id and bucket, so membership sales and program sales in one
  payout become two deposit lines. `depositWrite` in `outbox.ts` then books each
  sale line to its own id instead of looking up `SHOPIFY_SALES`.
- A custom item books as general income to the "Shopify: custom items" account.
  While that account is unset, a payout with a custom item waits for it.
- Card remainder, adjustments and fees are unchanged.

## 4. Gifts of goods

The journal entry keeps its shape: in-kind income credited, each line debited.
Today each debit picks `INKIND_EXPENSE` or, for a line with capital-register
rows, `FIXED_ASSETS`. Now:

- A line with a GTIN-13 is resolved against the expense account rules, through a
  port the host binds to expense's rule matcher: the same matcher expense lines
  use, with the capital flag set from whether the line has asset rows. Category
  and subcategory come from the catalog, as for expense.
- One matching rule, or one exact-GTIN rule among several, supplies the account.
- No match, several matches with no exact-GTIN winner, or a line with no GTIN-13
  holds the gift for finance. Finance sets that line's account by hand from the
  live list, as it does for a held expense line, and the gift books on the next
  run.
- A capital line must land on a fixed-asset account and any other line on an
  expense account (§7). A rule that gives the wrong type holds the line.

Lines are already one debit each, so nothing groups differently.

## 5. Giving-platform gifts

### 5.1 Accounts

The account rules keep their matching exactly as today. Each rule gains nullable
QuickBooks account ids for donations and matches, picked from the live list. The
name columns stay, read-only, shown beside the picker as what finance wrote
before.

A batch finishes only when every gift matches exactly one rule *and* that rule
has an account for each amount the gift carries: a donation account if the
donation is non-zero, a match account if the match is. A gift whose rule lacks
one holds the batch on the holds screen, beside gifts no rule matches, naming
the rule.

At finish, each item takes its rule's account id. The hand-over carries each
line's account id to income, and income's expected-deposit line requires one.
Lines are grouped by kind, account and bucket, so one batch can hold several
donation lines.

### 5.2 Fees reduce income

The export's columns, per row:

| Column | Meaning |
|---|---|
| Donation Amount (or Total Donation to be Acknowledged) | The employee's gift |
| Match Amount | The employer's match |
| Cause Support Fee, Merchant Fee, Check Fee | Fees taken from the row, summed (PIA-4) |

The row's fee is split across the row's amount columns in proportion to their
amounts (PIA-1). A blank amount counts as zero and a zero column takes no part
of the fee (PIA-2). A row with only fees holds its batch for finance, on the
same holds screen. Each part is netted into its column's line, on that column's
account and the gift's Class, so the deposit shows net income and no fee line
(PIA-6). Rows are never pooled: the split is per row, and parts are summed into
lines only after each row is split.

Worked examples (fee $2.50 on each row):

| Donation | Match | Fee parts | Net lines |
|---|---|---|---|
| $100.00 | $100.00 | $1.25 / $1.25 | $98.75 / $98.75 |
| $100.00 | $50.00 | $1.67 / $0.83 | $98.33 / $49.17 |
| $5.00 | $95.00 | $0.12 / $2.38 | $4.88 / $92.62 |
| $40.00 | $0.00 | $2.50 / — | $37.50 / — |
| $0.01 | $0.02 | $0.83 / $1.67 | −$0.82 / −$1.65 |

Rounding, largest fraction (PIA-3): each column's exact share is floored to
whole cents, and the leftover cents go one at a time to the columns with the
largest fractional remainders. A tie goes to the larger amount, then to the
earlier column. In the third row the shares are 12.5¢ and 237.5¢, a tie, so the
cent goes to Match. The last row shows a fee larger than its gifts: both net
lines go negative, which is what happened. A batch that nets to zero or less is
already refused and raised for finance.

One allocator does every such split in the app. Expense's `allocateAmount`
moves to `@checkin/money` and changes from largest amount to largest fraction,
with the tie rule above. It then serves:

- an expense's tax, shipping and discount across its lines;
- a Benevity row's fee across its columns;
- income's split of a Shopify charge or refund across its order lines, which
  today rounds each part toward zero and books the leftover at organisation
  level. Under the shared allocator the leftover cents go to the lines instead.
  When a charge covers more than its lines (tax and shipping), the lines still
  take their own amounts and the excess still books to card remainder.

An allocation already stored on an expense line, or a deposit already created,
keeps its numbers. The change reaches what is allocated after it ships.

This replaces "Benevity: fees" and each rule's fees account (PIA-7).

### 5.3 Where it runs

The split happens in bulk-donation when the batch finishes, because that is
where the row is whole. Each amount item carries its fee part netted in, so the
hand-over to income needs no fee item and income needs no fee logic.

## 6. QuickBooks entries

### 6.1 Several accounts on one entry

Nothing new is needed on the QuickBooks side. A Deposit already carries one
account and Class per line, and income already writes one line per account and
bucket; per-item accounts only make more lines. A JournalEntry already carries
an account per line. Fees are netted into their gift lines, so a deposit has no
fee line. A line goes negative only where an account and Class took more fees
than gifts. QuickBooks accepts that as long as the deposit's total is positive,
which the existing nets-to-zero check guarantees.

### 6.2 Matching and drift

Matching finds a finance-booked deposit by bank account, date and total, never by
line accounts, so per-item accounts don't change what matches. A held payout or
batch is still matched first: if finance booked it by hand, the match settles it
and nothing waits on a mapping. The drift check compares an app-created entry
with what the app posted; it starts comparing line accounts only if it already
does for that area. A matched entry booked by finance is never rebooked
(deliberate limit, unchanged).

### 6.3 Online-store fees

Unchanged. Each transaction's fee stays whole on "Shopify: fees", an expense
account (PIA-5).

## 7. Account types

| Line or role | Accepts |
|---|---|
| Shopify payouts: bank account; Benevity disbursements: bank account | Bank |
| Expense payment | Bank, Credit Card (unchanged) |
| Online-store sale; Shopify: custom items; giving-platform gift or match; Gifts of goods: in-kind income | Income, Other Income |
| Shopify: card remainder, adjustments | Income, Other Income, Other Current Liability (tax collected) |
| Shopify: fees | Expense, Other Expense |
| Donated goods, not capital | Expense, Other Expense, Cost of Goods Sold |
| Donated goods, capital | Fixed Asset |
| Gifts of goods: clearing account | Bank, Other Current Asset, Other Current Liability |

## 8. Not doing

- **No fallback account** for an unmapped item, anywhere in these three areas.
  [Decision — deliberate limit]
- **No per-item mapping** for the roles that stay one account by nature.
- **No bulk import of accounts,** and no matching of the rules' stored names to
  QuickBooks accounts. Finance re-picks each rule from the live list.
- **No rebooking** of entries already in QuickBooks when a mapping changes.
- **No new mapping table.** All three keys live on tables finance already edits.

## 9. Rules this design establishes

To extract into `docs/rules/revenue.md`, `docs/rules/expenses.md` and, for the
rounding rule, `docs/rules/principles.md` or `docs/conventions.md` (decided at
extraction), as each part lands:

- Revenue, Ownership: Each online-store sale, giving-platform gift and gift of
  goods books to the account finance mapped for its item. A line with no
  mapping, or whose account can't be used, waits for finance; nothing books it
  to a fallback account. A catch-all exists only as a `*` rule finance writes.
  [Decision — owner]
- Revenue, Ownership: The books map holds one account each only for what is one
  account by nature: the bank accounts, card remainder, adjustments, online-store
  fees, custom items, in-kind income, the in-kind clearing account and the
  expense payment account. [Decision — owner]
- Revenue, Income: An item is decided once finance has chosen both its bucket
  and its account. A custom item books as general income to the custom-items
  account, and waits while that account is unset. [Decision — owner] (replaces
  the custom-item exception's "without asking")
- Revenue, Donations: A giving-platform batch finishes only when every gift's
  rule has an account for each amount the gift carries. [Decision — owner]
- Revenue, Donations: A giving-platform fee reduces income. Each spreadsheet
  row's fee is split across that row's amount columns in proportion to their
  amounts, and each part is netted into its column's income line. A blank
  amount counts as zero and takes no part. A row with fees but no amount goes
  to finance. Rows are never pooled, and the parts sum to the row's fee exactly.
  [Decision — owner]
- Revenue, Income: Online-store fees are merchant-account fees on direct revenue.
  They book as an expense on their own account, never as a reduction of
  income. [Decision — owner]
- Expenses, Sending expenses to the books: A gift of goods' line books to the
  account the expense account rules give its part. A line no rule resolves to
  exactly one account waits for finance to set it. [Decision — owner]
- Principles or conventions: Whenever the app splits an amount across parts, it
  uses whole cents, the parts sum to the amount exactly, and leftover cents go to
  the largest fractional remainders. [Decision — owner]
- Revenue, Ownership: Every account the app books to must be of a type listed
  for its line or role. [Decision]

## 10. Settled questions

- **PIA-1. How a row's fee splits across its columns.** Proportional: each
  column takes the share of the fee its amount is of the row's total. Equal
  shares were the alternative; they would give a small donation riding on a
  large match half the fee. — owner, 2026-11-06
- **PIA-2. A column with no amount.** A blank amount counts as zero, and a zero
  column takes no part of the fee. A row that carries only fees, with no amount
  in any column, goes to finance. — owner, 2026-11-06
- **PIA-3. Leftover cents.** Whole cents by largest fraction, everywhere: the
  fee split, and the shared allocator that already splits an expense's tax and
  shipping, which changes from largest amount to largest fraction. Income's
  Shopify charge split moves to it too. — owner, 2026-11-06
- **PIA-4. Which columns make up "the fee".** Cause Support Fee, Merchant Fee
  and Check Fee, summed, as the app sums them today. — owner, 2026-11-06
- **PIA-5. Online-store fees.** No: they are direct fees on direct revenue, so
  they are merchant-account fees, booked as an expense on "Shopify: fees", not
  a reduction of income. — owner, 2026-11-06
- **PIA-6. How a fee shows on the deposit.** Netted into the gift's line, so the
  deposit carries net income and no separate fee line. A separate negative fee
  line was the alternative. — owner, 2026-11-06
- **PIA-7. Retiring the fees settings.** Yes: once fees reduce income,
  "Benevity: fees" and each rule's fees account stop being read and the screens
  hide them. Then they are removed, by the plan in the cutover file.
  "Shopify: fees" stays in use (PIA-5). — owner, 2026-11-06
- **PIA-8. Donated goods use the expense account rules.** Yes: one rule set, so
  a donated item and the same item bought book to the same account. A second
  rule set for gifts of goods was the alternative. — owner, 2026-11-06
- **PIA-9. Account types.** The table in §7 as proposed. — owner, 2026-11-06
- **PIA-10. A default account per role.** No default. A role's account as a
  fallback for unmapped items is a "finance cleans it up later" trap; an
  unmapped line stops and waits for finance, as unmapped inventory lines always
  have. Retires the sales, donations, matches, in-kind expense and fixed-asset
  roles. — owner, 2026-11-06
- **PIA-11. Custom store items.** They get one specific setting, "Shopify:
  custom items", rather than holding every time. — owner, 2026-11-06
