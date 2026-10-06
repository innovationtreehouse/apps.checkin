# Income: one-time load of historic Shopify exports into the mirror

The Shopify API does not reach back far enough to cover the store's whole
history. The older part exists only as CSV exports. This file is the one-time
load that puts them into the s-read mirror, where income reads everything. It
stops being true once the load has run; its last step deletes it.

## What runs

`income-app/scripts/csv-to-fixtures.mjs` in `innovationtreehouse/Inventory`,
run from a checkout pinned at `07797b59`. It is not ported into checkin. It
reads three exports from one directory and writes a fixtures file that s-read's
`inject` command loads:

| Export (filename prefix) | Becomes | Shopify id from |
|---|---|---|
| `orders_export*` | `ORDER` | the `Id` column |
| `payment_transactions_export*` | `BALANCE_TXN` (the payout↔order link) | the `Payout ID` column |
| `payouts_export*` | `PAYOUT` | none in the file: joined from the transactions by date + net |

`inject` validates each node with the schemas the live API path uses, logs it
to `shopify_raw_event` tagged `HAND_LOADED`, and projects it into the `shop_*`
tables, idempotent by Shopify id. Re-running the load is safe.

**Known losses** (accepted; none affects the deposit match, which uses payout
net and date): all payout fees are folded into one charges-fee figure;
marketplace sales tax and advances are dropped.

## Before loading

0. **Wait for the mirror provenance fix.** Today `inject` tags only the
   `shopify_raw_event` row; the projected `shop_*` rows carry no provenance, so a
   hand-loaded payout or order is indistinguishable from Shopify data, and
   `inject` has no production guard, actor or reason. The load runs only after the
   fix that marks hand-loaded rows in the live `shop_*` tables and guards
   `inject` ("Mark and guard hand-loaded Shopify mirror rows", owned outside the
   port) is deployed to the target environment. Income reads that mark (§2 of the
   design).
1. **Trim every export to dates before s-read's `CUTOVER_DATE`.** Rows from the
   cutover on already came from the API under the same Shopify ids. Loading them
   would overwrite those rows with the less detailed CSV values.
2. **Set `STORE_ID` to the live store's myshopify domain**, the value s-read's
   `store` table records, so the loaded rows sit with the API's.
3. **Run the conversion and read its warnings.** Count the payouts whose id came
   from the bank reference or a synthetic date key (`payoutBankRef`,
   `payoutNoId`). Those payouts get no transactions, so income will raise each
   as `TXN_SUM_MISMATCH`; finance clears them in the queue. If the count is
   large, check the transactions export for missing date ranges before loading.
   Also count `payoutDateOnly`: those payouts took the only id on their date even
   though the amounts didn't agree, so the id may be wrong. Income raises them as
   `TXN_SUM_MISMATCH` too.

## Load

From inside the VPC, or through the RDS-Proxy tunnel, with the mirror's
write credential (checkin's own grant on the mirror is SELECT-only):

```bash
node income-app/scripts/csv-to-fixtures.mjs <csvDir> fixtures.json
```

```bash
SHOPIFY_READ_DATABASE_URL=<mirror> STORE_ID=<store> npm run inject -w s-read-function -- fixtures.json
```

Load dev first, then prod.

## Effect on checkin's existing payment checks

- **The daily order reconciler** reads orders whose `updated_at` passed its
  cursor. Loaded orders have no `updated_at`, so in an environment whose cursor
  is already set they are never picked up. In a fresh environment (cursor
  unset) they are read once; expect `UNMATCHED_ORDER` noise there, not in prod.
- **The match audit** treats an activation whose order id is below the mirror's
  oldest order as pre-mirror history, not a gap. The load lowers that mark, so
  old activations become checkable. The ones whose order is in the exports
  verify. The ones whose order is missing now show as `ORDER_NOT_IN_MIRROR`
  gaps. Review that list once after the prod load; it is the measure of how
  complete the exports were.

## Done when

- The `HAND_LOADED` count in `shopify_raw_event` matches the fixture count, in
  prod, and the same rows carry the hand-loaded mark in the live `shop_*`
  tables.
- The `TXN_SUM_MISMATCH` rows from step 3 and the new `ORDER_NOT_IN_MIRROR`
  gaps are each either explained or cleared.

Then delete this file.
