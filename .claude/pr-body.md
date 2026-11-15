Design for #3279, step 4 of `docs/in-design/QUICKBOOKS_LIST_CACHE-migration.md`: the picks row (design §4, QL-7, QL-8).

## What changes

- **Each library exports `misTypedQuickBooksPicks(accounts)`.** It reads that library's stored picks and returns one line per pick that the copy lacks or lists under a type the pick doesn't accept. Lines are built with the hint-free `accountTypeRefusal`, and each one names the screen where finance re-picks.
  - **expense:** the expense account list (`LISTED_TYPES`), account rules (`bookableTypes(isCapital)`), and the hand-set account on held lines whose expense is not yet in QuickBooks (`IN_QUICKBOOKS`, now exported from `holdService`).
  - **bulk-donation:** the donation account map's donation and match accounts (`givingGift`), and hand-set accounts on gift-of-goods lines (receipt and manual) whose gift is not booked (MATCHED, CREATED, POSTING or DISMISSED). A line that the capital port lists as an asset is checked against `donatedCapital`; any other line is checked against `donatedGoods`.
  - **income:** item accounts (`storeSale`).
- **Host row "QuickBooks picks: account types"** (`checkin-app/src/lib/quickbooks/picksHealth.ts`), added to `getQuickBooksHealth`. It reads the copy through `listQuickBooksAccounts`, never QuickBooks. The row is green when every pick is accepted and red with the joined lines otherwise. While the copy is empty it reads "Not checked: the QuickBooks lists have not been copied yet." That state is green, because the "QuickBooks lists" row from step 3 flags the empty copy. If a library read fails, the row is red with "Could not read it".
- The books-map roles row is unchanged and still reads QuickBooks live (QL-6). No stored value is rewritten. There is no route or registry change.

## Tests

- One vitest unit file per library. Each shows that a pick of an accepted type passes, and that a missing pick and a mistyped pick are flagged. Expense and bulk-donation also check capital picks against Fixed Asset. Expense reads held lines only on expenses not yet booked, and bulk-donation skips lines on a booked gift.
- A jest file for the host row covers green, red with lines, "Not checked" for an empty copy, and a failed read. Every case asserts that QuickBooks is never called.
- `npm run test:affected`: every step passes. tsc for checkin-app first failed on a stale Prisma client and passed after `npx prisma generate`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
