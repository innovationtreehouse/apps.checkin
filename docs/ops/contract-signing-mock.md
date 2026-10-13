# Membership contract signing — dev mock

An instance without Zoho Sign credentials cannot get a membership application
through the EXTERNAL phase to payment. Three stops key on unset secrets: the gate
on the applicant's Sign action, the S3 load of the agreement PDF, and the gate on
completion-sync. The mock stands in for Zoho so signing completes offline.

It replaces the Zoho HTTP + OAuth client and nothing else. Everything from
webhook receipt onward — verify, parse, envelope match, `markContractSigned`, the
phase advance and its audit rows — is the real production path.

## When it is active

`config.zohoMockActive()` is env-level truth: the three Zoho OAuth secrets unset
**and** `CHECKIN_ENV` is not `prod`. `CHECKIN_ENV` is the only fuse — server-only,
never `NEXT_PUBLIC_`, and it falls back to `prod` when unset.

`signingMockActive()` (`checkin-app/src/lib/membership/contract/signingTarget.ts`)
layers a database override on top, and is what the mock's call sites actually ask:

| Instance | Result |
|---|---|
| prod | always real; the override is never read |
| dev or local, secrets unset | always mock; the override is never read |
| dev, secrets set | `BoardSettings.devSigningTarget` picks — `debug` → mock, `zoho` or unset → real |
| local, secrets set | always real |

The dev row is flipped from the membership settings page, so an ops-dev instance
switches between real Zoho and the interstitial without a redeploy. Setting real
Zoho secrets locally opts back into the real client.

## Running it

Locally there is nothing to configure: leave the Zoho secrets unset with
`CHECKIN_ENV=local` and the Sign action returns a URL to `/dev/zoho-sign?rid=…`
instead of a Zoho ceremony. The dev nav's "Sign" item links to the same page with
no `rid`, as a start/resume entry.

The interstitial offers "Complete signing (DEV)" and "Decline (DEV)". Complete
POSTs `/api/dev/zoho-sign/complete`, which synthesizes a `completed` Zoho payload
and fires the **real** inbound webhook at `/api/webhooks/zoho`. Going through the
webhook rather than straight to `markContractSigned` is deliberate: it exercises
the timing-safe secret compare, the payload parse, the envelope→process match and
the webhook wrapper, none of which the sync path touches. The shared secret stays
server-side — `config.zohoWebhookSecret()` falls back to a fixed dev value only
while the mock is active, so the self-fired webhook verifies with zero setup. It
guards nothing real, since the payload is generated locally.

Signing is recorded twice and that is fine: the webhook marks the contract signed,
then the `?signed=1` redirect's status sync tries again, and the conditional update
on `contractSignedAt: null` no-ops the second time — no duplicate audit row, no
double advance.

In mock mode the S3 agreement PDF is skipped and an empty placeholder passed
instead. The mock never uploads bytes, and the S3 load 503s on an instance with no
bucket wired, which would block signing just as the missing Zoho secrets do.

## Prod fuse

`config.zohoAvailable()` is `zohoConfigured() || zohoMockActive()`. In prod the
second disjunct is false, so prod requires real Zoho secrets exactly as it did
before the mock existed. Both dev surfaces — the `/dev/zoho-sign` page and
`/api/dev/zoho-sign/complete` — return 404 whenever `signingMockActive()` is false,
which in prod is always.

Unit tests hold the fuse: `config.test.ts` and `zohoProvider.test.ts` cover the
env-level predicate, `signingTarget.test.ts` covers the matrix above, including
that prod never reads the database override and that a dev instance running the
production image (`NODE_ENV=production`) still gets the mock — `CHECKIN_ENV` alone
decides.

## What it does not exercise

The real Zoho HTTP and OAuth calls, their error and timeout paths and token
caching; the embedded signing UX and real envelope ids; and the dead-request
recovery path, since the mock always reports `completed` and its requests never
expire.

The board's "Reset signing" works in mock mode: the mock's recall is a no-op, so
the reset clears the stored request and writes its audit row without contacting
Zoho, and the next lead to click gets a fresh mock request.
