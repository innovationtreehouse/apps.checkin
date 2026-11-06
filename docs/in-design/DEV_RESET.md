# Dev reset: clean out real data, start from a known state

## Problem

The shared dev instance holds real people's data, and nothing removes it. Staff
test flows by typing in real families, uploading real receipts and real donation
reports, and checking out on the Shopify dev store with their own names and
addresses. Dev is behind org login, but it is a test system: its data is read by
anyone testing, copied into screenshots and bug reports, and handled with test
discipline rather than production discipline. Real data there is a privacy
problem.

The second problem is setup. Every time dev is reset, someone has to re-create
or re-link what the app expects in the connected services: QuickBooks Classes and
the books map, the Shopify membership variant and program products. The reset
button wipes the app's side and leaves the services unlinked, so people avoid
resetting, and the real data stays.

## Objective

1. Dev holds no real person's data except the org accounts staff sign in with,
   and a check can show that.
2. One action returns dev to a known state: every database seeded, every seeded
   user available through persona-mint, and every id the app stores for
   QuickBooks and Shopify linked to a real object in the sandbox or the dev store.
3. Nothing in the reset can reach production, the production QuickBooks company,
   the production Shopify store or the production mailbox.

## Executive summary

- **Testers** keep the dashboard's Reset button. It now
  resets every library database along with checkin's, and it re-links the
  QuickBooks and Shopify ids by name, so after a reset the budgets, books map,
  membership checkout and program checkout work with no hand setup.
- **A full reset** is a new GitHub workflow, run by hand or on a schedule. It does
  everything the button does and also clears the connected services: uploaded
  files, Shopify dev-store orders and customers, and the entries the app posted
  to the QuickBooks sandbox. A retention rule keeps the dev receipt mailbox
  clear. It ends with a check that
  reports any row that does not look seeded.
- **The services are set up once.** The Classes, accounts, products and variants
  the seed needs are created once by idempotent scripts and never deleted. The
  reset only looks them up and stores their ids.
- **What does not change:** dev's data isolation (dev holds no production
  credential), the org-login gate, persona-mint's `@example.com`-only rule, the
  `DevLedger`, and staging, which keeps its scrubbed copy of production.
- **Cost:** no new running infrastructure. A full reset is one short Fargate task
  and a few hundred API calls, under ten minutes by estimate and a few cents.

## Rules this relies on

From `docs/rules/principles.md`:

- **A non-production capability is absent in production.** Both reset paths
  decide whether they exist from `CHECKIN_ENV` alone, re-checked in the body of
  every entry point, and production holds no credential they could use.
- **Only production reaches the real company.** The full reset touches only the
  allowlisted sandbox realm, through the existing QuickBooks guards.
- **The app never reaches into the books to fix something.** The QuickBooks
  sandbox wipe deletes entries. It runs only from the workflow, against the
  sandbox, and never from the app's posting path or the dashboard. Owner
  question DR-3 asks whether that reading is right.

The repo's standing rule that audit logs are not dropped because nothing reads
them is covered under *What cannot be removed* below.

---

## Where real data gets into dev today

There is **no production-to-dev copy**. The staging copy job in the infra repo
(the one its row-security fix touched) copies production into staging only: its
target must match the `checkin_stg*` database namespace, its role owns nothing
else, and its task role reads only staging secrets. Dev's database role is scoped
to the dev database, and dev's secrets hold no production connection string.
Real data reaches dev only through people using it:

| Path | What lands | Where it stays |
|---|---|---|
| Staff Google sign-in | The staff member's own `Person`, a household, and the OAuth `Account` row with tokens | checkin dev database |
| Staff typing real people into forms | Names, dates of birth, contacts, intake notes, medical and allergy fields | checkin dev database, and `AuditLog` before-and-after snapshots of every edit |
| Receipts forwarded to the dev receipt mailbox, or uploaded | Vendor, amounts, card last digits, the forwarder's identity, the file itself | dev mailbox, receipt-files bucket, receipt and expense dev databases |
| Donation report uploads | Donor names and amounts | bulk-donation and income dev databases, uploaded-files storage |
| Shopify dev-store checkouts | Name, email, address typed at checkout | the dev store's orders and customers, the Shopify-read dev database |
| Outbound mail | Rendered mail to whoever the data names | `DevSentEmail` (dev has no Resend key, so nothing leaves) |

The QuickBooks sandbox is close to clean by construction: outside production,
only entries from a `TEST-` vendor (or a `TEST-` disbursement) post at all, so a
real receipt never reaches it. What the sandbox does hold is the app's test
entries and Intuit's own sample company.

The dashboard reset already truncates every checkin table except
`_prisma_migrations` and `DevLedger`. It does not touch the seven library
databases, the Shopify-read database, the files bucket, the mailbox or either
external service. That gap is where real data survives a reset today, and it is
also a correctness problem: the library seeds assume checkin's fresh ids (the
expense seed names "person 10" and "bucket 1"), so a real receipt left in the
receipt database is attributed to whichever seeded persona gets its old person
id.

---

## What counts as real data

Real data is anything that identifies a real person or comes from a real
financial document, unless the seed or a script created it from synthetic input.

Allowed on dev:

- **Org accounts.** A `Person` whose email is on the org domain, created by a
  staff member's own Google sign-in. Dev cannot be used without one. This matches
  the staging scrub, which keeps org-domain emails.
- **Seeded personas** on `@example.com`, and anything a macro or seed creates.
- **`DevLedger`**, which names the real staff member behind each action. It is
  the dev instance's own audit record and is kept on purpose.
- **Intuit's sample company data** in the sandbox, and the ids of sandbox and
  dev-store objects the app links to. Those ids point at fake companies and fake
  catalogs.

Everything else is real data, including a staff member's own receipt and their
own name typed into a Shopify checkout. DR-1 asks the owner to confirm this.

---

## Clean-out

### What is removed

| Store | Removed | How |
|---|---|---|
| checkin dev database | Every table except `_prisma_migrations` and `DevLedger` | Existing truncate, unchanged |
| Each library dev database (catalog, local-inventory, expense, income, receipt, bulk-donation, workflow-mapping) | Every table except its `_prisma_migrations` | Same catalog-driven truncate, per database |
| Shopify-read dev database | Every ingested row | Same truncate |
| Receipt-files bucket and uploaded-files storage, dev | Every object, every version | `DeleteObjects` over the dev bucket, including noncurrent versions if versioning is on |
| Dev receipt mailbox | Every message older than a few days | A Workspace retention rule on that mailbox, set once by an admin (DR-5); the app's mail grant is read-only |
| Shopify dev store | Orders, customers, and app-minted discount codes that the seed did not create | Admin API, through the live-test guard |
| QuickBooks sandbox | Entries carrying the app's key marker | Sandbox-only script (DR-3) |

The monitoring database is not reset; it holds telemetry about the instance, not
member data. If it turns out to store request bodies, it joins the list.

### How it is proven gone

The full reset ends with a read-only check, `dev-data-check`, that runs the same
queries anyone could run by hand and writes its result to `DevLedger`:

- every `Person` email is `@example.com` or on the org domain;
- every library database holds exactly the rows its seed writes, by count per
  table;
- the dev bucket holds no object dated before the reset, and the mailbox no
  message older than its retention window;
- the dev store holds no order, and no customer or product outside the seed's
  tags and the live-test suite's `citest-` prefix;
- the sandbox holds no entry with the app's key marker dated before the reset.

The same check runs on demand before a reset, so the first run measures how much
real data dev holds today. It reads; it never deletes.

### What cannot be removed

- **Database backups.** Aurora's automated backups keep the old data until they
  age out of the cluster's retention window. Nothing in this design shortens that.
  Any manual snapshot of the dev database should be deleted by hand once (DR-7).
- **Application logs.** CloudWatch keeps whatever the app logged, emails
  included, until the log group's retention expires.
- **Recent mail** in the dev mailbox, until the retention rule (DR-5) deletes it.
- **QuickBooks's own audit log.** Intuit records every create and delete in the
  sandbox company and offers no way to clear it. With `TEST-`-only posting it
  holds no real data.
- **Shopify's order history** for an order the API refuses to delete. I believe
  the Admin API can delete test orders on a development store but have not
  verified it on ours; the PR that builds the wipe confirms it first and falls
  back to cancelling and archiving.

### The audit-log rule on dev

The repo rule is that a log is never dropped just because nothing reads it. That
rule protects the record of what happened to real operations. It does not apply
to dev's `AuditLog`, whose rows record testers acting on fake data, and which
holds before-and-after snapshots of whatever real data was typed in. The reset
truncates it today, and keeps doing so; the staging copy truncates its copy of
the audit log before scrubbing for the same reason.

The rule does apply to dev's own audit record, `DevLedger`. It survives every
reset, and the full reset writes its result there.

---

## Reset to a known state

### Order

The databases reset together, checkin first, because every library seed refers
to checkin's ids:

1. Truncate checkin, then every library database, then Shopify-read.
2. `seedBaseline` (checkin personas, roles, tools, a program, buckets).
3. Each library's existing `db:seed`, in dependency order: global-catalog,
   local-inventory, workflow-mapping, expense, income, bulk-donation. Receipt
   starts empty, as it does today.
4. Link: look up the external objects by name and write their ids (below).
5. Ledger row.

A library without a seed stays empty after a reset, which is the state it starts
in on a fresh install. A library whose screens need data to be testable gets a
seed in its own PR.

### Seeded users

`seedBaseline` already creates the personas persona-mint offers: board,
finance, background-check reviewer, tool certifier, inventory manager,
keyholders, member families with children, and a non-member household. They stay
the only impersonation targets. Two additions:

- Each library persona its flows need, for example a budget owner who approves
  a seeded expense, so every library has someone to sign in as.
- Library seeds stop hard-coding checkin ids. They look up the persona by its
  stable email and the bucket by name, so a change to `seedBaseline`'s order no
  longer shifts them onto the wrong rows.

Staff org accounts are not seeded; each staff member's next Google sign-in
creates their account again.

### Linking the external ids

The app stores ids of objects that live in QuickBooks and Shopify. After a
truncate they are gone from the database, though the objects still exist. The
link step finds each object by a stable name and writes its id back:

| Stored id | Found by |
|---|---|
| Each bucket's QuickBooks Class (`BudgetOwner.quickBooksClassId`) | Class name, matched to the seeded bucket name |
| Books map role accounts (`BooksMapRoleAccount`) | Account name, from a fixed role-to-name table in the seed |
| Membership year variants and `BoardSettings.orgMembershipVariantId` | Product handle `dev-seed-membership`, variant per year |
| Program and program-instance product and variant ids | Product handle `dev-seed-program-…` |
| Refresher secrets (QuickBooks and Gmail tokens) | Nothing to do: they live in Secrets Manager, kept current by the refresher functions, and the reset never touches them |
| Shopify webhook subscriptions | Nothing to do: registered once against dev's stable address, held by the store |

The link step only reads QuickBooks and Shopify. A name it cannot find leaves
that id unset and is reported in the reset summary; it never creates the object.
On `local` there is no sandbox or dev store, so the link step is skipped and the
existing mocks and stand-in Classes apply.

Linking the membership variant reverses decision O4 in
`docs/ops/shopify-dev-store.md`, which keeps the dev store's variant unset. O4's
reason was that a seeded placeholder id would fail the real store's variant
check; a looked-up id is the store's own, so that failure cannot happen. DR-4
asks the owner to confirm.

---

## Connected services

Each service has three parts: what a one-time setup script creates and the reset
never deletes, what the full reset wipes, and what nothing touches.

### QuickBooks sandbox

- **Set up once:** the Classes the seeded buckets name and the accounts the books
  map roles name, created by an idempotent script in `packages/quickbooks/scripts`
  that creates only what is missing.
- **Wiped by a full reset:** Deposits, Purchases, Bills and Journal Entries
  carrying the app's key marker, found with the same created-since read the
  closed-books checks use. The closing date is set back to a fixed value so the
  closed-books gate behaves the same after every reset; I have not verified that
  the API accepts a write to the closing-date preference, and if it does not,
  setting it stays a by-hand step in the setup notes.
- **Left alone:** Intuit's sample company, every entry without the app's marker,
  and the company itself. Intuit's developer portal can reset a sandbox company
  to its sample data; that is a by-hand recovery step, not part of the reset,
  because I have not confirmed that the company keeps its realm id, and the
  allowlisted realm is fixed in infrastructure configuration.
- **Guards:** `assertQboTarget` and `assertQboClientId` as the app uses them, so
  only the allowlisted sandbox realm through the sandbox API with development
  keys; and the script refuses to start unless `QBO_ENVIRONMENT` is `sandbox`,
  as `sandbox-checks.ts` does.

### Shopify dev store

- **Set up once:** a `dev-seed-membership` product with one variant per seeded
  membership year, and one product per seeded program, tagged `dev-seed`. An
  idempotent script creates what is missing.
- **Wiped by a full reset:** every order; every customer; discount codes the app
  minted. Products are untouched unless they carry neither the `dev-seed` tag nor
  the `citest-` prefix, in which case they are listed, not deleted, so a
  hand-made product is never lost by accident.
- **Left alone:** the `dev-seed` catalog, the custom app and its credentials, the
  webhook subscriptions, and `citest-` objects, which the live-test janitor owns.
- **Guards:** the live-test guard in `shopify-live/guard.ts`, unchanged and
  unrelaxed. The domain must not be the production store, must equal a separately
  provisioned allowed domain, and must be a `*.myshopify.com` storefront.

### Gmail (dev receipt mailbox)

- **Set up once:** a Google Workspace retention rule on the dev mailbox that
  deletes mail older than a few days. The refresher's grant is
  `gmail.readonly`, so neither the app nor the reset can delete mail, and this
  design keeps it that way.
- **Wiped by a full reset:** nothing directly; the retention rule clears the
  mailbox continuously, and the reset clears the receipt database that holds
  what was read from it.
- **Seeded:** nothing in the mailbox. Seeded receipts go straight into the
  receipt database from `packages/receipt-contract-fixtures`, which is how the
  pipeline's tests already feed it.
- **Guards:** no reset code reaches the mailbox. Intake keeps
  `receiptMailboxConfig`, which refuses to bind dev to the production mailbox.

### Databases and files

- **Guards:** the task holds only dev credentials, which is the primary control.
  Before truncating, each connection asserts `current_database()` is one of the
  dev names, as the dev ledger-reconcile workflow does. The bucket name must be
  dev's.

The QuickBooks and Shopify guards check *which target*, not *which
environment*. Whether the reset exists at all is still decided by `CHECKIN_ENV`
alone, so this pairs with the principle rather than adding a second
environment signal.

---

## Who runs it, and how

| | Dashboard Reset | Full reset |
|---|---|---|
| Who | Any org member on dev, or anyone on a laptop | Anyone with Actions access, or a schedule (DR-2) |
| Where it runs | The dev app's server action | A GitHub workflow that runs a one-off task on dev's ECS cluster, with dev's task definition |
| Covers | Every database, seed, link | All of that, plus files, dev store, sandbox entries, and the check |
| Gate | `assertDevActor` (unchanged) | Dev-scoped deploy role, preflight on the task definition, in-container `CHECKIN_ENV` check; the same three layers as the dev ledger-reconcile workflow |
| Time, estimated | Under a minute | Under ten minutes, bounded by Shopify and QuickBooks rate limits |
| Cost | None | One short Fargate task, a few cents |

The full reset is not a dashboard button because a server action is bounded by
the request timeout, and because deleting QuickBooks entries does not belong in
code the app runs while serving traffic.

`local` keeps its own path: the CLI seed and each package's `db:seed`, with no
external services to touch.

---

## Owner questions

Stable ids; a resolved question keeps its number.

- **DR-1. What counts as real data?** Recommendation: everything except org
  accounts, seeded personas, `DevLedger`, Intuit's sample data and the linked
  sandbox and dev-store ids. Receipts count as real even when they are the
  tester's own; QuickBooks sandbox links do not.
- **DR-2. How often to reset?** Recommendation: the dashboard Reset on demand, as
  now, and a scheduled full reset every Monday early morning, announced on the
  dashboard's activity line. Weekly keeps the privacy exposure to days, and the
  macros rebuild a test scenario in seconds.
- **DR-3. May the full reset delete the app's own entries from the QuickBooks
  sandbox?** Recommendation: yes, entries with the app's key marker only, from the
  workflow only, never from the dashboard or the posting path. The alternative is
  to leave them; after a reset the app no longer knows them, and they show up to
  the matcher as entries finance booked.
- **DR-4. Seed the Shopify membership variant on dev?** Recommendation: yes, by
  looking up the dev store's own variant, which reverses O4 in the dev-store doc.
- **DR-5. How is the dev mailbox cleared?** Recommendation: a Workspace
  retention rule on that mailbox, deleting mail older than seven days, set once
  by a Workspace admin. The alternative is widening the dev refresher's grant
  from `gmail.readonly` to `gmail.modify` so the reset can trash mail; that adds
  write access to a mailbox for a job a retention rule does with no code.
- **DR-6. Treat staff org accounts on dev as allowed?** Recommendation: yes. Dev
  cannot be entered without one, and staging already keeps them.
- **DR-7. Delete manual dev database snapshots once?** Recommendation: yes, on
  the first full reset, by hand; automated backups age out on their own.

---

## PR plan

Each is small and stands alone; none is stacked on another. No change to the
security boundary is planned: the check reports through the workflow log and
`DevLedger`, not a new route. If a later change adds a route for it, the registry
entry ships first in its own PR.

1. **This design doc.**
2. **`dev-data-check` script** (app, read-only). Runs first, so the size of the
   problem is known before anything is deleted.
3. **Infra** (infra repo, alone): grant the dev task role delete on the dev
   bucket; confirm the dev DML roles can truncate each library database; let the
   dev deploy role run the full-reset task.
4. **Dashboard Reset covers every database** (app): truncate and reseed the
   libraries in order, with the database-name assertion.
5. **Library seeds look up ids by email and name** (app, one PR per library that
   hard-codes them).
6. **One-time setup scripts** for sandbox Classes and accounts, and dev-store
   products (scripts only).
7. **Link step** (app): read-only lookups after the seed; updates
   `shopify-dev-store.md` O4 if DR-4 is yes.
8. **Full-reset workflow and script** (app): files, dev store, then the PR 4
   reset, then the check. Sandbox wipe left out until DR-3.
9. **Sandbox entry wipe** (`packages/quickbooks/scripts`), if DR-3 is yes.
10. **Docs:** fold the standing parts into `docs/ops/dev-instance.md` and delete
    this file.

---

## Alternatives considered

- **Scrub dev in place, like staging.** The staging scrub rewrites sensitive
  columns and keeps the rows. Dev does not need the rows; they are test noise,
  and a scrub leaves real structure (household sizes, dates, amounts) behind.
  Truncate and reseed is simpler and leaves nothing.
- **Drop and recreate each dev database.** Proves more, but takes minutes per
  database, needs DDL credentials the running app does not hold, and the existing
  reset deliberately avoids it for those reasons.
- **Create the external objects on every reset.** Each reset would add another
  set of Classes and products, or delete and recreate them, breaking ids held by
  anything outside the reset. Created once and looked up by name is cheaper and
  stable.
- **A per-developer dev store or sandbox.** Ruled out by the dev-store doc's
  one-shared-store decision, and it would multiply the setup this design removes.
