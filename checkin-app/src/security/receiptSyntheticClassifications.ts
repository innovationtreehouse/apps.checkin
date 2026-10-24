/**
 * Non-Prisma response models the receipt library ships through handler()
 * (the catalogSyntheticClassifications.ts pattern).
 *
 * ReceiptView — the receipt as the library returns it: `Receipt` and its
 * `ReceiptDetail` flattened into one row (repositories/receipt.ts `ReceiptRow`),
 * plus the detail screen's line items and review reasons and "My receipts"'
 * paid status (`reimbursement`: `{ paidOn }` or null), and on a finalized receipt
 * not yet delivered to receiving its push record: whether catch-up has given up
 * (`pushGivenUp`), and the latest failure's time and message (`lastPushFailedAt`,
 * `lastPushFailure`). The message is the push_failed audit row's `valueAfter`, so
 * it keeps that column's `personal` tier. Tiers match the generated
 * models field for field. No file column is listed, so the stripper drops one if
 * a projection ever passes it through: the file leaves only through the file
 * route (plan rule 7).
 *
 * ReceiptLineView — a line item stamped with its receipt's `uploadedByUserId`.
 * A line row has no owner column of its own, and the stripper scopes each nested
 * row by itself, so without the stamp a submitter's `their_own` view would strip
 * every line of their own receipt. A line without the stamp fails closed.
 *
 * ReceiptQueueCounts — how many of the org's receipts each review queue holds:
 * a count per state, finalized receipts not yet delivered, and those catch-up
 * gave up on. Counts only, `internal`.
 *
 * ReceiptImportResult — one row of a bulk-import response. ReceiptPushResult —
 * a manual S1 re-send's outcome. Both are financial plumbing, `internal`.
 *
 * ReceiptIgnoredFileView — one entry of the mailbox ignore list: a file's hash,
 * finance's free-text reason, the adding person's id and when. All `internal`
 * (owner ruling 2026-10-16): a hash fingerprints a file without holding it.
 *
 * ReceiptFlowStatus — how many records sit in each state of the receipt flow:
 * receipts (plus finalized ones not yet delivered), receiving records and
 * expenses, each a list of `{ state, label, count }`, and when they were read.
 * Counts only, no record field. Receiving and the time are `public`, matching
 * WorkflowReceiptCount; receipts and expenses are `internal`.
 *
 * Hand-authored, not generated: these describe API responses, not tables. This
 * is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  ReceiptView: {
    id: "internal",
    orgId: "internal",
    uploadedByUserId: "internal",
    uploadedAt: "internal",
    fileHash: "internal",
    mimeType: "internal",
    needsReimbursement: "internal",
    reimbursementFor: "pii",
    reimburseePersonId: "internal",
    intakeSource: "internal",
    isInKind: "internal",
    donorFirstName: "pii",
    donorLastName: "pii",
    donorCompanyName: "pii",
    donorSync: "internal",
    pushedAt: "internal",
    retailer: "internal",
    receiptNumber: "internal",
    orderNumber: "internal",
    receiptDate: "internal",
    currency: "internal",
    shippingCents: "internal",
    taxCents: "internal",
    discountCents: "internal",
    receiptTotalCents: "internal",
    state: "internal",
    ocrStartedAt: "internal",
    duplicateFlaggedAt: "internal",
    duplicateFlagClearedAt: "internal",
    duplicateSuspectReceiptId: "pii",
    duplicateSuspectIsRejected: "pii",
    validationNotes: "personal",
    approvedAt: "internal",
    reviewedAt: "internal",
    qbTxnId: "internal",
    qbEntity: "internal",
    importSourceId: "internal",
    financialReviewReasons: "internal",
    complete: "internal",
    reimbursement: "internal",
    pushGivenUp: "internal",
    lastPushFailedAt: "internal",
    lastPushFailure: "personal",
  },
  ReceiptLineView: {
    id: "internal",
    receiptId: "internal",
    uploadedByUserId: "internal",
    lineNumber: "internal",
    description: "internal",
    partNumber: "internal",
    manufacturer: "internal",
    quantity: "internal",
    unitPriceCents: "internal",
    totalPriceCents: "internal",
    isDelayed: "internal",
  },
  ReceiptImportResult: {
    importSourceId: "internal",
    status: "internal",
    id: "internal",
    state: "internal",
    error: "internal",
  },
  ReceiptPushResult: {
    pushed: "internal",
  },
  ReceiptQueueCounts: {
    byState: "internal",
    notPushed: "internal",
    pushGivenUp: "internal",
  },
  ReceiptFlowStatus: {
    asOf: "public",
    receipt: "internal",
    receiving: "public",
    expense: "internal",
  },
  ReceiptIgnoredFileView: {
    id: "internal",
    orgId: "internal",
    fileHash: "internal",
    reason: "internal",
    addedByUserId: "internal",
    createdAt: "internal",
  },
} as const;

export const relations = {
  ReceiptView: {
    lineItems: { model: "ReceiptLineView", isList: true },
  },
} as const;
