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
text can be retrieved and checked byte for byte later. Both agreements use the
project's Major.Minor document numbering: a Major change is material and needs
a fresh signature; a Minor change fixes wording or format and doesn't, but is
still recorded.

## Executive summary

- **Each agreement version becomes a registered record**: a document (membership
  or Key Volunteer), a Major.Minor number, the storage location of its PDF, and
  the PDF's SHA-256 hash (a fingerprint that changes if a single byte changes).
  Version files are stored once and never overwritten.
- **Each signature points at the version whose bytes were sent to Zoho**,
  written at the moment the app uploads the PDF to create the signing request.
- **The app checks the fingerprint every time it loads a PDF.** If the stored
  file no longer matches its registered hash, signing stops with a clear error
  instead of sending unregistered text.
- **For signers nothing changes**, except that a Minor change no longer goes
  unrecorded. A Key Volunteer who signed 2.0 still counts as signed when 2.1 is
  current; a Major change asks them to sign again, as the Board's "new version"
  action does today.
- **For the Board**, the "new version" action becomes "register a version",
  choosing Major or Minor. The System status page shows each agreement's current
  version and whether its file still matches.
- **Existing records**: Key Volunteer version 1 becomes 1.0. Signatures made
  before this design (grandfathered Key Volunteers, board-recorded signatures,
  earlier Zoho signatures) are marked as signatures whose exact bytes the app
  can't prove, rather than being given a false pin.
- **Not changed**: who must sign, when, and the renewal cycle. The membership
  agreement is still signed fresh each membership year.
- **Cost**: one new table, two new columns on the signature record, a few
  registry entries, and a sysadmin step to place each new PDF. No new external
  service. Optionally, archiving Zoho's completed copies adds storage of signed
  PDFs (open question 9).

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

### A version is a registered, immutable file

A new table, `AgreementDocumentVersion`, holds one row per version of each
agreement:

| Column | Meaning |
|---|---|
| `document` | `MEMBERSHIP` or `KEY_VOLUNTEER` |
| `major`, `minor` | the version number, two integers |
| `s3Key` | where the PDF is stored, e.g. `agreements/key-volunteer/2.1.pdf` |
| `sha256` | hex SHA-256 of the stored PDF |
| `byteSize`, `pageCount` | for the status check and a quick sanity read |
| `registeredAt`, `registeredById` | who registered it, and when |
| `note` | free text from the Board: what changed |

Unique on (`document`, `major`, `minor`). Rows are insert-only: no route updates
or deletes one. The current version of a document is its highest registered
(`major`, `minor`), compared as a pair of integers, never as text ("2.10" sorts
before "2.9" as text).

The storage key and the hash together identify the bytes. The key says where to
find them; the hash proves the file found there is the one registered. Neither
is enough alone: a key can be overwritten, and a hash with no file kept proves
nothing anyone can read.

### A signature names the version sent

`OrgMembershipProcess` gains:

- `agreementDocumentVersionId Int?`: the version whose PDF the app loaded and
  sent to Zoho for this row's request. Written in the same update that stores
  the request id, so the two always agree. When a dead request is replaced, the
  new request's version replaces it too.
- `agreementEvidence`: how the app knows what this row's signer saw. One of:

| Value | Meaning |
|---|---|
| `PINNED` | the app sent the registered bytes of `agreementDocumentVersionId` |
| `UNPINNED` | signed through Zoho before this design; the bytes aren't known |
| `BOARD_RECORDED` | the Board recorded a signature made outside the app |
| `GRANDFATHERED` | created by the grandfather migration; no request, no bytes |
| `MOCK` | signed through the Zoho mock, which sends no PDF |

On a non-production instance the uploaded bytes carry the watermark, so they
are not the registered bytes. The row still records `PINNED` to the version the
watermark was stamped onto; the watermark is a pure function of that file and a
fixed string, so the registered version determines it.

### Loading verifies the fingerprint

Signing asks for the current version of a document, reads its `s3Key`, and
hashes what it read. If the hash differs from `sha256`, the load fails with the
existing `AgreementUnavailableError` (the sign endpoint returns a clean 503) and
logs an error naming the version. A replaced file therefore stops signing
instead of being sent under the wrong number. The fixed-key environment
variables are then unused and are removed in the contract stage below.

### "Signed the current version"

For the KVA, a person counts as signed when they hold an `ACTIVE` KVA row whose
version has the current Major: signed 2.0 with 2.1 current counts; signed 2.1
with 3.0 current does not. Comparing only the Major is what makes a Minor change
free for signers.

Registering a Major version runs today's fan-out: archive open agreements at an
older Major, recall their requests, open one for every Key Volunteer.
Registering a Minor version opens and archives nothing. An open agreement with
no request yet picks up the new Minor at its first "Sign" click, because the
version is written when the request is created. An open agreement whose request
already exists keeps the earlier Minor's bytes (open question 4).

For the membership agreement, nothing reads the version to decide who must
sign; the yearly cycle decides. The version is a record of what was signed
(open question 6 covers a mid-year Major change).

### Getting a new version in

There is no upload screen today; a sysadmin places the PDF in the bucket by
hand. The proposal keeps that and adds one Board step:

1. A sysadmin uploads the new PDF to its version key, e.g.
   `agreements/key-volunteer/2.1.pdf`, never over an existing key.
2. A Board member opens the agreement's card in membership settings, chooses
   "Register Minor version" or "Register Major version", and adds a note.
3. The app computes the next number (2.0 → 2.1, or 2.1 → 3.0), reads the file
   at that number's key, refuses if it's missing or its last page can't hold the
   signature fields, and shows the hash, size and page count for confirmation.
4. On confirm it inserts the version row; for a Major version of the KVA it runs
   the fan-out above in the same transaction.

The app never writes to the agreement bucket, so its task role keeps read-only
access, and nothing the app does can overwrite a registered file.

### System status

The configuration check replaces its two rows with one per agreement, each
reporting:

- the current version number and its key;
- whether the key exists and its bytes still match the registered hash (red if
  either fails: signing is stopped);
- for the KVA, how many Key Volunteers have no signature at the current Major;
- how many open agreements hold a request for an older version.

Hashing the current file on each status load means one small read per agreement;
the PDFs are a few hundred kilobytes.

### Migration of existing records

- Before the backfill, a sysadmin copies today's fixed-key PDFs to
  `agreements/key-volunteer/1.0.pdf` and `agreements/membership/1.0.pdf`, and a
  one-off script (run inside ECS, like every other one-off database task)
  registers each as version 1.0 with its hash. A migration can't read S3, so the
  hash can't come from SQL.
- KVA rows: `agreementVersion = 1` links to KVA 1.0. Grandfathered rows (no
  `zohoEnvelopeId`, actor `migration:key-volunteer-grandfather` in their audit
  row) get `GRANDFATHERED`; board-recorded rows (found by their audit row) get `BOARD_RECORDED`; the rest
  that carry a request get `UNPINNED`. They keep counting as signed, because
  their Major is 1.
- Membership rows (`INITIAL`, `RENEWAL`, `PERSON_AGREEMENT`) signed before the
  cutover get `UNPINNED` or `BOARD_RECORDED` and no version (open question 8).
  They age out within one membership year as households re-sign.
- `OrgMembershipProcess.agreementVersion` and
  `BoardSettings.keyVolunteerAgreementVersion` stay written, as the Major, until
  no running code reads them, then are dropped.

## Open questions

Each question has a concrete example and a proposed answer. None is decided
until the owner answers it.

| # | Question | Example | Proposed answer |
|---|---|---|---|
| 1 | How does a version identify exact bytes? Options: a hash on the record; immutable per-version keys; S3 object-version ids; keeping Zoho's completed copy. | The KVA file is replaced on 3 March. A signer from 1 March asks what they signed. | Immutable per-version keys plus a SHA-256 hash, verified on every load. S3 version ids are opaque, need bucket versioning, can be expired by lifecycle rules, and don't survive copying to another bucket or the self-hosted stack. A hash alone keeps no readable copy. Zoho's completed copy exists only after signing, so it can't say what was offered; see question 9 for keeping it as well. |
| 2 | Where is the number stored: two integer columns, or one string "2.1"? | Versions 2.9 and 2.10. | Two integers on the version row, displayed as "Major.Minor". Strings sort wrongly. |
| 3 | Does "signed the current KVA" compare only the Major? | Current is 2.1; someone signed 2.0. | Yes; they count as signed. A Minor bump never asks anyone to sign again. |
| 4 | A Minor version is registered while someone has a Zoho request open at the previous Minor. Leave it, or recall and reissue? | A request at 2.0 is open; the Board registers 2.1 to fix a typo. | Leave it; they sign 2.0, which still counts, and the record says 2.0. Reissuing costs a Zoho request per signer for a change the Board has called non-material. |
| 5 | Who registers a version, and who decides Major vs Minor? | A sysadmin uploads a corrected PDF and thinks it's a typo fix. | The Board registers and chooses Major or Minor, as it bumps the KVA today; a sysadmin only places the file. |
| 6 | When the membership agreement gets a Major version mid-year, must current members sign it now, or at their next renewal? | 3.0 is registered in January; the year renews in September. | At their next renewal; the yearly re-sign is the existing mechanism. An "ask everyone now" action can follow if the Board wants one. |
| 7 | Is there an in-app upload, or does the sysadmin keep uploading by hand? | The Board wants to publish a fix without a sysadmin. | By hand for now, plus the in-app register step. An upload route needs a write grant on the bucket for the app, which is the protection against overwrites. |
| 8 | Which version do pre-cutover and board-recorded membership signatures get? | A renewal signed in June 2026, before any version existed. | None, with evidence `UNPINNED` or `BOARD_RECORDED`. Linking them to 1.0 would claim bytes nobody can show they saw. They age out within a year. |
| 9 | Keep Zoho's completed, signed PDF as well? | A dispute needs the signed copy with the signature on it. | Not in this build. It would store signature images (a new sensitivity tier, retention rule and bucket prefix) and only covers Zoho signatures; propose it as its own design if the Board wants it. Zoho keeps the completed document meanwhile. |
| 10 | Does a board-recorded signature name a version? | The Board records a paper KVA signature in May, when 2.1 is current. | Yes, the current version at recording, with evidence `BOARD_RECORDED`; the Board attests the paper matched it. Without a version the KVA check can't tell whether it counts. |
| 11 | Can a version be withdrawn, making an earlier one current again? | 2.1 turns out to have a broken signature page. | No; register 2.2 with the fix. Versions only move forward, so "current" is always the highest. |
| 12 | Are grandfathered KVAs 1.0 with evidence `GRANDFATHERED`? | A Board member grandfathered on 15 November 2026. | Yes; their Major is 1, so they keep counting until a Major version. |

## Build: PR split

The split follows the boundary isolation rule (a change to registry entries,
scope bindings or synthetic classifications ships in its own PR) and the
expand/contract order in `docs/ops/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md`
(additive first; drops in a later release, after every reader has moved).

1. **Schema (expand).** The `AgreementDocumentVersion` model, the two nullable
   columns and the `agreementEvidence` enum, with `@sensitivity` annotations and
   regenerated classifications. Nothing reads or writes them yet.
   If `AgreementDocumentVersion` is scopable (it has a person reference), it
   needs a binding or an `OPT_OUT_PENDING_ROUTE` entry in the same change for
   `validateBindings`; the build checks which.
2. **Boundary.** Registry entries for the register-version route and the
   status fields, and the synthetic classification changes for the self-status
   and version-bump responses (`agreementVersion` becomes a "Major.Minor"
   label). Boundary only; the routes stay inert.
3. **Register 1.0 and backfill.** The one-off script that registers each
   document's 1.0 from the copied file, then the evidence backfill for existing
   rows. Data only.
4. **Signing reads versions.** Load by current version with hash verification;
   write `agreementDocumentVersionId` and `agreementEvidence` beside the request
   id; KVA "signed current" by Major; old integer columns still written as the
   Major for code still serving during the deploy.
5. **Board register step and System status.** The register-version route and
   settings card (replacing the bump button), and the new status rows. Based on
   `main` after PR 2 merges, not stacked on its branch.
6. **Contract.** In a later release: drop `OrgMembershipProcess.agreementVersion`
   and `BoardSettings.keyVolunteerAgreementVersion`, remove the fixed-key
   environment variables and their status rows. Any boundary removal it needs
   ships first in its own PR.

## Alternatives considered

- **Keep the integer and add a hash column.** Pins bytes but can't express a
  recorded Minor change, and doesn't fix the membership agreement's missing
  number.
- **Store the PDF in the database.** Self-contained, but puts binary documents
  into every backup and every dev reset, and the bucket already exists for this.
- **S3 Object Lock on the version prefix.** Would make overwrites impossible
  rather than detected. Worth adding later as infrastructure configuration; the
  hash check gives the same guarantee from the app's side without it.
