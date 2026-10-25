// Inputs the services accept. Money in the upload and edit shapes is in dollars, as typed.
import { z } from "zod";
import { MAX_LINE_QUANTITY } from "@checkin/receipt-types";
import { isIsoDate } from "./missingDetails";

export const MAX_LINE_ITEMS = 200;
export const MAX_IMPORT_BATCH = 50;
/** Base64 length of a 10 MB file, the upload cap. */
const MAX_FILE_BASE64 = Math.ceil((10 * 1024 * 1024) / 3) * 4;

const finite = z.number().finite();
const nonNegative = finite.nonnegative();
const quantity = finite.positive().max(MAX_LINE_QUANTITY);
const cents = z.number().int().nonnegative();
/** An ISO 4217 code; money formatting throws on anything else. */
export const CURRENCY_CODE = /^[A-Z]{3}$/;
const dollarString = z.string().refine((v) => Number.isFinite(parseFloat(v)), { message: "must be a finite number" });
/** Text a receipt cannot be checked without; blank or spaces-only is refused. */
const requiredText = (name: string, max: number) => z.string({ error: `${name} is required` }).trim().min(1, { message: `${name} is required` }).max(max);
/** A calendar date as the date picker sends it. */
const isoDate = requiredText("The date", 50).refine(isIsoDate, { message: "The date must be a real date written YYYY-MM-DD" });

export const LineItemSchema = z.object({
  description: z.string().min(1).max(500),
  partNumber: z.string().max(100).nullable().optional(),
  manufacturer: z.string().max(100).nullable().optional(),
  quantity: z.coerce.number().finite().positive().max(MAX_LINE_QUANTITY),
  unitPrice: z.coerce.number().finite().nonnegative(),
  isDelayed: z.boolean().optional(),
});

/** Details typed by the uploader. Present ⇒ manual upload; absent ⇒ OCR reads the file. */
export const ManualDetailsSchema = z.object({
  retailer: requiredText("The retailer", 500),
  receiptDate: isoDate,
  receiptTotal: dollarString,
  currency: z.string().regex(CURRENCY_CODE, { message: "Currency must be a 3-letter code, like USD" }).optional(),
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
    // The person reimbursed; unset means the uploader.
    reimburseePersonId: z.number().int().positive().optional(),
    isInKind: z.boolean().default(false),
    donor: DonorInputSchema.optional(),
  })
  .strict()
  .superRefine(inKindRules)
  .superRefine((input, ctx) => {
    if (input.reimburseePersonId !== undefined && !input.needsReimbursement) {
      ctx.addIssue({ code: "custom", path: ["reimburseePersonId"], message: "A reimbursee needs needsReimbursement" });
    }
  });
export type UploadInput = z.input<typeof UploadInputSchema>;

export const InKindInputSchema = z
  .object({ isInKind: z.boolean(), donor: DonorInputSchema.optional() })
  .strict()
  .superRefine(inKindRules);

export const AddLineItemSchema = z.object({
  description: z.string().min(1).max(500),
  partNumber: z.string().max(100).nullable().optional(),
  manufacturer: z.string().max(100).nullable().optional(),
  quantity: quantity.optional(),
  unitPrice: nonNegative.optional(),
  isDelayed: z.boolean().optional(),
});

export const EditReceiptSchema = z
  .object({
    retailer: requiredText("The retailer", 500).optional(),
    receiptDate: isoDate.optional(),
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
    quantity: quantity.optional(),
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
  quantity,
  unitPriceCents: cents,
  totalPriceCents: cents,
  isDelayed: z.boolean(),
});

/**
 * One historical receipt already matched to its QuickBooks transaction. Integer cents. Carries no
 * reimbursement claim: strict mode rejects needsReimbursement, which only the submit flow sets.
 */
export const ImportReceiptSchema = z
  .object({
    importSourceId: z.string().min(1).max(200),
    qbTxnId: z.string().min(1).max(100),
    qbEntity: z.string().max(50).nullable().optional(),
    retailer: requiredText("The retailer", 500),
    receiptNumber: z.string().max(200).nullable().optional(),
    orderNumber: z.string().max(200).nullable().optional(),
    receiptDate: isoDate,
    currency: z.string().max(10).default("USD"),
    shippingCents: cents,
    taxCents: cents,
    discountCents: cents,
    receiptTotalCents: z.number({ error: "The total is required" }).int().nonnegative(),
    mimeType: z.string().max(100),
    fileBase64: z.string().min(1).max(MAX_FILE_BASE64),
    lineItems: z.array(ImportLineItemSchema).min(1).max(MAX_LINE_ITEMS),
  })
  .strict();

export const ImportBatchSchema = z.array(ImportReceiptSchema).min(1).max(MAX_IMPORT_BATCH);
