# QuickBooks go-live

This runbook turns on QuickBooks posting in production: expenses, Shopify income,
Benevity donations and gifts of goods. Run the steps in order, because each lane
switches itself on permanently the first time its daily job can post, and nothing
turns that off. Finance's closing date has to be in place before that happens.

This document says what to do and what to check. It never records whether a step
has been done; the System Status page and QuickBooks answer that.

## Who does what

| Who | Needs | Steps |
|---|---|---|
| Engineer | Intuit development keys; the sandbox company | 1, 7 |
| Finance | Access to close the books in QuickBooks; the FINANCE role in the app | 2, 5, 6 |
| QuickBooks authoriser | A login allowed to connect apps to the production company | 3 |
| Infra operator | AWS access to the production secret; the infra repository | 3, 4, 7 |
| Sysadmin or Board member | Access to System Status, the only roles that can read it | The check after each step from 4 onward |

## How to read System Status

Open **System Status** (`/system-status/health`). The rows named below are in its
configuration health panel, and its cron runs panel lists `qbo-posting` once the
job has run. The QuickBooks rows are cached for a minute, so a change can take that
long to show.

A green row doesn't always mean what you'd hope, and two cases matter here:

- **QuickBooks books closing date** is green with the detail "None set." Read the
  detail, never the colour.
- **A posting lane** is green at "Bound." That means it can post, not that it has
  run. "Posting switched on" followed by a date appears only after a run.

The nav badge doesn't count these rows, so a red QuickBooks row raises no badge.

## 1. Run the sandbox checks

**Who:** Engineer.

The closed-books gate depends on how QuickBooks behaves, so confirm that behaviour
against the current API first. The script refuses to run against anything but the
sandbox, and creates up to two test deposits there per run. Run it on a checkout
that contains [#2794](https://github.com/innovationtreehouse/apps.checkin/pull/2794),
because every lane's lookup and sweep use the query that PR changed.

Export `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` from the development keys,
`QBO_ENVIRONMENT=sandbox`, and `QBO_TOKEN_FILE` set to an absolute path. Then get
a token and run the first pass with the sandbox books open:

```bash
npm run consent -w @checkin/quickbooks
```

```bash
npm run sandbox-checks -w @checkin/quickbooks
```

For the second pass, close the sandbox books (Settings, then Account and settings,
then Advanced, then Close the books) with a date before today and the "Required
password" mode, and run `sandbox-checks` again.

**Done when** both passes exit 0 with every line reading `PASS`, and the second
pass reports the create refused with fault 6210. A `FAIL` stops the go-live: bring
it to an engineer, because the gate may not hold in production.

## 2. Set the closing date in QuickBooks

**Who:** Finance.

Close the books in the production company, using the "Required password" mode the
sandbox checks exercised. The app never creates an entry dated on or before this
date; it can still link a record to an entry finance already booked there. The
owner's ruling named 2026-06-30 as the first value, so confirm with finance that
this is still the date before setting it.

Do this before step 3. With no date set, the app treats the day before a lane's
switch-on as closed, so it stays safe, but that line depends on when each lane
happened to start rather than on finance's books.

**Done when** QuickBooks shows the date under Close the books. The app can't read
it yet; step 4 confirms it.

## 3. Consent and seed the token

**Who:** QuickBooks authoriser and infra operator, together, since the code is
short-lived.

The refresher Lambda is the only holder of the production refresh token. The app
holds no client secret. Intuit rejects localhost for production keys, so use the
manual script.

Export the production `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`
set to the exact https URI registered on the production app, and `QBO_TOKEN_FILE`
set to an absolute path outside any shared folder. Then:

```bash
npm run consent:manual -w @checkin/quickbooks
```

Open the printed URL, authorise the production company, and paste the full URL the
browser lands on; an error page there is fine. The script writes the token file
and prints the company's `realmId`.

Seed the refresher's secret in Secrets Manager with the token file's fields plus
the two keys:

```json
{ "clientId": "", "clientSecret": "", "accessToken": "", "refreshToken": "",
  "obtainedAt": 0, "expiresIn": 3600, "realmId": "" }
```

`clientId` must be the production client id; the refresher refuses the development
one. Then delete the token file. Intuit rotates the refresh token on each refresh,
so anything that refreshes from that file (`npm run pull` does) invalidates the
token in the secret and takes production QuickBooks down until someone repeats
this step.

Never commit or paste the realm id, tokens or client secret anywhere in this
repository; it is public.

**Done when** the secret holds all seven fields and the token file is gone. Step 4
proves the secret works.

## 4. Connect the app

**Who:** Infra operator.

These settings live in the infra repository. Check each one rather than assuming
it:

| Where | Setting |
|---|---|
| App task | `CHECKIN_ENV=prod`, `QBO_ENVIRONMENT=production`, `QBO_REALM_ID` from step 3, `QBO_DEV_CLIENT_ID`, `QBO_REFRESHER_FN`, `QBO_POSTING_CRON_SECRET` |
| App task role | `lambda:InvokeFunction` on the refresher only, and no Secrets Manager grant on its secret |
| Refresher Lambda | `QBO_ENVIRONMENT=production`, `QBO_DEV_CLIENT_ID`, `QBO_SECRET_ID`; reserved concurrency 1; secret readable and writable by its role alone |
| Refresher alarms and schedule | Weekly keepalive invoke; alarms on `QBO_INVALID_GRANT` and on any other principal reading the secret |
| Posting schedule | The daily rule that calls `/api/cron/qbo-posting` with `QBO_POSTING_CRON_SECRET` |

The app reads these at boot, so they take effect when a new task rolls out. Leave
`INCOME_MIRROR_NEWEST_WINS` unset until step 7.

Setting `QBO_REALM_ID` is the first thing that can start a clock. Donation begins
handing completed Benevity disbursements to income, and income stamps Benevity's
switch-on at the first run that has one due, before finance has picked its
accounts. That's safe: those rows wait for their accounts, and anything that
arrived before the stamp goes to finance rather than booking itself.

**Done when** System Status shows:

- **QuickBooks connection**: "Connected to the production company."
- **QuickBooks books closing date**: "Books closed through" the date from step 2.
  "None set." sends you back to step 2.
- `qbo-posting` in the cron runs panel with a recent successful run and no error,
  the day after the schedule is on. The configuration panel has no row for the cron
  secret, so this run is the only proof of it.

"Off:" on the connection row names the cause, such as a missing setting or a failed
refresher. The refresher failing with an invalid grant means step 3 has to be
repeated.

## 5. Fill in the books map

**Who:** Finance, with the FINANCE role, on the Books map screen (`/books-map`).

The account picker reads QuickBooks live, which is why this follows step 4. Each
save is audited. Each pick can switch a lane on at the next daily run, and that
can't be undone, so don't pick an account to try it out. Clearing a role later
stops the lane from posting, but the switch-on date stays.

| Lane | Roles on the screen | What the app enforces | Status row |
|---|---|---|---|
| Expenses | Organisation card | Must be a Bank or Credit Card account; any other type is refused and finance is alerted | QuickBooks posting: expenses |
| Shopify income | Shopify payouts: bank account; Shopify: sales, card remainder, fees, adjustments | All five | QuickBooks posting: Shopify income |
| Benevity | Benevity disbursements: bank account; Benevity: donations, employer matches, fees | All four | QuickBooks posting: Benevity donations |
| Gifts of goods | Gifts of goods: in-kind income, in-kind expense, fixed assets (donated equipment), clearing account (finance's past bookings) | All four, and a clearing account different from both bank accounts and the Organisation card | QuickBooks posting: gifts of goods |

Then give each budget bucket its QuickBooks Class on the same screen, and assign
Shopify items to buckets on the income items screen (`/income/items`). A payout with
an undecided item, or a bucket that can't be used, holds for finance rather than
posting.

**Done when** the Expenses, Benevity and gifts-of-goods rows read "Bound.", and the
Shopify income row lists only the switch as missing:
"Unbound; missing: the switch INCOME_MIRROR_NEWEST_WINS=true."

## 6. Clear the first day's queue

**Who:** Finance, the day after step 5.

After the next daily run, each bound lane's row adds "Posting switched on" with a
date. The Shopify income row won't until step 7.

Records that existed before a lane's switch-on never book themselves. The app
matches them to finance's entries, and sends whatever it can't match to finance to
book or skip. Records created after switch-on book themselves, matching first. So
a queue on the first day is expected:

- **Expenses:** the QuickBooks panel on each expense, where finance books it or
  picks the entry already booked. Skipping with a reason needs
  [#2734](https://github.com/innovationtreehouse/apps.checkin/pull/2734) in the
  deployed release; without it, an expense finance won't book stays in the queue.
- **Benevity and Shopify:** income reconciliation (`/income/reconciliation`).
- **Gifts of goods:** `/donations/in-kind`.

Spot-check the first few entries the app creates in QuickBooks: each memo carries a
`[checkin:<key>]` marker and each date falls after the closing date.

**Done when** every bound lane shows its switch-on date, `qbo-posting` shows no
error, and finance has decided the queue or chosen to work it down over time.

## 7. Turn on Shopify income

**Who:** Engineer for the sandbox check, then the infra operator, only after two
fixes have deployed.

`INCOME_MIRROR_NEWEST_WINS=true` tells the app that the Shopify mirror can't let an
older payout overwrite a newer one, and it lets income start booking payouts. Two
fixes have to be live first, because each one stops a wrong deposit:

- [#2733](https://github.com/innovationtreehouse/apps.checkin/pull/2733) makes the
  mirror keep the newest payout. Deposit lines are built from those rows, so without
  it a deposit could book a stale amount.
- [#2791](https://github.com/innovationtreehouse/apps.checkin/pull/2791) holds a
  payout whose charge has no order lines. Without it, that charge books whole to
  organisation-level income with no Class.

Confirm all four of these:

1. Both PRs are merged. These print their commits:

   ```bash
   gh pr view 2733 --json mergedAt,mergeCommit
   ```

   ```bash
   gh pr view 2791 --json mergedAt,mergeCommit
   ```

2. A release tag contains both commits. Run this for each commit:

   ```bash
   git tag --contains <merge commit>
   ```

3. The production deploy run for that tag, or a later one, passed its "Deploy
   s-read (prod)" step. #2733 ships in s-read and #2791 in the app. s-read deploys
   after the app, so this step passing covers both, and a green rollout alone
   doesn't.

4. The sandbox checks pass on a checkout that contains
   [#2794](https://github.com/innovationtreehouse/apps.checkin/pull/2794). That PR
   added `ORDERBY` to the query behind income's lookup and orphan sweep, and its
   tests stub QuickBooks, so this script is what runs the query against real
   QuickBooks. If step 1 ran on an older checkout, set up as step 1 describes and
   run `npm run sandbox-checks -w @checkin/quickbooks` again. It must exit 0 with
   the `created-since` line reading `PASS`. A `FAIL` stops this step: leave the
   variable unset and bring it to an engineer.

Then set the variable on the app task and roll it out. On the next daily run,
income reconciles first and stamps afterward, so every payout the mirror already
holds counts as older than switch-on and goes through step 6's queue; only payouts
seen after that book themselves.

**Done when** the Shopify income row reads "Bound." straight after rollout, and adds
"Posting switched on" with a date after the next daily run.

## Afterwards

**A cap stops a run.** Income's per-run limits on deposit count and dollars email
finance, and the rest waits for the next run. A deposit over the dollar cap holds
for finance.

**To stop posting.** Unset `INCOME_MIRROR_NEWEST_WINS` to stop Shopify creation, or
clear a lane's role in the books map to stop that lane. Unsetting `QBO_REALM_ID`
stops every lane. None of these clears a switch-on date, and entries already in
QuickBooks stay; voiding one is finance's job.

**If the refresh token dies** (an alarm on `QBO_INVALID_GRANT`, or the connection
row reporting the refresher failed), repeat step 3 and reseed the secret. The other
settings stay as they are.
