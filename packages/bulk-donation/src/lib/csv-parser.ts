import { parse } from "csv-parse/sync";
import { z } from "zod";
import { dollarsToCents } from "@inventory/money";

/**
 * Benevity CSV row after parsing. Monetary fields are INTEGER CENTS.
 * Validation is enforced via Zod (`benevityRowSchema`): a malformed numeric
 * value is a hard error, never a silent 0.
 */
export interface BenevityRow {
  nonprofitName: string;
  nonprofitId: string;
  disbursementId: string;
  disbursementDate: string;
  bankDate: string;
  bankReferenceId: string;
  paymentMethod: string;
  disbursementFrom: string;
  companyName: string;
  corporatePeerCampaign: string;
  projectName: string;
  projectId: string;
  transactionId: string;
  donationDate: string;
  donationAmountCents: number;
  matchAmountCents: number;
  currency: string;
  foreignExchangeRate: number | null;
  causeSupportFeeCents: number;
  merchantFeeCents: number;
  checkFeeCents: number;
  donationFrequency: string;
  donationMethod: string;
  donationType: string;
  donorFirstName: string;
  donorLastName: string;
  donorComment: string;
}

export class CsvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`CSV validation failed: ${issues.join("; ")}`);
    this.name = "CsvValidationError";
  }
}

/** Empty -> 0 cents; otherwise must be a finite number, else throw via refine. */
const moneyCents = z
  .string()
  .transform((s) => s.trim())
  .superRefine((s, ctx) => {
    if (s !== "" && !Number.isFinite(Number(s))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a number: "${s}"` });
    }
  })
  .transform((s) => (s === "" ? 0 : dollarsToCents(s)));

/** Empty -> null; otherwise must be a finite number. */
const rateNullable = z
  .string()
  .transform((s) => s.trim())
  .superRefine((s, ctx) => {
    if (s !== "" && !Number.isFinite(Number(s))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a number: "${s}"` });
    }
  })
  .transform((s) => (s === "" ? null : Number(s)));

const str = z.string().default("");

/**
 * Empty -> ""; otherwise an ISO date (YYYY-MM-DD, optionally with a time part, which is
 * dropped). Stored dates are YYYY-MM-DD so they order correctly as strings.
 */
const isoDate = z
  .string()
  .transform((s) => s.trim())
  .superRefine((s, ctx) => {
    if (s === "") return;
    const day = s.slice(0, 10);
    const parsed = new Date(`${day}T00:00:00Z`);
    const valid =
      /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(s) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
    if (!valid) ctx.addIssue({ code: "custom", message: `not an ISO date (YYYY-MM-DD): "${s}"` });
  })
  .transform((s) => s.slice(0, 10));

const benevityRowSchema = z.object({
  nonprofitName: str,
  nonprofitId: str,
  disbursementId: str,
  disbursementDate: isoDate,
  bankDate: isoDate,
  bankReferenceId: str,
  paymentMethod: str,
  disbursementFrom: str,
  companyName: str,
  corporatePeerCampaign: str,
  projectName: str,
  projectId: str,
  transactionId: z.string().min(1, "missing Transaction ID"),
  donationDate: isoDate,
  donationAmountCents: moneyCents,
  matchAmountCents: moneyCents,
  currency: z.string().transform((s) => (s.trim() === "" ? "USD" : s.trim())),
  foreignExchangeRate: rateNullable,
  causeSupportFeeCents: moneyCents,
  merchantFeeCents: moneyCents,
  checkFeeCents: moneyCents,
  donationFrequency: str,
  donationMethod: str,
  donationType: str,
  donorFirstName: str,
  donorLastName: str,
  donorComment: str,
});

function mapRaw(r: Record<string, string>): Record<string, string> {
  return {
    nonprofitName: r["Nonprofit Name"] ?? "",
    nonprofitId: r["Nonprofit ID"] ?? "",
    disbursementId: r["Disbursement ID"] ?? "",
    disbursementDate: r["Disbursement Date"] ?? "",
    bankDate: r["Bank Date"] ?? "",
    bankReferenceId: r["Bank Reference ID"] ?? "",
    paymentMethod: r["Payment Method"] ?? "",
    disbursementFrom: r["Disbursement From (Grantor)"] ?? "",
    companyName: r["Company Name"] ?? "",
    corporatePeerCampaign: r["Corporate / Peer Campaign"] ?? "",
    projectName: r["Project Name"] ?? "",
    projectId: r["Project ID"] ?? "",
    transactionId: r["Transaction ID"] ?? "",
    donationDate: r["Donation Date"] ?? "",
    donationAmountCents: r["Donation Amount"] ?? "",
    matchAmountCents: r["Match Amount"] ?? "",
    currency: r["Donation Currency"] ?? "",
    foreignExchangeRate: r["Foreign Exchange Rate"] ?? "",
    causeSupportFeeCents: r["Cause Support Fee"] ?? "",
    merchantFeeCents: r["Merchant Fee"] ?? "",
    checkFeeCents: r["Check Fee"] ?? "",
    donationFrequency: r["Donation Frequency"] ?? "",
    donationMethod: r["Donation Method"] ?? "",
    donationType: r["Donation Type"] ?? "",
    donorFirstName: r["Donor First Name"] ?? "",
    donorLastName: r["Donor Last Name"] ?? "",
    donorComment: r["Donor Comment"] ?? "",
  };
}

export function parseBenevityCsv(buffer: Buffer): BenevityRow[] {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  const rows: BenevityRow[] = [];
  const issues: string[] = [];

  records.forEach((raw, idx) => {
    const mapped = mapRaw(raw);
    // Skip blank trailing rows that carry no Transaction ID at all.
    if (mapped.transactionId.trim() === "") return;

    const parsed = benevityRowSchema.safeParse(mapped);
    if (!parsed.success) {
      const line = idx + 2; // +1 for header, +1 for 1-based
      for (const issue of parsed.error.issues) {
        issues.push(`row ${line} (${mapped.transactionId || "no id"}): ${issue.path.join(".")} ${issue.message}`);
      }
      return;
    }
    rows.push(parsed.data);
  });

  if (issues.length > 0) throw new CsvValidationError(issues);
  return rows;
}
