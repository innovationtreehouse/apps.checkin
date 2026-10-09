/**
 * Non-Prisma response models the receipt library ships through handler()
 * (#1265 §6; the catalogSyntheticClassifications.ts pattern).
 *
 * ReceiptView — the receipt as the library returns it: `Receipt` and its
 * `ReceiptDetail` flattened into one row (repositories/receipt.ts `ReceiptRow`),
 * plus the detail screen's line items and review reasons and "My receipts"'
 * paid status (`reimbursement`: `{ paidOn }` or null). Tiers match the generated
 * models field for field. No file column is listed, so the stripper drops one if
 * a projection ever passes it through: the file leaves only through the file
 * route (plan rule 7).
 *
 * ReceiptLineView — a line item stamped with its receipt's `uploadedByUserId`.
 * A line row has no owner column of its own, and the stripper scopes each nested
 * row by itself, so without the stamp a submitter's `their_own` view would strip
 * every line of their own receipt. A line without the stamp fails closed.
 *
 * ReceiptImportResult — one row of a bulk-import response. ReceiptPushResult —
 * a manual S1 re-send's outcome. Both are financial plumbing, `internal`.
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
    duplicateSuspectReceiptId: "internal",
    duplicateSuspectIsRejected: "internal",
    validationNotes: "personal",
    approvedAt: "internal",
    reviewedAt: "internal",
    qbTxnId: "internal",
    qbEntity: "internal",
    importSourceId: "internal",
    financialReviewReasons: "internal",
    complete: "internal",
    reimbursement: "internal",
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
} as const;

export const relations = {
  ReceiptView: {
    lineItems: { model: "ReceiptLineView", isList: true },
  },
} as const;
