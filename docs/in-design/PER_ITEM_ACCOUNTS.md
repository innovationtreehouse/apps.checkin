# Per-item accounts: a default per role, overrides per item

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

Separately, the giving platform charges fees that the app books as an expense.
The owner has ruled that they are a reduction of income, and that each fee
reduces the income line of the money it was taken from.

## Objective

Every line the app books takes its account from the most specific setting
finance made for it: an item's own account where finance set one, the role's
account otherwise. Giving-platform fees reduce the income lines they were taken
from, row by row, and always sum to the fee exactly. Each role, and each
override standing in for it, accepts only accounts of the types that role can
sensibly hold.

## Executive summary

- **Finance** keeps one books-map account per role, which stays required and is
  the default. On three screens it already uses, it can set an account for one
  item that wins over the role:
  - the income items screen, per store item, for sales;
  - the giving-platform account rules, per rule, for gifts and matches (the
    rules already exist; they gain account pickers that read QuickBooks live);
  - the expense account rules, per part, for donated goods, both the expense
    side and donated equipment: a donated item books where the same purchase
    would.
- **Giving-platform fees** stop booking to a fees account. Each spreadsheet
  row's fee is split across that row's amount columns, and each part reduces
  income on its column's account.
- **The books map** refuses an account whose QuickBooks type doesn't fit the
  role, as it already does for the expense payment account. Every override
  passes the same check as the role it stands in for.
- **Nothing in QuickBooks changes**, and no stored setting is rewritten. A new
  setting applies to entries created after it is saved.
- **Cost:** six or seven small PRs, one of them boundary-only. No new screen and
  no new table; three existing tables gain a nullable column. The
  giving-platform accounts come back first and on their own, since losing them
  is a regression; the cutover file traces it.

Online-store fees keep their own account until the owner decides whether they
follow the giving-platform treatment (PIA-5).

## Waiting on the owner

Stable IDs; a settled question keeps its number and moves to §10.

- **PIA-3. Leftover cents, which rule the shared allocator uses.** Settled so
  far: whole cents, with the parts summing to the fee exactly, through the same
  code that splits an expense's tax and shipping across its lines (§5.2). Open:
  that code hands leftover cents to the *largest amounts*, not the largest
  fractional remainders the owner named. Either keep its rule for both, or
  change the shared code to largest remainder, which also changes how new
  expenses split tax and shipping. Row 3 of §5.2 is the case where they differ.
- **PIA-5. Online-store fees.** Do they follow the same treatment? If yes, each
  charge's fee splits across the order's lines by the weights the charge already
  splits by, and each part reduces that item's sales account; the part that
  follows tax and shipping reduces the card-remainder account. If no, they stay
  on "Shopify: fees". §6.3.
- **PIA-6. How a fee shows on the deposit.** Recommended: a separate negative
  line on the column's account and Class, described as fees, so the gross gift
  stays readable in QuickBooks. The alternative nets the fee into the gift's
  line.
- **PIA-7. Retiring the fees settings.** Once fees reduce income, "Benevity: fees"
  and each rule's fees account choose nothing. Recommended: the role and the
  column stop being read and the screens stop showing them; the stored values
  stay until a later decommission the owner schedules. Same for "Shopify: fees"
  if PIA-5 is yes.
- **PIA-8. Donated goods use the expense account rules.** Recommended: yes, one
  rule set, so a donated item and the same item bought book to the same account.
  The alternative is a second rule set of the same shape for gifts of goods only.
- **PIA-9. Account types per role.** Confirm the table in §7.

## Rules this relies on

From `docs/rules/revenue.md`:

- The books map says which account each named role books to; only finance edits
  it, each edit is recorded, and every area reads it when it books. *This design
  changes it*: a role's account becomes the default, and finance may set an
  account per item that wins over it (§9).
- A change to an item's mapping applies to deposits created afterwards and never
  rebooks one already created. Extended to accounts.
- The app never changes or deletes anything already in the books.
- A giving-platform batch is finished only when every gift has a clear place in
  the books, and a finished batch can't be changed. The account a gift books to
  is fixed when its batch finishes.
- Sales are booked to the program or fund they belong to. Unchanged: the bucket
  still picks the Class; the account is a separate choice on the same item.

From `docs/rules/expenses.md`:

- An account rule names its part by GTIN-13, or `*` for any part.
- Each expense line reaches the books on one account. A line the mappings do not
  resolve to exactly one account waits for finance.
- Donated equipment goes through the same capital thresholds, review and
  register as purchased equipment.
- Accounts are picked one at a time from QuickBooks' live lists; the app never
  imports the chart of accounts and never matches names on its own.

## 1. The pattern

Every booked line has a **role**. The role's books-map account is required and
is the default. An **override** is an account finance set on something more
specific than the role. Resolution:

1. Find the line's override. Each area keys overrides by what it already knows
   about the line (table below).
2. An override that is set wins. One that is unset, or no override at all,
   falls through to the role's account.
3. An override that is set but now unusable (deleted or inactive in QuickBooks,
   or of a type the role refuses) holds the entry for finance with the reason. It
   never falls back silently to the role.
4. The resolved account id is written on the line when the entry is built, so a
   later settings change can't move a line already handed over.

| Role | Override lives on | Keyed by | Exists today |
|---|---|---|---|
| Shopify: sales | Income item (`/income/items`) | Store variant | The item row exists (it carries the bucket); the account column is new |
| Benevity: donations, employer matches | Giving-platform account rule (`/donations/account-map`) | Company name, campaign (`*` allowed), donation method, donation type | Rules exist and already pick a single match; they hold account *names*, not ids |
| Gifts of goods: in-kind expense, fixed assets | Expense account rule (`/expense/account-mapping`) | Category, subcategory, GTIN-13 (`*` allowed), capital flag | Rules exist and already resolve expense lines |

The role stays in the books map because it is what makes the lane bindable:
System Status and each lane's "missing" check still require every role, and an
area with no overrides set books exactly as it does today.

What stays role-only: the two bank accounts, Shopify card remainder and
adjustments, in-kind income, the in-kind clearing account and the expense
payment account. Nothing has asked for them to vary by item; one gains an override only
when finance names two accounts it needs.

## 2. Account types per role

Each role names the QuickBooks account types it accepts. The books map refuses
any other on save and alerts finance when a stored account later reads as the
wrong type, as it does now for the expense payment account. An override is
checked against its role's list, both when finance saves it and when an entry is
built.

The list lives beside `BOOKS_MAP_ROLES` in `@checkin/quickbooks`, so the books
map, the three override screens and the posting code read one table. The
account pickers filter to the allowed types, so a wrong pick is hard to make in
the first place.

## 3. Online-store sales

- Income items gain a nullable QuickBooks account id beside the bucket. Finance
  sets it with the same picker the books map uses, filtered to the sales role's
  types.
- `buildDepositLines` already splits each charge across the order's lines; each
  line now carries its item's override account, or none. Lines are grouped by
  account and bucket instead of bucket alone, so membership sales and program
  sales in one payout become two deposit lines.
- An item with an account but no bucket books at organisation level on that
  account. The rule that an undecided item holds its payout is unchanged; an
  account alone does not count as decided.
- Custom items, which have no store item behind them, book on the role.

## 4. Gifts of goods

The journal entry keeps its shape: in-kind income credited, each line debited.
Today each debit picks `INKIND_EXPENSE` or, for a line with capital-register
rows, `FIXED_ASSETS`. Now:

- A line with a GTIN-13 is resolved against the expense account rules, through a
  port the host binds to expense's rule matcher (the same matcher expense lines
  use, with the capital flag set from whether the line has asset rows). Category
  and subcategory come from the catalog, as for expense.
- One matching rule (or one exact-GTIN rule among several) supplies the account.
  No match, or a line without a GTIN-13, falls through to `INKIND_EXPENSE` or
  `FIXED_ASSETS`. Several matches with no exact-GTIN winner holds the gift for
  finance, as expense does. Unlike expense, no match is not a hold, because
  the in-kind role is a usable default.
- The resolved account is checked against the role the line would otherwise
  use, so a capital line can't land on an expense account or the reverse.

Lines are already one debit each, so nothing groups differently.

## 5. Giving-platform gifts

### 5.1 Accounts

The account rules keep their matching exactly as today; each rule gains nullable
QuickBooks account ids for donations and matches, picked from the live list. The
name columns stay, read-only, shown beside the picker as what finance wrote
before.

When a batch finishes, each gift's matched rule is already resolved. Its ids are
written onto the batch's items alongside the names, and the hand-over carries
each line's account id to income. Income's expected-deposit line gains an
optional account id, checked against the line's role on intake and used in place
of the role when present.

Lines are grouped by kind, account and bucket, so one batch can hold several
donation lines.

A batch finished before the rule had an id carries none and books on the role.

### 5.2 Fees reduce income

The export's columns, per row:

| Column | Meaning |
|---|---|
| Donation Amount (or Total Donation to be Acknowledged) | The employee's gift |
| Match Amount | The employer's match |
| Cause Support Fee, Merchant Fee, Check Fee | Fees taken from the row, summed (PIA-4, settled) |

The row's fee is split across the row's amount columns in proportion to their
amounts (PIA-1, settled). A blank amount counts as zero and a zero column takes
no part of the fee (PIA-2, settled). A row with only fees holds its batch for
finance, on the same holds screen as a gift no rule matches. Leftover cents
follow PIA-3. Each part books as a reduction of income on that column's account
and the gift's Class (PIA-6). Rows are never pooled: the split is per row, and
parts are summed into lines only after each row is split.

Worked examples (fee $2.50 on each row):

| Donation | Match | Largest amount (expense today) | Largest remainder |
|---|---|---|---|
| $100.00 | $100.00 | $1.25 / $1.25 | $1.25 / $1.25 |
| $100.00 | $50.00 | $1.67 / $0.83 | $1.67 / $0.83 |
| $5.00 | $95.00 | $0.12 / $2.38 | $0.13 / $2.37 |
| $40.00 | $0.00 | $2.50 / — | $2.50 / — |
| $0.01 | $0.02 | $0.83 / $1.67 | $0.83 / $1.67 |

Rounding: each column's exact share is floored to whole cents. The leftover
cents go one at a time to the columns with the largest amounts (expense's rule
today) or the largest fractional remainders (PIA-3). In the third row the
shares are 12.5¢ and 237.5¢: by amount the cent goes to Match; by remainder it
is a tie, and the tie goes to Donation. The last row shows a fee larger than its
gifts: both parts book negative, which is what happened. A batch that nets to
zero or less is already refused and raised for finance.

One allocator does this for both areas. Expense's `allocateAmount`, which splits
tax, shipping and discount across an expense's lines, moves to `@checkin/money`.
Expense and bulk-donation both call it, so there is one rounding rule to keep.
Income's own split of a Shopify charge across order lines rounds differently
(toward zero, with the remainder at organisation level); PIA-5 decides whether
it moves to the shared allocator too.

This replaces the fees role and each rule's fees account (PIA-7).

### 5.3 Where it runs

The split happens in bulk-donation when the batch finishes, because that is
where the row is whole. The batch's items gain the fee part on each amount item,
so the hand-over to income needs no fee item and income needs no fee logic.

## 6. QuickBooks entries

### 6.1 Several accounts on one entry

Nothing new is needed on the QuickBooks side. A Deposit already carries one
account and Class per line, and income already writes one line per role and
bucket; overrides only make more lines. A JournalEntry already carries an account
per line. A negative Deposit line (a fee) is accepted as long as the deposit's
total is positive, which the existing nets-to-zero check guarantees.

### 6.2 Matching and drift

Matching finds a finance-booked deposit by bank account, date and total, never by
line accounts, so overrides don't change what matches. The drift check compares
an app-created entry with what the app posted; it starts comparing line accounts
only if it already does for that area. A matched entry booked by finance is
never rebooked to apply an override (deliberate limit, unchanged).

### 6.3 Online-store fees (if PIA-5 is yes)

Each charge's fee splits by the same weights the charge used across its order
lines, with the part that follows tax and shipping on the card-remainder
account. Refund fees follow the refund's weights. Fees on transactions with no
order lines (adjustments) stay whole on adjustments.

## 7. Account types (PIA-9)

| Role | Accepts |
|---|---|
| Shopify payouts: bank account; Benevity disbursements: bank account | Bank |
| Expense payment | Bank, Credit Card (unchanged) |
| Shopify: sales; Benevity: donations, employer matches; Gifts of goods: in-kind income | Income, Other Income |
| Shopify: card remainder, adjustments | Income, Other Income, Other Current Liability (tax collected) |
| Shopify: fees (while it exists) | Expense, Other Expense, Income, Other Income |
| Gifts of goods: in-kind expense | Expense, Other Expense, Cost of Goods Sold |
| Gifts of goods: fixed assets | Fixed Asset |
| Gifts of goods: clearing account | Bank, Other Current Asset, Other Current Liability |

A stored role account that fails the check stops its lane at the next run and
alerts finance once, naming the role. Nothing is rebooked.

## 8. Not doing

- **No override for every role.** Only the four roles the owner named.
- **No bulk import of accounts,** and no matching of the rules' stored names to
  QuickBooks accounts. Finance re-picks each rule from the live list.
- **No rebooking** of entries already in QuickBooks when an override changes.
- **No new override table.** All three keys live on tables finance already edits.

## 9. Rules this design establishes

To extract into `docs/rules/revenue.md` and `docs/rules/expenses.md` as each
part lands:

- Revenue, Ownership: The books map's account for a role is the default. Finance
  may set an account for one store item, one giving-platform rule, or one part
  that wins over its role. Each such account must be of a type its role accepts,
  and an item whose account can't be used holds for finance rather than falling
  back to the role. [Decision — owner]
- Revenue, Donations: A giving-platform fee reduces income. Each spreadsheet
  row's fee is split across that row's amount columns in proportion to their
  amounts, and each part reduces income on its column's account. A blank amount
  counts as zero and takes no part. A row with fees but no amount goes to
  finance. Rows are never pooled, and the parts sum to the row's fee exactly.
  [Decision — owner] (plus the PIA-3 answer)
- Revenue, Income: online-store fees, per PIA-5.
- Expenses, Sending expenses to the books: A gift of goods' line books to the
  account the expense account rules give its part, or to the in-kind role when no
  rule names it. [Decision — owner] (if PIA-8 is yes)
- Revenue, Ownership: Each books-map role accepts only accounts of the types
  listed for it. [Decision]

## 10. Settled questions

- **PIA-1. How a row's fee splits across its columns.** Proportional: each
  column takes the share of the fee its amount is of the row's total. Equal
  shares were the alternative; they would give a small donation riding on a
  large match half the fee. — owner, 2026-11-06
- **PIA-2. A column with no amount.** A blank amount counts as zero, and a zero
  column takes no part of the fee. A row that carries only fees, with no amount
  in any column, goes to finance. — owner, 2026-11-06
- **PIA-4. Which columns make up "the fee".** Cause Support Fee, Merchant Fee
  and Check Fee, summed, as the app sums them today. — owner, 2026-11-06
