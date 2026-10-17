# Background-check consent mock

The background-check vendor (Averity/VERITY) exposes no API and no dev sandbox.
A check is started by sending the applicant to a hosted consent page, and the
result comes back as email to a human. So on a laptop or a cloud-dev instance
there is no way to *start* a check at all: an application can never reach the
board's review queue, and the two-reviewer sign-off can't be exercised end to
end. The mock exists to close exactly that gap. The contract-signing mock
(`contract-signing-mock.md`) and the Shopify webhook mock are built the same way.

## What it stands in for

Only the vendor's own step. The applicant is handed an in-app consent
interstitial instead of Averity's hosted page; confirming there records **real**
consent and advances the application into parallel board review. Everything from
that point on — including the two-reviewer attestation on the membership-ops
review queue — is the production path, unmodified.

The system never holds a check result either way, in production or under the
mock: what it stores is the consent flag and the reviewers' attestations.

## Turning it on

Active when **both** hold:

- `AVERITY_CONSENT_URL` is unset, and
- `CHECKIN_ENV` is `dev` or `local`.

A local dev instance with default env therefore has it on, and no flag needs
setting. To exercise the real Averity link from a dev instance instead, set
`AVERITY_CONSENT_URL` — the real link always wins.

## The prod fuse

`CHECKIN_ENV` is the single fuse and it fails safe: any value that isn't `dev`
or `local` — including unset, and including the staging value `stg` — reads as
prod and the mock is off. Both mock surfaces (the consent interstitial and its
completion endpoint) check the same predicate and 404 when it is false, so no
mock path is reachable in production by construction.

**Do not add `NODE_ENV` as a second fuse.** Every deployed instance runs the
production image, so `NODE_ENV=production` is true on cloud-dev exactly as it is
on prod. It cannot distinguish the two, which means it adds no production safety
— all it does is switch the mock off on the dev instances that need it.
