# Agreement document versions

## Problem

Members and Key Volunteers sign agreements through the app, and the app keeps a
record of each signature. That record says who signed and when, but not what
they signed. Each agreement is a single PDF file in storage. When someone
replaces that file, the next person to sign gets the new text, and nothing in
the app notices or records the change.

So if a member later asks "what did I agree to?", or the Board needs to show
which terms someone accepted, the app can't answer. The Key Volunteer Agreement
has a version number, but the number is only a counter the Board increments; it
isn't tied to any particular file, so two people at "version 1" may have signed
different text. The membership agreement has no version at all.

## Objective

Every signature record names exactly which text the person signed, and that
text can be retrieved and checked byte for byte later. Every change to an
agreement's text, however small, is a new version the Board adopts, and the
Board decides with each adoption how old a signature may be and still count.

## Executive summary

- **Versions are whole numbers.** Any change to the text, a typo fix included,
  is the next number (Board decision, for both agreements).
- **Each version is its own file, never overwritten**, with a SHA-256
  fingerprint (a hash that changes if a single byte changes) recorded when the
  Board adopts it.
- **Each adoption sets a minimum version.** A signature counts if its version is
  at or above the minimum. A wording fix leaves the minimum where it is; a
  material change raises it. The Board may also lower it.
- **Each signature records the version sent and the fingerprint of the bytes the
  app actually sent to Zoho.**
- **A nightly check compares every version file with its fingerprint** and
  raises a problem ahead of time if one has changed or gone missing. It never
  stops anyone signing.
- **For signers**, a wording fix changes nothing. When the Board raises a
  minimum, an open signing request below it is cancelled and the next "Sign"
  uses the current version. For the membership agreement the Board chooses,
  each time it raises the minimum, whether members re-sign at their next renewal
  (the default) or now; "now" asks them to sign and lists them for the Board to
  follow up, and blocks nothing.
- **For the Board**, the "new version" button becomes "adopt a version", for
  both agreements. A sysadmin places the file; only the Board adopts.
- **Existing records** are recorded at the versions in use today: membership 7
  and KVA 2, with grandfathered KVAs at 2 as well.
- **Not changed**: who must sign, and the yearly membership re-sign.
- **Cost**: one new table, a few columns on the signature record, one new
  process kind, a nightly check, a few registry entries, and a sysadmin step to
  place each new file. No new external service, and no copy of Zoho's signed PDF
  is kept.

## How it works today

Both agreements are loaded the same way: the signing code reads one fixed object
from the agreement bucket (`AGREEMENT_PDF_S3_BUCKET`), the membership agreement
from `AGREEMENT_PDF_S3_KEY` (default `membership-agreement.pdf`) and the Key
Volunteer Agreement (KVA) from `KVA_PDF_S3_KEY` (default
`key-volunteer-agreement.pdf`). The loader is
`checkin-app/src/lib/membership/contract/agreementDocument.ts`. The PDF is read
when the signer first clicks "Sign" and the app creates a Zoho request; Zoho
keeps that upload, and "Resume signing" reuses it. Outside production the app
stamps a watermark on the PDF before upload, so the bytes Zoho receives differ
from the stored file. The Zoho mock loads no PDF at all.

Signatures live on `OrgMembershipProcess` rows: `INITIAL` and `RENEWAL` for the
household's membership agreement, `PERSON_AGREEMENT` for an adult child who
signs their own, and `KEY_VOLUNTEER_AGREEMENT` for the KVA. `contractSignedAt`
marks the signature. A row can also be marked signed without Zoho: the Board can
record a signature by hand (it then clears the signer), and the Board can
pre-mark the contract on an intake row.

The KVA version is `BoardSettings.keyVolunteerAgreementVersion` (an integer,
default 1). Opening an agreement copies it onto
`OrgMembershipProcess.agreementVersion`. A person counts as signed when they hold
an `ACTIVE` KVA row with `agreementVersion >= current`. The Board's "New version
(material change)" button increments the integer, archives open agreements at
older versions, recalls their Zoho requests, and opens a new agreement for every
Key Volunteer. The card tells the Board that "a wording fix does not need" a new
version, so a wording fix today changes the file and leaves no trace.

The integer is copied when the agreement *opens*, but the PDF is read when the
request is *created*, which can be days later. A file replaced in between gives
the row one number and the signer different bytes.

The migration `20261115130000_key_volunteer_grandfather` created `ACTIVE` KVA
rows at version 1 for the existing Board, background-check reviewers and
finance, dated at migration time, with no Zoho request.

The membership agreement has no version. It is re-signed every membership year:
renewal moves the household's `RENEWAL` row into the same external step a new
applicant takes, and a `PERSON_AGREEMENT` settled before the cycle's floor is
asked again by the nightly trigger.

The System status configuration check (`checkin-app/src/lib/configHealth.ts`)
reports one row per agreement, and only says whether the bucket is set.

## Design

### A version is an adopted, immutable file

A new table, `AgreementDocumentVersion`, holds one row per adopted version of
each agreement:

| Column | Meaning |
|---|---|
| `document` | `MEMBERSHIP` or `KEY_VOLUNTEER` |
| `version` | whole number, e.g. `8` |
| `s3Key` | where the PDF is stored, e.g. `agreements/membership/8.pdf` |
| `sha256` | hex SHA-256 of the stored PDF, computed at adoption |
| `byteSize`, `pageCount` | read at adoption, for the status check |
| `minimumVersion` | the lowest version that counts as current once this one is adopted |
| `resignTiming` | membership only: `NEXT_RENEWAL` or `NOW`, the Board's choice when this adoption raised the minimum; null otherwise |
| `adoptedAt`, `adoptedById` | who adopted it, and when |
| `note` | free text from the Board: what changed |

Unique on (`document`, `version`). Rows are insert-only: no route updates or
deletes one, and there is no withdrawal (owner's decision). A faulty version is
fixed by adopting the next one, so versions only move forward. A document's
current version is its highest adopted `version`, and its minimum is that row's
`minimumVersion`.

The storage key and the fingerprint together identify the bytes. The key says
where to find them; the fingerprint proves the file found there is the one
adopted. Neither is enough alone: a key can be overwritten, and a fingerprint
with no file kept proves nothing anyone can read.

### A signature records what was sent

`OrgMembershipProcess` uses its existing `agreementVersion` integer for every
agreement kind, and gains two columns:

- `agreementVersion`: the version of the PDF the app loaded for this row's Zoho
  request. Written in the same update that stores the request id, so the two
  always agree; when a dead request is replaced, the new request's version
  replaces it. A KVA row still gets the current version when it opens, which
  the request then overwrites.
- `agreementSha256` (new): the fingerprint of the bytes the app actually sent.
  In production these are the version's bytes, so it equals the version's
  `sha256`. Outside production it is the fingerprint of the watermarked copy,
  which differs by design. Null when no PDF was sent.
- `signatureSource` (new): how the signature was made.

| Value | Meaning |
|---|---|
| `ZOHO` | signed through a Zoho request the app created |
| `BOARD_RECORDED` | the Board recorded a signature made outside the app, at the version current when recorded (owner's decision) |
| `GRANDFATHERED` | created by the grandfather migration; no request was ever sent |
| `MOCK` | signed through the Zoho mock, which sends no PDF |

The draft's `PINNED` and `UNPINNED` values are gone: with every existing
signature recorded at a known version (below), the remaining difference is
whether the app holds a fingerprint of what was sent, and a null
`agreementSha256` already says that. `GRANDFATHERED` stays separate from
`BOARD_RECORDED` because no Board member recorded those rows; a migration
created them on the owner's statement.

### Which signatures count

A signature counts when its version is at or above the document's minimum.

For the KVA, a person counts as signed when they hold an `ACTIVE` KVA row with
`agreementVersion >= minimumVersion`. With versions 2 to 4 adopted and the
minimum at 3, a signature at 3 or 4 counts and one at 2 doesn't.

For the membership agreement, the yearly cycle still decides who must sign. The
minimum decides which open requests survive an adoption and, under "now", who
is asked to re-sign before their renewal.

### Adopting a version

There is no upload screen; a sysadmin places the PDF in the bucket by hand, and
the app keeps read-only access to the bucket (owner's decision). Adoption is
Board only, for both agreements (owner's decision):

1. A sysadmin uploads the new PDF to its version key, e.g.
   `agreements/membership/8.pdf`, never over an existing key.
2. A Board member opens the agreement's card in membership settings and chooses
   "Adopt version 8". They set the minimum (it defaults to the current minimum;
   raising it is how a material change is marked) and add a note. For the
   membership agreement, when the minimum goes up, they also choose "re-sign at
   next renewal" (the default) or "re-sign now".
3. The app reads the file at that key, refuses if it's missing or its last page
   can't hold the signature fields, and shows the fingerprint, size and page
   count for confirmation.
4. On confirm, one transaction inserts the version row, writes the audit rows,
   and carries out what the new minimum requires (below).

The adopt route's registry entry grants it to `isBoardMember` alone, the same
grant as today's `POST /api/settings/membership/key-volunteer-version`; no other
role can adopt or move a minimum.

Every adoption writes an audit row naming the agreement, version, file key,
fingerprint, minimum, the renewal-or-now choice, and the Board member who
adopted it. An adoption that changes the minimum writes a second audit row with
the old and new minimum, and each cancelled request writes its own (owner's
decision).

### What an adoption does to open requests

A request open at a version that still meets the new minimum is left alone, and
its signature records that older version. A request open at a version below the
new minimum is cancelled: the row is archived and its Zoho request recalled
after the transaction commits, as the KVA bump does today. The next "Sign"
creates a request at the current version (owner's decision).

Then, by document:

- **KVA.** It has no yearly cycle, so a raised minimum always means re-sign now.
  Every Key Volunteer with no signature at or above the minimum, and no open
  agreement, gets one, as the bump's fan-out does today.
- **Membership, "at next renewal".** Nothing more opens. Each household signs the
  current version at its next renewal.
- **Membership, "now".** Each household whose current-cycle signature is below
  the minimum gets a `MEMBERSHIP_RESIGN` request for a lead's signature. Each
  adult whose own `PERSON_AGREEMENT` this cycle is below the minimum re-signs
  through a fresh `PERSON_AGREEMENT`, not through the household's re-sign.
  Nothing is blocked: membership, check-in and programs carry on. Everyone who
  still owes a signature appears on a needs-to-re-sign list on the membership
  compliance page, for the Board to chase in person (owner's decision).

The household re-sign is a new process kind, `MEMBERSHIP_RESIGN` (owner's
decision). It collects one household lead's signature on the current version,
completes on that signature alone, like `PERSON_AGREEMENT`, and blocks nothing
while open. It leaves the household's settled `INITIAL` or `RENEWAL` application
untouched. A new kind is needed because the household's signature is otherwise
part of that application, which a re-sign must not reopen, and a
`PERSON_AGREEMENT` on a lead is refused because it would shadow the household's
signing flow.

`MEMBERSHIP_RESIGN` joins the kinds that settle on the signature alone: the
per-person check in `markContractSigned`
(`checkin-app/src/lib/membership/external.ts`) and `SETTLES_ON_SIGNATURE` in
`checkin-app/src/lib/membership/lifecycle.ts`, with its edges in that file's
transition table. Left out of either, a signed re-sign would take the household
path and wait for payment and clearance it never owes.

The `PERSON_AGREEMENT` triggers skip anyone whose agreement was "handled this
cycle": one still open, or one settled since the cycle's floor. That guard is
the private `handledThisCycleWhere(personId, floor)` in
`checkin-app/src/lib/membership/personAgreementTriggers.ts`, read by
`openPersonAgreement`. The exported predicate of the same name in
`lifecycle.ts` is the household renewal sweep's and is not changed. Left as it
is, the `PERSON_AGREEMENT` guard would skip an adult who signed this cycle at a
version below the new minimum. It therefore counts a settled agreement as
handled only when its `agreementVersion` is at or above the membership minimum.
An open one still counts: if its request is below the minimum, the adoption has
already cancelled it. The "now" fan-out opens each adult's agreement through
`openPersonAgreement`, as the nightly trigger does, so both read the same guard
under the same `Person` row lock: the two can't open a second agreement for one
person, and the nightly trigger catches anyone the fan-out missed.

Lowering the minimum opens and cancels nothing; signatures back in range simply
count again.

### The nightly check

A step of the `nightly` cron reads every adopted version's file and compares
it with its fingerprint, and records each result for System status. A missing
file, or one whose bytes no longer match, becomes a notice on the Problems list,
built in `checkin-app/src/lib/problems.ts` the way the failed-email count is
(the agreement libraries are not a Problems source with stuck items to retry).
The notice names the agreement and version and links to System status, which
shows the key; it reaches the daily Problems email through the digest's
notices. Signing never checks the fingerprint and is never stopped
by a mismatch (owner's decision): the check exists to warn the Board and the
sysadmin before a signer meets a changed file, and each signature still records
the fingerprint of what it was actually sent. A signer sent an overwritten
file before the next nightly run is the gap this leaves; their signature's
fingerprint differs from the version's, which shows what they received.

### System status

The configuration check replaces its two rows with one per agreement, each
reporting:

- the current version, its key, and the minimum;
- the result of the last nightly fingerprint check for every version of that
  agreement, red when one failed;
- how many people owe a signature at the minimum: Key Volunteers for the KVA;
  for the membership agreement, the size of the needs-to-re-sign list;
- how many open requests are at a version older than the current one.

### Existing records

The owner decided that existing signatures are recorded at the versions in use
today: membership 7 and KVA 2. The Board decided the renumbering: the current
membership agreement 6.1.1 becomes 7, and the KVA 1.1.1 becomes 2.

- A sysadmin copies today's fixed-key PDFs to `agreements/membership/7.pdf` and
  `agreements/key-volunteer/2.pdf`. A one-off script, run inside ECS like every
  other one-off database task, adopts each with its fingerprint and with the
  minimum at that version, in the same transaction as the backfill below. A
  migration can't read S3, so the fingerprint can't come from SQL.
- KVA rows from the Key Volunteer build, all at `agreementVersion = 1`, move to 2,
  in the same transaction that moves `BoardSettings.keyVolunteerAgreementVersion`
  from 1 to 2; a migration moves its column default to 2. Grandfathered rows
  (no request, created by `migration:key-volunteer-grandfather`) get
  `GRANDFATHERED`; rows the Board recorded by hand (found by their audit row)
  get `BOARD_RECORDED`; the rest get `ZOHO` or, on a non-production instance, `MOCK`.
- Membership rows (`INITIAL`, `RENEWAL`, `PERSON_AGREEMENT`) that are signed get
  `agreementVersion = 7` and their source by the same rule.
- No backfilled row gets a fingerprint: the app never recorded what it sent
  them, and a null `agreementSha256` says so.
- Until `BoardSettings.keyVolunteerAgreementVersion` is dropped, the new code
  writes the KVA minimum into it, so code still serving during a deploy, which
  compares a signature's version against that column, makes the same decision.

## Open questions

None. The Board decided whole-number versions for the membership agreement
and the Key Volunteer Agreement, including renumbering the current membership
agreement 6.1.1 as 7 and the KVA 1.1.1 as 2. A typo fix to the membership
agreement after that becomes version 8, not 7.0.1.

The owner decided this doc stays one file, with no separate migration file
(`docs/DOCUMENTATION_STANDARD.md` §3.2): splitting before the build exists is
premature, and any permanent architecture doc is written after the feature is
built and its nuances are understood.

## Build: PR split

The split follows the boundary isolation rule (a change to registry entries,
scope bindings or synthetic classifications ships in its own PR) and the
expand/contract order in `docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`
(additive first; drops in a later release, after every reader has moved).

1. **Schema (expand).** The `AgreementDocumentVersion` model with its
   `resignTiming` enum; `agreementSha256` and `signatureSource` on
   `OrgMembershipProcess`; the `MEMBERSHIP_RESIGN` process kind. All with
   `@sensitivity` annotations and regenerated classifications. Nothing reads or
   writes them yet. If `AgreementDocumentVersion` is scopable (it references the
   adopting person), it needs a binding or an `OPT_OUT_PENDING_ROUTE` entry in
   the same change for `validateBindings`; the build checks which.
2. **Boundary.** Registry entries for the adopt route, the needs-to-re-sign list
   and the status fields, and the synthetic classification changes for the
   self-status and adoption responses. Boundary only; the routes stay inert.
3. **Adopt the files in use, and backfill.** A migration moves the
   `BoardSettings.keyVolunteerAgreementVersion` column default to 2 (it applies
   only to a new row, so it is safe alone). A one-off script, run on each
   instance after a sysadmin has copied the two files, reads and fingerprints
   both, then in one transaction inserts membership 7 and KVA 2, moves KVA rows
   and the `BoardSettings` value from 1 to 2, sets membership rows to 7, and sets
   `signatureSource` on every signed row. Old code therefore reads a consistent
   pair throughout, and a failure leaves nothing half done. It refuses if either
   file is missing, and re-runs as a no-op once both versions exist with the
   same fingerprints; a version already adopted with a different fingerprint
   stops it. PR 4 reaches an instance only after the script has run there: it
   is not merged until the script has run on dev, and not released until it has
   run on prod.
4. **Signing records the version.** Load the current version's file by its key;
   write `agreementVersion`, `agreementSha256` and `signatureSource` beside the
   request id; KVA "signed" by the minimum; mirror the KVA minimum into
   `BoardSettings` for code still serving during the deploy.
5. **Board adoption and follow-up.** The adopt route and settings card
   (replacing the bump button), the open-request cancellation, the membership
   "now" fan-out with `MEMBERSHIP_RESIGN` and fresh `PERSON_AGREEMENT`s, the
   "handled this cycle" guard compared against the minimum, the needs-to-re-sign list, the nightly
   fingerprint check and the System status rows. Based on `main` after PR 2
   merges, not stacked on its branch.
6. **Contract.** In a later release: drop `BoardSettings.keyVolunteerAgreementVersion`,
   remove the fixed-key environment variables and their status rows, and delete
   this doc. Any boundary removal it needs ships first in its own PR.

## Alternatives considered

- **Major.Minor numbering, counting a signature by its Major.** The first draft
  of this design. A minimum version expresses the same "wording fix needs no
  re-sign" rule without a second number, and also lets the Board lower the bar.
- **Verify the fingerprint at signing and refuse a mismatch.** Catches a changed
  file at the last moment, but stops a signer for a storage fault they can't fix.
  The nightly check warns earlier, and the signature still records what was sent.
- **S3 object-version ids instead of per-version keys.** Opaque, need bucket
  versioning, can be expired by lifecycle rules, and don't survive copying to
  another bucket or the self-hosted stack.
- **Keep Zoho's completed, signed PDF.** Would store signature images, needing a
  new sensitivity tier, retention rule and storage; not kept, and a separate
  design if wanted.
- **In-app upload.** Needs a write grant on the bucket for the app, which is the
  protection against overwriting an adopted file.
- **S3 Object Lock on the version prefix.** Would make overwrites impossible
  rather than detected. Possible later as infrastructure configuration.
