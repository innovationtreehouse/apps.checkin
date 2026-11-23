// Inputs the services accept. Money in the upload and edit shapes is in dollars, as typed.
import { z } from "zod";
import { dollarsToCents, dollarsToCentsOrNull } from "@checkin/money";
import { CURRENCY_CODE, DEFAULT_CURRENCY, InKindDonorSchema, MAX_LINE_QUANTITY } from "@checkin/receipt-types";
import { isIsoDate } from "./missingDetails";

export { CURRENCY_CODE };

export const MAX_LINE_ITEMS = 200;
export const MAX_LINE_DESCRIPTION = 500;
/** The longest part number or manufacturer a line holds. */
export const MAX_LINE_LABEL = 100;
export const MAX_IMPORT_BATCH = 50;
/** Base64 length of a 10 MB file, the upload cap. */
const MAX_FILE_BASE64 = Math.ceil((10 * 1024 * 1024) / 3) * 4;

/** The most a money column holds: its integer cents limit. */
export const MAX_CENTS = 2 ** 31 - 1;
const DOLLAR_RANGE = { message: "must be a number from 0 to 21,474,836.47" };
const CENTS_RANGE = { message: "must be a whole number of cents from 0 to 2,147,483,647" };
const quantity = z.number().finite().positive().max(MAX_LINE_QUANTITY);
/** A dollar amount whose cents fit a money column. */
export const DollarsSchema = z.number().finite().min(0, DOLLAR_RANGE).refine((v) => dollarsToCents(v) <= MAX_CENTS, DOLLAR_RANGE);
const cents = z.number().int(CENTS_RANGE).min(0, CENTS_RANGE).max(MAX_CENTS, CENTS_RANGE);
const currencyCode = z.string().regex(CURRENCY_CODE, { message: "Currency must be a 3-letter code, like USD" });
const dollarString = z.string().refine((v) => {
  const cents = dollarsToCentsOrNull(v);
  // Sign checked on the typed value: "-0.001" rounds to 0 cents.
  return cents !== null && Number(v) >= 0 && cents <= MAX_CENTS;
}, DOLLAR_RANGE);
/** A dollar input from these shapes in cents; missing counts as 0, and text that is not a plain decimal throws. */
export const toCents = (dollars: number | string | undefined): number => dollarsToCents(dollars ?? 0);
/** A line with no total stores quantity × unit price, which must fit the money column too. */
export const lineCostFits = (l: { quantity?: number; unitPrice?: number; totalPrice?: number }) =>
  l.totalPrice !== undefined || Math.round((l.quantity ?? 1) * toCents(l.unitPrice)) <= MAX_CENTS;
export const LINE_COST_MESSAGE = "Quantity × unit price must be at most 21,474,836.47";
/** Zod rewrites `message` to `error` on this object when it is used, so read the text from LINE_COST_MESSAGE. */
export const LINE_COST_RANGE = { message: LINE_COST_MESSAGE, path: ["unitPrice"] };

/** Text a receipt cannot be checked without; blank or spaces-only is refused. */
const requiredText = (name: string, max: number) => z.string({ error: `${name} is required` }).trim().min(1, { message: `${name} is required` }).max(max);
/** A calendar date as the date picker sends it. */
const isoDate = requiredText("The date", 50).refine(isIsoDate, { message: "The date must be a real date written YYYY-MM-DD" });

export const LineItemSchema = z.object({
  description: z.string().min(1).max(MAX_LINE_DESCRIPTION),
  partNumber: z.string().max(MAX_LINE_LABEL).nullable().optional(),
  manufacturer: z.string().max(MAX_LINE_LABEL).nullable().optional(),
  quantity,
  unitPrice: DollarsSchema,
  isDelayed: z.boolean().optional(),
}).refine(lineCostFits, LINE_COST_RANGE);

/** Details typed by the uploader. Present ⇒ manual upload; absent ⇒ OCR reads the file. */
export const ManualDetailsSchema = z.object({
  retailer: requiredText("The retailer", 500),
  receiptDate: isoDate,
  receiptTotal: dollarString,
  currency: currencyCode.optional(),
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
  InKindDonorSchema.extend({ companyName: InKindDonorSchema.shape.companyName.optional() }).strict(),
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
    // A non-member adult to add and reimburse, declared an adult by the uploader.
    newReimbursee: z.object({ name: z.string().trim().min(1).max(200), isAdult: z.literal(true) }).strict().optional(),
    isInKind: z.boolean().default(false),
    donor: DonorInputSchema.optional(),
  })
  .strict()
  .superRefine(inKindRules)
  .superRefine((input, ctx) => {
    if (input.reimburseePersonId !== undefined && !input.needsReimbursement) {
      ctx.addIssue({ code: "custom", path: ["reimburseePersonId"], message: "A reimbursee needs needsReimbursement" });
    }
    if (input.newReimbursee !== undefined && !input.needsReimbursement) {
      ctx.addIssue({ code: "custom", path: ["newReimbursee"], message: "A reimbursee needs needsReimbursement" });
    }
    if (input.newReimbursee !== undefined && input.reimburseePersonId !== undefined) {
      ctx.addIssue({ code: "custom", path: ["newReimbursee"], message: "Name one reimbursee: someone on file or a new person, not both" });
    }
  });
export type UploadInput = z.input<typeof UploadInputSchema>;

export const InKindInputSchema = z
  .object({ isInKind: z.boolean(), donor: DonorInputSchema.optional() })
  .strict()
  .superRefine(inKindRules);

export const RotationInputSchema = z.object({ rotation: z.literal([0, 90, 180, 270]) }).strict();

export const AddLineItemSchema = z.object({
  description: z.string().min(1).max(MAX_LINE_DESCRIPTION),
  partNumber: z.string().max(MAX_LINE_LABEL).nullable().optional(),
  manufacturer: z.string().max(MAX_LINE_LABEL).nullable().optional(),
  quantity: quantity.optional(),
  unitPrice: DollarsSchema.optional(),
  totalPrice: DollarsSchema.optional(),
  isDelayed: z.boolean().optional(),
}).refine(lineCostFits, LINE_COST_RANGE);

export const EditReceiptSchema = z
  .object({
    retailer: requiredText("The retailer", 500).optional(),
    receiptDate: isoDate.optional(),
    currency: currencyCode.optional(),
    shipping: DollarsSchema.optional(),
    tax: DollarsSchema.optional(),
    discount: DollarsSchema.optional(),
    receiptTotal: DollarsSchema.optional(),
  })
  .strict();

export const EditLineItemSchema = z
  .object({
    description: z.string().min(1).max(MAX_LINE_DESCRIPTION).optional(),
    partNumber: z.string().max(MAX_LINE_LABEL).nullable().optional(),
    manufacturer: z.string().max(MAX_LINE_LABEL).nullable().optional(),
    quantity: quantity.optional(),
    unitPrice: DollarsSchema.optional(),
    totalPrice: DollarsSchema.optional(),
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

export const OcrSwitchSchema = z.object({ ocrEnabled: z.boolean() }).strict();

export const ImportLineItemSchema = z.object({
  lineNumber: z.number().int().positive(),
  description: z.string().min(1).max(MAX_LINE_DESCRIPTION),
  partNumber: z.string().max(MAX_LINE_LABEL).nullable().optional(),
  manufacturer: z.string().max(MAX_LINE_LABEL).nullable().optional(),
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
    currency: currencyCode.default(DEFAULT_CURRENCY),
    shippingCents: cents,
    taxCents: cents,
    discountCents: cents,
    receiptTotalCents: z.number({ error: "The total is required" }).pipe(cents),
    mimeType: z.string().max(100),
    fileBase64: z.string().min(1).max(MAX_FILE_BASE64),
    lineItems: z.array(ImportLineItemSchema).min(1).max(MAX_LINE_ITEMS),
  })
  .strict();

export const ImportBatchSchema = z.array(ImportReceiptSchema).min(1).max(MAX_IMPORT_BATCH);
