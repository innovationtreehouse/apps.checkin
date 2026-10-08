# @inventory/quickbooks

QuickBooks Online client (QB-0 to QB-2 of `docs/in-design/1272_EXPENSE_QB_INTEGRATION.md` §9): windowed
reads plus one closed-enum, create-only writer.
No SDK dependency — OAuth2 is three `fetch` calls (authorize, code→token, refresh).

## Public API

- `AccessTokenSource { current(): Promise<string> }` — the only way the client gets a token.
  The app injects a read-only source (Secrets Manager, built in checkin-app); the client
  never refreshes or saves tokens. An expired token is an error for the caller to retry.
- `new QuickBooksClient(source, { env, realmId })` — `env` is `sandbox` | `production`.
  The production realm is refused unless `CHECKIN_ENV=prod` (unset fails closed).
  `qboRealmFromEnv()` reads `QBO_ENVIRONMENT` + `QBO_REALM_ID` under the same guard.
- Windowed readers, `from`/`to` inclusive `YYYY-MM-DD`, at most `MAX_WINDOW_DAYS` (93) wide:
  `purchasesBetween`, `billsBetween`, `billPaymentsBetween`, `depositsBetween`.
  There is no since-a-date reader.
- Name lookups for bootstrap UIs: `accountNamed` / `classNamed` (by `FullyQualifiedName`,
  e.g. `Parent:Child`), `vendorNamed` (by `DisplayName`). Mappings store the QuickBooks Id, never a name.
- Reference lists for the FINANCE bootstrap: `accounts()`, `classes()`, `vendors()` (active entries).
- `billsBetween` returns `Balance` and `LinkedTxn`; `billPaymentsByIds(ids)` reads the payments a Bill
  links, so a caller can tell when a Bill was paid.
- Match-before-create, find half (`match.ts`, pure, no writes): `findMatch(candidates, request)` answers
  `found` (`via: "key"` for the app's own creation, `"amount"` for a hand entry on amount, date window and
  account or vendor), `ambiguous`, `not-found-after-line`, `not-found-before-line` or `not-found-no-line`.
  Claimed and excluded ids are skipped. `takeoverLine(records)` is the newest hand-booked tie's date;
  app-created ties never move it, and no hand tie means no line. `depositCandidate`, `purchaseCandidate`
  and `billCandidate` adapt reader rows.
- The one write (QB-2): `client.create(request, key)`, create-only, for `WRITABLE_ENTITIES`
  (`Purchase`, `Bill`, `Deposit`, `Vendor`). Anything else (BillPayment, Payment, JournalEntry, …), a
  Check-type Purchase, an update or a delete is refused before any request. Each entity's body is built
  from typed fields (integer cents, numeric account / Class / vendor ids), so nothing else reaches QBO.
  `key` comes from `qbKey(lane, sourceId)` (lanes never build keys themselves): `<lane>:<sourceId>`
  when it fits 50 chars of `[A-Za-z0-9._:/-]`, else `<lane>:h:<128-bit sha256 hex>`. The 50-char cap is
  QBO's documented `requestid` limit, unverified live; `qbKey` is the one place to change it. The key
  is sent as QBO `requestid` and, on Purchase/Bill/Deposit, written
  into `PrivateNote` as `[checkin:<key>]`; `appKeyOf(entry)` reads it back for the candidate adapters.
  Writes re-check the realm guard, so production needs `CHECKIN_ENV=prod` at write time.
- `findOrCreate(client, request)` (`write.ts`, stateless): reads the record's window, runs `findMatch`, and
  answers `found` / `ambiguous` (post nothing), `created` (after the takeover line), `too-old` (on or
  before the line) or `no-line` (never create), or `failed` (any error; nothing is retried here). The
  created `TxnDate` must sit inside the window, so a crash after QBO accepts is found by key next run.
- `createVendor(client, name, key)`: finance's "Create new". A name a Customer holds becomes
  `<name> (Vendor)`; an existing Vendor with the resulting name is returned as `found` with `via: "name"`.
- `qboString` / `qboDate` — the only way a value enters a query: escaped / validated literals.
- Local dev and operator CLI only: `envAccessTokenSource()` (`QBO_ACCESS_TOKEN`),
  `fileAccessTokenSource(path)` (refreshes and re-saves the consent token file),
  `saveTokens` / `loadTokens` / `tokenFileFromEnv()` (`QBO_TOKEN_FILE`, required).

## One-time setup (you do this — OAuth consent can't be automated)

1. **Create a sandbox app** at <https://developer.intuit.com> → *Dashboard → Create an app → QuickBooks Online Accounting*.
2. In the app's **Keys & credentials** (Development), copy the **Client ID** and **Client Secret**.
3. Under **Redirect URIs**, add exactly: `http://localhost:8087/callback`
4. Export env vars (a sandbox company is created for you automatically):

   ```bash
   export QBO_CLIENT_ID=...
   export QBO_CLIENT_SECRET=...
   export QBO_ENVIRONMENT=sandbox        # switch to "production" later
   export QBO_TOKEN_FILE=/absolute/path/to/packages/quickbooks/.qbo-tokens.json   # gitignored
   # QBO_REDIRECT_URI defaults to http://localhost:8087/callback
   ```

5. Run consent — opens a URL, you sign in and authorize; tokens land in `$QBO_TOKEN_FILE`:

   ```bash
   npm run consent -w @inventory/quickbooks
   ```

## Pull ground truth

```bash
npm run pull -w @inventory/quickbooks -- 2024-01-01 2024-12-31
```

Reads in 93-day chunks. Against the production company it also needs `CHECKIN_ENV=prod`.
Writes `.ground-truth.json` (normalized `GroundTruthRecord[]`) and prints a shape report:
row count, distinct vendors, and how many totals collide — the real collision count for the
amount-anchored vendor join.

## Notes

- `realmId` (company id) is captured automatically from the consent redirect.
- Refresh tokens **rotate** on every refresh; the file source re-saves them, so don't hand-edit the token file.
- Access token lives ~1h; refresh token ~100 days.
- Going to production: switch `QBO_ENVIRONMENT=production`, re-run consent against the real company.
  The client also needs `CHECKIN_ENV=prod` to reach the production realm.
