/**
 * Non-Prisma response models the workflow-mapping library ships through
 * handler() (#1289 §5; the catalogSyntheticClassifications.ts pattern).
 *
 * The receipt list, detail and counts return parsed projections of the stored
 * `receiptJson` (`personal`, never granted), and handler()'s stripper drops any
 * bag key that isn't a known model. These shapes carry no submitter or
 * reimbursement field, so the stripper never passes one through even if a
 * projection grows one.
 *
 * Money and vendor are `internal` (what was spent, with whom); line text,
 * quantities and workflow status are `public`. Ids that tie back to the
 * receipt library are `internal`, as on the generated models.
 *
 * Hand-authored, not generated: it describes an API response, not a table. This
 * is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  // One queue row (receiptService.list).
  WorkflowReceiptSummary: {
    id: "public",
    orgId: "internal",
    receiptId: "internal",
    state: "public",
    vendorName: "internal",
    receiptTotalCents: "internal",
    currency: "public",
    lineItemCount: "public",
    validationNotes: "internal",
    createdAt: "public",
    updatedAt: "public",
  },
  // The parsed receipt on the detail screen (receiptService.detail).
  WorkflowReceiptView: {
    receiptId: "internal",
    orgId: "internal",
    vendorName: "internal",
    currency: "public",
    receiptTotalCents: "internal",
    taxCents: "internal",
    shippingCents: "internal",
    discountCents: "internal",
    receiptDate: "public",
    isInKind: "internal",
  },
  WorkflowReceiptLineView: {
    receiptLineItemId: "internal",
    lineNumber: "public",
    description: "public",
    partNumber: "public",
    manufacturer: "public",
    quantity: "public",
    unitPriceCents: "internal",
    totalPriceCents: "internal",
    isDelayed: "public",
  },
  // Queue badge counts (receiptService.counts).
  WorkflowReceiptCount: {
    pending_review: "public",
    apply_failed: "public",
    applying: "public",
  },
} as const;

export const relations = {
  WorkflowReceiptView: {
    lineItems: { model: "WorkflowReceiptLineView", isList: true },
  },
} as const;
