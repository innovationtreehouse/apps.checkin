// Inputs the services accept. Money in the upload and edit shapes is in dollars, as typed.
import { z } from "zod";

export const MAX_LINE_ITEMS = 200;
export const MAX_IMPORT_BATCH = 50;
/** Base64 length of a 10 MB file, the upload cap. */
const MAX_FILE_BASE64 = Math.ceil((10 * 1024 * 1024) / 3) * 4;

const finite = z.number().finite();
const nonNegative = finite.nonnegative();
const dollarString = z.string().refine((v) => Number.isFinite(parseFloat(v)), { message: "must be a finite number" });

export const LineItemSchema = z.object({
  description: z.string().min(1).max(500),
  partNumber: z.string().max(100).nullable().optional(),
  manufacturer: z.string().max(100).nullable().optional(),
  quantity: z.coerce.number().finite().positive(),
  unitPrice: z.coerce.number().finite().nonnegative(),
  isDelayed: z.boolean().optional(),
});

/** Details typed by the uploader. Present ⇒ manual upload; absent ⇒ OCR reads the file. */
export const ManualDetailsSchema = z.object({
  retailer: z.string().min(1).max(500),
  receiptDate: z.string().min(1).max(50),
  receiptTotal: dollarString,
  currency: z.string().min(1).max(10).optional(),
  shipping: dollarString.optional(),
  tax: dollarString.optional(),
  discount: dollarString.optional(),
  lineItems: z
    .array(LineItemSchema)
    .min(1, { message: "At least one line item is required" })
    .max(MAX_LINE_ITEMS, { message: `At most ${MAX_LINE_ITEMS} line items` }),
});

/** "I am the donor", or the donor's name. */
export const DonorInputSchema = z.union([
  z.object({ self: z.literal(true) }).strict(),
  z
    .object({
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().min(1).max(100),
      companyName: z.string().trim().max(200).nullable().optional(),
    })
    .strict(),
]);
export type DonorInput = z.infer<typeof DonorInputSchema>;

function inKindRules(v: { isInKind: boolean; donor?: DonorInput; needsReimbursement?: boolean }, ctx: z.RefinementCtx) {
  if (v.isInKind && !v.donor) ctx.addIssue({ code: "custom", path: ["donor"], message: "An in-kind receipt needs a donor" });
  if (v.isInKind && v.needsReimbursement) {
    ctx.addIssue({ code: "custom", path: ["needsReimbursement"], message: "An in-kind receipt cannot be reimbursed" });
  }
}

export const UploadInputSchema = z
  .object({
    details: ManualDetailsSchema.optional(),
    needsReimbursement: z.boolean().default(false),
    isInKind: z.boolean().default(false),
    donor: DonorInputSchema.optional(),
  })
  .strict()
  .superRefine(inKindRules);
export type UploadInput = z.input<typeof UploadInputSchema>;

export const InKindInputSchema = z
  .object({ isInKind: z.boolean(), donor: DonorInputSchema.optional() })
  .strict()
  .superRefine(inKindRules);

export const AddLineItemSchema = z.object({
  description: z.string().min(1).max(500),
  partNumber: z.string().max(100).nullable().optional(),
  manufacturer: z.string().max(100).nullable().optional(),
  quantity: finite.positive().optional(),
  unitPrice: nonNegative.optional(),
  isDelayed: z.boolean().optional(),
});

export const EditReceiptSchema = z
  .object({
    retailer: z.string().min(1).max(500).optional(),
    receiptDate: z.string().min(1).max(50).optional(),
    currency: z.string().min(1).max(10).optional(),
    shipping: nonNegative.optional(),
    tax: nonNegative.optional(),
    discount: nonNegative.optional(),
    receiptTotal: nonNegative.optional(),
  })
  .strict();

export const EditLineItemSchema = z
  .object({
    description: z.string().min(1).max(500).optional(),
    partNumber: z.string().max(100).nullable().optional(),
    manufacturer: z.string().max(100).nullable().optional(),
    quantity: finite.positive().optional(),
    unitPrice: nonNegative.optional(),
    isDelayed: z.boolean().optional(),
  })
  .strict();

export const OrgSettingsSchema = z
  .object({
    taxExempt: z.boolean().optional(),
    requireFinanceReviewWithTax: z.boolean().optional(),
    enforceReceiptAgeLimit: z.boolean().optional(),
    receiptAgeLimitDays: z.number().int().positive().optional(),
  })
  .strict();

export const ImportLineItemSchema = z.object({
  lineNumber: z.number().int().positive(),
  description: z.string().min(1).max(500),
  partNumber: z.string().max(100).nullable().optional(),
  manufacturer: z.string().max(100).nullable().optional(),
  // May be fractional for consumables bought by weight or volume.
  quantity: z.number().positive(),
  unitPriceCents: z.number().int(),
  totalPriceCents: z.number().int(),
  isDelayed: z.boolean(),
});

/** One historical receipt already matched to its QuickBooks transaction. Integer cents. */
export const ImportReceiptSchema = z
  .object({
    importSourceId: z.string().min(1).max(200),
    qbTxnId: z.string().min(1).max(100),
    qbEntity: z.string().max(50).nullable().optional(),
    retailer: z.string().min(1).max(500),
    receiptNumber: z.string().max(200).nullable().optional(),
    orderNumber: z.string().max(200).nullable().optional(),
    receiptDate: z.string().max(50).nullable().optional(),
    currency: z.string().max(10).default("USD"),
    shippingCents: z.number().int(),
    taxCents: z.number().int(),
    discountCents: z.number().int(),
    receiptTotalCents: z.number().int(),
    needsReimbursement: z.boolean(),
    reimbursementFor: z.string().max(200).nullable().optional(),
    mimeType: z.string().max(100),
    fileBase64: z.string().min(1).max(MAX_FILE_BASE64),
    lineItems: z.array(ImportLineItemSchema).min(1).max(MAX_LINE_ITEMS),
  })
  .strict();

export const ImportBatchSchema = z.array(ImportReceiptSchema).min(1).max(MAX_IMPORT_BATCH);
