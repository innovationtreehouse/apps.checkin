# Receipts: tooling for the historical QuickBooks receipt load

## Problem

The organization has years of past receipts, each already booked in QuickBooks.
Loading them into checkin teaches the receipt-matching tables what past purchases
looked like and seeds the capital register. Nothing is booked again. Checkin can
already take these receipts in, but only as prepared batches, and nothing turns a
pile of old receipts into those batches. The tools that did this lived in the
Inventory prototype repos, which are being retired.

## Objective

An operator can turn the old receipts into import batches, check them, and load
them into checkin in steps they can verify, using tools kept in this repo.

## Executive summary

- **Operators** get four scripts under `packages/receipt/scripts/`, run by hand.
  They are not app code and not part of any request path.
- **Finance** runs the load through the existing finance-only import route. No new
  route, page or schema is needed.
- **Not changed:** the import route and its checks. Imported receipts go through
  the ordinary pipeline marked `backfill`, and downstream never posts them to
  QuickBooks again.

Tracked on #2569. The rest of the receipt design has been built and is described
in `docs/architecture/RECEIPT.md` and `docs/architecture/RECEIPT_PIPELINE.md`.

---

## 1. The tools

Port these from the Inventory prototype repos. Find the current versions first:
`Inventory2/scripts/` holds `upload-receipt.sh` and `upload-all-receipts.sh`, and
`Inventory3/receipt-processing/` may hold the rest.

| Tool | Job |
|---|---|
| Mailbox split | splits an exported mailbox (`mbox`) into one message per file, as `receipt-load-app/scripts/mbox-extract.py` did |
| File prep | pulls each receipt file out and records its type |
| OCR batch | reads each file with the receipt library's own OCR call (`createAnthropicOcr` in `packages/receipt/src/lib/ocr.ts`). The source's `claude -p` CLI backend and its per-mode model routing are not ported. |
| QuickBooks matcher | ties each receipt to the QuickBooks transaction it was booked as, giving `qbTxnId` and `qbEntity` |

## 2. What the import route accepts

`POST /api/receipts/import` is a finance-only route. Its schema is
`ImportBatchSchema` in `packages/receipt/src/lib/schemas.ts`, and the tools'
output must pass it:

- At most 50 receipts per call, written in one transaction. One bad row refuses
  the whole batch.
- Each row needs `importSourceId`, `qbTxnId`, retailer, date, total and at least
  one line, plus the file as base64 with its type. The file follows the upload
  rules: 10 MB at most, and its content must match its type.
- The schema is strict. A row carrying `needsReimbursement` or `reimbursementFor`
  refuses the batch, because an import never reimburses anyone.
- A re-run skips rows already loaded, by the unique `(orgId, importSourceId)`, so
  a batch can be sent again safely.

The vendor compliance check for the Anthropic API, which the OCR batch uses, is
recorded on #1266.

## 3. Done looks like

- The four tools are in `packages/receipt/scripts/` as operator scripts.
- They produce batches that pass the import route's checks.
- A short runbook in `docs/ops/` covers prepare, dry run, import in batches, and
  verify.
- The tools have run against a small real sample.

At merge, delete this doc. It records no standing rules: the import rules are
already recorded.

---

*Design for #1265 (X7 prep tooling), tracked on #2569; referenced without closing
keywords.*
