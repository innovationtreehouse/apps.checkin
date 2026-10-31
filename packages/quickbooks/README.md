# @checkin/quickbooks

QuickBooks Online client (QB-0 to QB-2 of `docs/in-design/1272_EXPENSE_QB_INTEGRATION.md` §9): windowed
reads plus one closed-enum, create-only writer.
No SDK dependency — OAuth2 is three `fetch` calls (authorize, code→token, refresh).

## Public API

- `AccessTokenSource { current(): Promise<string> }` — the only way the client gets a token.
  The app injects a read-only source (the refresher Lambda, built in checkin-app); the client
  never refreshes or saves tokens. An expired token is an error for the caller to retry.
- `new QuickBooksClient(source, { env, realmId })` — `env` is `sandbox` | `production`.
  The production realm is refused unless `CHECKIN_ENV=prod` (unset fails closed).
  `qboRealmFromEnv()` reads `QBO_ENVIRONMENT` + `QBO_REALM_ID` under the same guard.
- Windowed readers, `from`/`to` inclusive `YYYY-MM-DD`, at most `MAX_WINDOW_DAYS` (93) wide:
  `purchasesBetween`, `billsBetween`, `billPaymentsBetween`, `depositsBetween`, `journalEntriesBetween`.
  The one unwindowed transaction read is `createdSince(entity, since)`: `Deposit`, `Purchase`, `Bill` or `JournalEntry` entries
  QuickBooks created at or after `since` (`MetaData.CreateTime`), one page of 1,000, with `full: true`
  when the page is full and more may exist. Creation time survives finance re-dating an entry, so it
  finds an app entry a dated window misses.
- `bookCloseDate()`: the books closing date (`Preferences.AccountingInfoPrefs.BookCloseDate`), or
  null when finance has set none (absent, null or empty). It throws when the read fails or the date is malformed;
  nothing caches it. It and the reference lists below are the other reads with no date window.
- Name lookups for bootstrap UIs: `accountNamed` / `classNamed` (by `FullyQualifiedName`,
  e.g. `Parent:Child`), `vendorNamed` (by `DisplayName`). Mappings store the QuickBooks Id, never a name.
- Reference lists for the FINANCE bootstrap: `accounts()`, `classes()`, `vendors()` (active entries).
- `billsBetween` returns `Balance` and `LinkedTxn`; `billPaymentsByIds(ids)` reads the payments a Bill
  links, so a caller can tell when a Bill was paid.
- Match-before-create, find half (`match.ts`, pure, no writes): `findMatch(candidates, request)` answers
  `found` (`via: "key"` for the app's own creation, `"amount"` for a hand entry), `ambiguous` or
  `not-found`. Every hit, key or hand, must
  match amount, date window and account or vendor; callers pad the window with a grace on both sides,
  since QuickBooks dates drift a day or two. A key hit that fails a check, or a matching entry carrying
  another record's key, is `ambiguous`, never `found` or `not-found`. Claimed and excluded ids are skipped. `depositCandidate`, `purchaseCandidate`
  and `billCandidate` adapt reader rows.
- The one write (QB-2) is package-internal: callers write only through `findOrCreate`, `findOrCreateInKindJournal` and `createVendor`,
  which look the key (or name) up before every create, since QBO's `requestid` dedup window is short.
  It is create-only, for `WRITABLE_ENTITIES`
  (`Purchase`, `Bill`, `Deposit`, `Vendor`). Anything else (BillPayment, Payment, JournalEntry, …), a
  Check-type Purchase, an update or a delete is refused before any request. Each entity's body is built
  from typed fields (integer cents, numeric account / Class / vendor ids), so nothing else reaches QBO.
  Purchase/Bill/Deposit go out on the `quickbooks.create` outbound surface (`public`, `internal`); Vendor
  creates and the `vendorNamed` / `customerNamed` lookups go out on `quickbooks.vendor` (`public`), which carries
  the vendor display name only.
  `key` comes from `qbKey(lane, sourceId)` (lanes never build keys themselves): `<lane>:<sourceId>`
  when it fits 50 chars of `[A-Za-z0-9._:/-]`, else `<lane>:h:<128-bit sha256 hex>`. The 50-char cap is
  QBO's documented `requestid` limit, unverified live; `qbKey` is the one place to change it. The key
  is sent as QBO `requestid` and, on Purchase/Bill/Deposit, written
  into `PrivateNote` as `[checkin:<key>]`; `appKeyOf(entry)` reads back a well-formed marker anywhere
  in the note, for the candidate adapters. Two different markers come back space-joined
  and match no key, so `findMatch` sends the entry to a person.
  Writes re-check the realm guard, so production needs `CHECKIN_ENV=prod` at write time.
- Every request has a 30 s timeout and retries a 429 once after `Retry-After` (capped at 10 s). Errors name
  the status, `intuit_tid` and QBO fault codes only, never the fault text (it can echo names and memos).
- `findOrCreateInKindJournal(client, request)` creates one in-kind gift as one balanced JournalEntry;
  no other path creates a JournalEntry. Credits go only to in-kind income and debits only to in-kind
  expense or fixed assets, by books-map role, and an unbalanced entry or a non-positive amount throws
  before any read. It matches by the app's key alone, so a hand entry of the same amount is never taken
  for the gift, and a crash after QuickBooks accepts is found by key next run.
- `findOrCreate(client, request)` (`write.ts`, stateless): the closed-books gate
  (`docs/in-design/QB_CLOSED_BOOKS.md`). It reads the record's window, runs `findMatch`, and answers
  `found` / `ambiguous` (post nothing, closed period included), `closed` (not found and dated on or
  before `closedThrough`), `needs-finance` (not found and `mayCreate` false), `created`, or `failed`
  (any error; nothing is retried here). Before a create it re-reads `bookCloseDate()` and gates on the
  later of that and `closedThrough`; a failed read is `failed`, and a create QuickBooks refuses with
  fault 6210 (closed period) is `closed`. The created `TxnDate` must sit inside the window, so a crash
  after QBO accepts is found by key next run.
- A failed request throws `QboRequestError`, whose `codes` are the fault's numeric codes.
- `createVendor(client, name, key)`: finance's "Create new". A name a Customer holds becomes
  `<name> (Vendor)`; an existing Vendor with the resulting name is returned as `found` with `via: "name"`.
- `qboString` / `qboDate` — how a caller's value enters a query: escaped / validated literals. The one
  other literal is `createdSince`'s timestamp, built by the client from a validated `Date`.
- Not on the main entry, because they read `QBO_CLIENT_SECRET` or token files and the app never
  holds either:
  - `@checkin/quickbooks/oauth` (`src/oauth.ts`): `oauthConfigFromEnv`, `authUrl`, `exchangeCode`,
    `refreshTokens`, `isExpired`. Only `qbo-refresher-function` and the operator scripts import it.
  - `src/local.ts`, operator scripts only (no export): `envAccessTokenSource()` (`QBO_ACCESS_TOKEN`),
    `fileAccessTokenSource(path)` (refreshes and re-saves the consent token file),
    `saveTokens` / `loadTokens` / `tokenFileFromEnv()` (`QBO_TOKEN_FILE`, required).

## Which company a deployment reaches (`guard.ts`)

The guard decides from our config only, never from anything QuickBooks returns.

- `assertQboTarget`: only `CHECKIN_ENV=prod` and `dev` (exactly) get a client. Prod uses the
  production API and `QBO_REALM_ID`, set by infra when the refresher secret is seeded. Dev uses
  the sandbox API and only `QBO_SANDBOX_REALM_ALLOWED`. stg, local and unset reach nothing.
- `assertQboClientId`: off prod the token must come from Intuit's development keys
  (`QBO_DEV_CLIENT_ID`), which cannot open a production company; prod refuses them.
- `assertPayloadMarked`, on every write's final body: sandbox writes carry `[checkin-test]` in
  `PrivateNote` (Vendors a `TEST-` name prefix) and never name the org; production writes never
  carry either marker. The client stamps the markers itself.
- No realm id is ever committed: both live in deploy config.

checkin builds its one client in `checkin-app/src/lib/quickbooks/client.ts` (`getQuickBooks()`,
null while off). Its token comes from the refresher Lambda (`QBO_REFRESHER_FN`): invoked with
`{ "action": "current" }`, it answers a `RefresherToken` and is the only holder of the refresh token.

### Per-environment deploy checklist (infra)

- [ ] `CHECKIN_ENV=prod` set on prod (the guard reads it raw; unset is not prod).
- [ ] stg gets no QuickBooks: no `QBO_*` env and no refresher grant in its task definition.
- [ ] `QBO_ENVIRONMENT` (`production` on prod, `sandbox` on dev) and `QBO_REALM_ID`.
- [ ] Dev: `QBO_SANDBOX_REALM_ALLOWED`, provisioned apart from `QBO_REALM_ID`.
- [ ] `QBO_DEV_CLIENT_ID` (public) on prod and dev; dev's refresher holds only the development keys.
- [ ] `QBO_REFRESHER_FN` + task-role `lambda:InvokeFunction` on that function only. The app gets
      no client secret and no Secrets Manager grant.
- [ ] Refresher: reserved concurrency 1; the refresh-token secret readable and writable by it
      alone; a weekly keepalive invoke; alarms on `invalid_grant`, and on `GetSecretValue` against the
      QBO secret by any principal other than the refresher Lambda's role.
- [ ] Prod: `QBO_REALM_ID` set with the refresher secret after consent.
- Binding a posting port (QB-2): set its `prod` flag from `CHECKIN_ENV === "prod"`, the same raw
  check the guard uses.
- Binding expense posting: `QbRefs` (`refs.paymentAccountId`, `refs.vendorIdFor`) and the posting
  port's `paymentAccountId` and reimbursee vendor table name the same QuickBooks ids; bind both
  from the same source so they cannot disagree.

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
   npm run consent -w @checkin/quickbooks
   ```

## Pull ground truth

```bash
npm run pull -w @checkin/quickbooks -- 2024-01-01 2024-12-31
```

Reads in 93-day chunks. Against the production company it also needs `CHECKIN_ENV=prod`.
Writes `.ground-truth.json` (normalized `GroundTruthRecord[]`) and prints a shape report:
row count, distinct vendors, and how many totals collide — the real collision count for the
amount-anchored vendor join.

## Sandbox checks

`npm run sandbox-checks -w @checkin/quickbooks` confirms, against the sandbox only, what the gate
relies on: Preferences reads as a one-row array, `BookCloseDate` reads as null with the books open
and as the date once closed, a create dated in a closed period fails with fault 6210 in "Required
password" closing mode, and `createdSince` returns an entry just created, by its key. Run it twice:
first with the sandbox books open, then after closing them (Settings → Account and settings →
Advanced → Close the books) with a date before today and a password. It needs the consent token
file and `QBO_ENVIRONMENT=sandbox`. The test deposits go into the bank account named
`QBO_SANDBOX_DEPOSIT_ACCOUNT` (default `Checking`), booked to the income account named
`QBO_SANDBOX_INCOME_ACCOUNT` (default `Services`), as the Chart of Accounts names them; the sample
sandbox company has both. It creates up to two `[checkin-test]` Deposits per run. Never run it against
production.

## Notes

- `realmId` (company id) is captured automatically from the consent redirect.
- Refresh tokens **rotate** on every refresh; the file source re-saves them, so don't hand-edit the token file.
- Access token lives ~1h; refresh token ~100 days.
- Going to production: switch `QBO_ENVIRONMENT=production`, re-run consent against the real company.
  The client also needs `CHECKIN_ENV=prod` to reach the production realm.
