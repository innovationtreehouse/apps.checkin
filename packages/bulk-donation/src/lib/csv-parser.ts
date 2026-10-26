import { CsvError, parse } from "csv-parse/sync";
import { z } from "zod";
import { dollarsToCents, formatCents, sumCents } from "@checkin/money";

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

/** Every issue, one per line, so the upload's error chip shows them all. */
export class CsvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    const count = issues.length === 1 ? "1 problem" : `${issues.length} problems`;
    super(`Could not import the CSV (${count}):\n${issues.join("\n")}`);
    this.name = "CsvValidationError";
  }
}

/** "1,500.00" as Benevity's Donations Report writes it; only well-formed thousands groups. */
const THOUSANDS = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/** Empty -> 0 cents; otherwise must be a finite number, else throw via refine. */
const moneyCents = z
  .string()
  .transform((s) => s.trim())
  .transform((s) => (THOUSANDS.test(s) ? s.replace(/,/g, "") : s))
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

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "Thu 16 Apr 2026 0:00:00", the Donations Report's Period Ending, as YYYY-MM-DD; anything else unchanged. */
function dayMonthYearToIso(s: string): string {
  const m = /^(?:[A-Za-z]{3},? )?(\d{1,2}) ([A-Za-z]{3}) (\d{4})(?: .*)?$/.exec(s);
  const month = m && MONTHS[m[2].toLowerCase()];
  return m && month ? `${m[3]}-${month}-${m[1].padStart(2, "0")}` : s;
}

/**
 * Empty -> ""; otherwise an ISO date (YYYY-MM-DD, optionally with a time part, which is
 * dropped) or a "16 Apr 2026" day. Stored dates are YYYY-MM-DD so they order correctly as strings.
 */
const isoDate = z
  .string()
  .transform((s) => dayMonthYearToIso(s.trim()))
  .superRefine((s, ctx) => {
    if (s === "") return;
    const day = s.slice(0, 10);
    const parsed = new Date(`${day}T00:00:00Z`);
    const valid =
      /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(s) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
    if (!valid) ctx.addIssue({ code: "custom", message: `not a date (YYYY-MM-DD or 16 Apr 2026): "${s}"` });
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

type RawRow = Record<keyof BenevityRow, string>;

/**
 * Where each field is read from. `columns` lists the header names, the flat
 * disbursement export's first and the Donations Report's second; `preamble` is
 * the Donations Report's file-level key above the header, used when no column has it.
 */
const SOURCES: Record<keyof BenevityRow, { columns: string[]; preamble?: string }> = {
  nonprofitName: { columns: ["Nonprofit Name"], preamble: "Charity Name" },
  nonprofitId: { columns: ["Nonprofit ID"], preamble: "Charity ID" },
  disbursementId: { columns: ["Disbursement ID"], preamble: "Disbursement ID" },
  disbursementDate: { columns: ["Disbursement Date"], preamble: "Period Ending" },
  bankDate: { columns: ["Bank Date"] },
  bankReferenceId: { columns: ["Bank Reference ID"] },
  paymentMethod: { columns: ["Payment Method"], preamble: "Payment Method" },
  disbursementFrom: { columns: ["Disbursement From (Grantor)"] },
  companyName: { columns: ["Company Name", "Company"] },
  corporatePeerCampaign: { columns: ["Corporate / Peer Campaign"] },
  projectName: { columns: ["Project Name", "Project"] },
  projectId: { columns: ["Project ID"] },
  transactionId: { columns: ["Transaction ID"] },
  donationDate: { columns: ["Donation Date"] },
  donationAmountCents: { columns: ["Donation Amount", "Total Donation to be Acknowledged"] },
  matchAmountCents: { columns: ["Match Amount"] },
  currency: { columns: ["Donation Currency", "Currency"], preamble: "Currency" },
  foreignExchangeRate: { columns: ["Foreign Exchange Rate"] },
  causeSupportFeeCents: { columns: ["Cause Support Fee"] },
  merchantFeeCents: { columns: ["Merchant Fee"] },
  checkFeeCents: { columns: ["Check Fee"] },
  donationFrequency: { columns: ["Donation Frequency"] },
  donationMethod: { columns: ["Donation Method"] },
  donationType: { columns: ["Donation Type"] },
  donorFirstName: { columns: ["Donor First Name"] },
  donorLastName: { columns: ["Donor Last Name"] },
  donorComment: { columns: ["Donor Comment", "Comment"] },
};

const FIELDS = Object.keys(SOURCES) as (keyof BenevityRow)[];

interface Located {
  record: string[];
  info: { lines: number };
}

function readRecords(buffer: Buffer): Located[] {
  try {
    return parse(buffer, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      info: true,
    }) as Located[];
  } catch (err) {
    if (err instanceof CsvError) throw new CsvValidationError([err.message]);
    throw err;
  }
}

/** The Donations Report's footer labels, which sit under the gift table with fewer cells than the header. */
const FOOTER_LABELS = new Set(["totals", "total donations (gross)", "check fee", "net total payment"]);

/** The gift amounts a Totals footer row can total, each in its header column's cell. */
const TOTALLED = [
  "donationAmountCents", "matchAmountCents", "causeSupportFeeCents", "merchantFeeCents", "checkFeeCents",
] as const satisfies readonly (keyof BenevityRow)[];

/** Where a field comes from in this file: a header column's index, else a preamble value. */
type Binding = { label: string; index: number } | { label: string; value: string } | null;

function bind(field: keyof BenevityRow, header: string[], preamble: Map<string, string>): Binding {
  const { columns, preamble: key } = SOURCES[field];
  for (const label of columns) {
    const index = header.indexOf(label);
    if (index >= 0) return { label, index };
  }
  if (key !== undefined && preamble.has(key)) return { label: key, value: preamble.get(key) ?? "" };
  return null;
}

/**
 * Parses either Benevity layout: the flat disbursement export (header on the first
 * line, disbursement fields on every row) or the Donations Report (a key/value
 * preamble carrying the disbursement fields, the gift table, then a totals footer).
 */
export function parseBenevityCsv(buffer: Buffer): BenevityRow[] {
  const records = readRecords(buffer);
  const headerAt = records.findIndex(({ record }) => record.includes("Transaction ID"));
  if (headerAt < 0) {
    throw new CsvValidationError(['no header row with a "Transaction ID" column; upload a Benevity donations export']);
  }
  const header = records[headerAt].record;
  const preamble = new Map<string, string>();
  for (const { record } of records.slice(0, headerAt)) {
    const [key = "", value = ""] = record;
    if (key !== "" && !key.startsWith("#") && value !== "") preamble.set(key, value);
  }
  const bindings = new Map(FIELDS.map((f) => [f, bind(f, header, preamble)] as const));
  const labelOf = (field: PropertyKey) => bindings.get(field as keyof BenevityRow)?.label ?? String(field);

  const rows: BenevityRow[] = [];
  const issues: string[] = [];
  const totals: Located[] = [];

  for (const { record, info } of records.slice(headerAt + 1)) {
    const mapped = {} as RawRow;
    for (const field of FIELDS) {
      const b = bindings.get(field) ?? null;
      mapped[field] = b === null ? "" : "value" in b ? b.value : (record[b.index] ?? "");
    }
    const label = record[0].trim().toLowerCase();
    const footer = FOOTER_LABELS.has(label) ? label : null;
    if (footer !== null && mapped.transactionId.trim() === "") {
      if (footer === "totals") totals.push({ record, info });
      // The disbursement-level check fee has no gift to land on.
      if (footer === "check fee") {
        const fee = moneyCents.safeParse(record[1] ?? "");
        if (!fee.success || fee.data !== 0) {
          issues.push(`line ${info.lines}, "${record[0].trim()}": "${record[1] ?? ""}" is a disbursement-level fee this import cannot assign to a gift`);
        }
      }
      continue;
    }
    // A miscounted row's cells are shifted, so its Transaction ID cannot be trusted to name it.
    if (record.length !== header.length) {
      issues.push(`line ${info.lines}: ${record.length} cells, but the header has ${header.length}`);
      continue;
    }
    if (mapped.transactionId.trim() === "") continue;

    const parsed = benevityRowSchema.safeParse(mapped);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push(`line ${info.lines} (${mapped.transactionId}), "${labelOf(issue.path[0])}": ${issue.message}`);
      }
      continue;
    }
    rows.push(parsed.data);
  }

  if (issues.length === 0) {
    for (const footer of totals) issues.push(...checkTotals(footer, rows, bindings));
  }
  if (issues.length > 0) throw new CsvValidationError(issues);
  return rows;
}

/** Compares each amount a Totals row gives with the sum of the parsed gifts; a column the row leaves empty is not checked. */
function checkTotals({ record, info }: Located, rows: BenevityRow[], bindings: Map<keyof BenevityRow, Binding>): string[] {
  const currency = rows[0]?.currency ?? "USD";
  const issues: string[] = [];
  for (const field of TOTALLED) {
    const b = bindings.get(field) ?? null;
    if (b === null || !("index" in b)) continue;
    const cell = (record[b.index] ?? "").trim();
    if (cell === "") continue;
    const where = `line ${info.lines}, Totals, "${b.label}"`;
    const reported = moneyCents.safeParse(cell);
    if (!reported.success) {
      issues.push(`${where}: not a number: "${cell}"`);
      continue;
    }
    const summed = sumCents(...rows.map((r) => r[field]));
    if (reported.data !== summed) {
      issues.push(`${where}: report says ${formatCents(reported.data, currency)}, gifts add up to ${formatCents(summed, currency)}`);
    }
  }
  return issues;
}
