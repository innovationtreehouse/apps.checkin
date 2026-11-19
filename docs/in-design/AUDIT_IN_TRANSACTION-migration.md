# Audit rows commit with the change — cutover

The one-time part of `AUDIT_IN_TRANSACTION.md`: which call sites move, in which
PRs. Everything here expires when the last PR merges.

Inventory taken with `git grep -nE '(prisma|db)\.auditLog\.create'` over
`checkin-app/src` on `origin/main` at `4fa679bb7`. Line numbers are the
`auditLog.create` line. Re-run the grep before each PR: lines drift.

The grep finds 41 sites: 35 on the root client and 6 in helpers that take a
`DbClient` parameter (`lib/attendance/close.ts` ×3, `lib/membership/review.ts`,
`lib/membership/selfGrantGuard.ts`, `lib/trusted-adult/service.ts`). The six
helpers stay as they are; their callers pass a transaction client, except the
refusal recorder's.

Sites already written with a transaction client (`tx.auditLog.create`, 91 of
them) are not listed; they are correct. Library packages are out of scope.

## Inventory — moves inside the change's transaction (28 sites, 23 files)

"Has tx" means the change already runs in a transaction and the audit write only
moves into the callback. "Wrap" means the change is a bare root-client statement
and the two are wrapped together. "Needs db param" means the change happens in a
library function that only uses the root client.

### Programs and volunteers

| Site | Change | Fix |
|---|---|---|
| `app/api/programs/[id]/volunteers/route.ts:70` | add volunteer | has tx |
| `app/api/programs/[id]/volunteers/route.ts:140` | remove volunteer | wrap |
| `app/api/programs/[id]/volunteers/route.ts:219` | set core flag | has tx |
| `app/api/programs/[id]/participants/route.ts:247` | enroll / re-enroll | has tx (the stock-write callback); the exit path at `:421` already uses its `audit` option |
| `app/api/programs/route.ts:298` | create program | has tx |
| `lib/programs/update.ts:367` | edit program | has tx |
| `lib/programAnnounce.ts:66` | claim announcement | wrap the claim `updateMany`; the email stays after |
| `app/api/events/route.ts:128` | create events | wrap |
| `lib/lifecycleDrift.ts:174` | clear stranded hold | has tx (stock-write callback); `shopifyReleaseOk` is only known after commit and leaves the row (design rule 6) |

### Households and people

| Site | Change | Fix |
|---|---|---|
| `app/api/household/lead/route.ts:61` | promote lead | wrap; `addHouseholdLead` nests via `withTx` |
| `app/api/household/lead/route.ts:143` | remove lead | wrap; `removeHouseholdLead` nests via `withTx` |
| `app/api/household/emergency-contacts/route.ts:30` | add contact | wrap; service takes a client |
| `app/api/household/emergency-contacts/[contactId]/route.ts:20` | edit contact | wrap |
| `app/api/household/emergency-contacts/[contactId]/route.ts:52` | delete contact | wrap |
| `app/api/membership-ops/participants/[id]/household/route.ts:130` | move person between households | has tx |
| `app/api/membership-ops/contacts/route.ts:43` | create contact person | needs db param: `createParticipantWithHousehold` (`lib/auth-options.ts`) opens its own transaction on the root client; give it `db: DbClient = prisma` and `withTx` |
| `app/api/profile/route.ts:86` | edit own profile | wrap |

### Membership

| Site | Change | Fix |
|---|---|---|
| `lib/membership/external.ts:240` | set signing envelope | wrap the `updateMany`, re-read and audit |
| `lib/membership/external.ts:605` | store signing request | wrap the `updateMany` and audit; the Zoho call stays before and the recall path stays in the `catch`, so a failed audit now recalls the request too |
| `lib/membership/grant.ts:74` | grant via certify | first check whether `activate`'s own row (reached from `certifyPaymentPlan`) already carries the reason and year. If it does, delete this row. If not, pass the fields through to that row rather than threading a client through the certify path |

### Finance and settings

| Site | Change | Fix |
|---|---|---|
| `app/api/finance-ops/payments/[id]/route.ts:68` | acknowledge / resolve exception | wrap |
| `app/api/finance-ops/s-read/match-audit/track/route.ts:159` | track a match gap | needs db param on the three `track*` functions, which call `raisePaymentException`; use `recordPaymentException(tx, …)` inside the transaction and notify the board after commit |
| `app/api/admin/settings/localization/route.ts:60` | timezone / locale | wrap |
| `app/api/settings/email/route.ts:138` | acknowledgement templates | needs db param: `writeTemplateFields` (`lib/email-templates/settingsFields.ts`) uses the root client; wrap upsert, template write and audit |
| `app/api/settings/outreach/route.ts:82` | outreach templates | same as above |

### Shop

| Site | Change | Fix |
|---|---|---|
| `app/api/shop/tools/route.ts:61` | create tool | wrap |
| `app/api/shop/tools/[id]/route.ts:32` | edit tool | wrap |

### Cron

| Site | Change | Fix |
|---|---|---|
| `app/api/cron/nightly/route.ts:155` | purge adult dates of birth | wrap the raw `UPDATE … RETURNING` and the `createMany` |

## Inventory — stays outside, by design (allowlist)

| Site | Why |
|---|---|
| `lib/membership/selfGrantGuard.ts:88` (`recordSelfGrantRefusal`; root-client callers in `finance-ops/payments/[id]`, `membership/intake.ts`, `membership/review.ts`, `receipt/mailAliases.ts` ×2, `trusted-adult/service.ts`, and every `refuseSelfGrant(prisma, …)`) | refusal; must survive it |
| `lib/receipt/mailAliases.ts:136` | refusal (no passing mail item) |
| `lib/finance/reconcile/reversals.ts:330` | observation; nothing changed |
| `app/api/finance-ops/s-read/sync/route.ts:53` | attempt at an outside system, written before the call |
| `app/api/system-status/problems/retry/route.ts:40` | attempt at a library retry, written with its outcome |
| `lib/shopifyWebhookReceipt.ts:138` | inbound delivery receipt |
| `app/api/cron/nightly/route.ts:121` | board notice; each closed visit has its own row in its transaction |
| `app/api/dev/shopify/orders-paid/route.ts:88` | dev-only mock marker |

## PR split

Seven PRs. None touches `checkin-app/src/security/**` or `src/middleware.ts`, so
none is a boundary PR. No registry entry changes: each fix edits a handler body,
not its route definition. PRs 2–7 depend only on PR 1 and can merge in any order;
each is based on `main`, not on PR 1's branch.

| PR | Scope | Sites | Proof |
|---|---|---|---|
| 1 | `recordAudit` + `AuditEntry` in `lib/auditActor.ts`; the guard test with all 41 sites allowlisted (the 28 to fix, marked "to fix", the 7 by-design root-client ones, and the 6 `DbClient`-param helpers) | 0 | guard passes on `main` |
| 2 | Programs and volunteers | 9 | guard entries removed; integration test on volunteer removal |
| 3 | Households and people, including the `createParticipantWithHousehold` db param | 8 | guard entries removed; integration test on lead removal |
| 4 | Membership (`external.ts`, `grant.ts`) | 3 | guard entries removed; integration test on setting the signing envelope |
| 5 | Finance and settings, including the `writeTemplateFields` and `track*` db params | 5 | guard entries removed; integration test on resolving a payment exception |
| 6 | Shop tools | 2 | guard entries removed; integration test on tool edit |
| 7 | Nightly date-of-birth purge | 1 | guard entry removed; existing nightly integration suite extended |

PRs 2–7 rewrite each moved site onto `recordAudit` with `personActor` or
`systemActor`, which replaces the hand-built `actorId:` payloads at those sites.
In-transaction sites outside these files keep their hand-built payloads.

## Last step

When PR 7 merges: record the rule in `AUDIT_IN_TRANSACTION.md` → *Rules relied
on or changed* as a standing rule under *Accountability*, and delete both
files.
