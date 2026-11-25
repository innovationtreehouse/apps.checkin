/**
 * How the Board's finance view log (B11) reads a log row: each record as `Model:id` with the
 * marked field names it was sent, the page it was seen on, and where each record links.
 * Shared by GET /api/system-status/finance-views and the System status tab.
 */

/** Rows on one page of the tab; the route returns one more to signal an older page. */
export const FINANCE_VIEWS_PAGE_SIZE = 50;

/** Every model a log row can name, for the record type filter. */
export const FINANCE_VIEW_MODELS = [
  "Benevity.Disbursement",
  "Expense",
  "InKindDonation",
  "ManualInKindDonation",
  "OrgMembership",
  "OrgMembershipProcess",
  "PaymentException",
  "ProgramParticipant",
  "QuickBooks.Transaction",
  "Receipt",
  "ReceiptMailItem",
  "ReceivedReceipt",
  "ShopOrder",
  "ShopPayout",
  "Transaction",
  "TransactionCommentRule",
  "UploadedFile",
] as const;

export type FinanceViewModelName = (typeof FINANCE_VIEW_MODELS)[number];

export function isFinanceViewModel(value: string): value is FinanceViewModelName {
  return (FINANCE_VIEW_MODELS as readonly string[]).includes(value);
}

/** The page that shows one record of each model that has one. */
const RECORD_PAGES: Partial<Record<FinanceViewModelName, string>> = {
  Expense: "/expense/expenses",
  Receipt: "/receipts",
  InKindDonation: "/donations/in-kind/receipt",
  ManualInKindDonation: "/donations/in-kind/manual",
};

/** A record ref's model and id; null for a ref that names no known model (`unnamed:…`, a bare id). */
export function parseRecordRef(ref: string): { model: FinanceViewModelName; id: string } | null {
  const colon = ref.indexOf(":");
  if (colon <= 0) return null;
  const model = ref.slice(0, colon);
  const id = ref.slice(colon + 1);
  return isFinanceViewModel(model) && id.length > 0 ? { model, id } : null;
}

/**
 * The `recordIds` values a record search matches: what was typed, the bare id, and that id under
 * every model. `e_123` and `Expense:e_123` each find an older row's bare `e_123` and a newer row's
 * `Expense:e_123`.
 */
export function recordSearchRefs(text: string): string[] {
  const id = parseRecordRef(text)?.id ?? text;
  return [...new Set([text, id, ...FINANCE_VIEW_MODELS.map((m) => `${m}:${id}`)])];
}

/** The page a record ref opens, or null where the app has no page for that record. */
export function financeViewRecordHref(ref: string): string | null {
  const parsed = parseRecordRef(ref);
  const page = parsed && RECORD_PAGES[parsed.model];
  return page ? `${page}/${encodeURIComponent(parsed.id)}` : null;
}

/** One log row as the tab reads it. */
export interface FinanceViewRow {
  id: number;
  viewedAt: string;
  actorId: number;
  role: string | null;
  /** The registry key on rows written before page views; null on rows that carry `calls`. */
  endpoint: string | null;
  recordIds: string[];
  /** The claimed page path; null on an untagged row. */
  pagePath: string | null;
  /** Each merged call as `{ endpoint, path, query, role }`. */
  calls: unknown;
  /** Each record as `{ ref, fields }`; null on rows written before page views. */
  records: unknown;
}

export interface FinanceViewRecordEntry {
  ref: string;
  fields: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The row's records with their marked field names; an older row's bare ids carry none. */
export function financeViewRecords(row: FinanceViewRow): FinanceViewRecordEntry[] {
  if (!Array.isArray(row.records)) return row.recordIds.map((ref) => ({ ref, fields: [] }));
  return row.records.filter(isObject).flatMap((r) =>
    typeof r.ref === "string"
      ? [{ ref: r.ref, fields: Array.isArray(r.fields) ? r.fields.filter((f): f is string => typeof f === "string") : [] }]
      : [],
  );
}

/** A call's concrete path with its declared query: `GET /api/expense/finance-queue?tab=holds`. */
function callText(call: unknown): string | null {
  if (!isObject(call) || typeof call.path !== "string") return null;
  const method = typeof call.endpoint === "string" ? call.endpoint.split(" ")[0] : "GET";
  const query = isObject(call.query)
    ? new URLSearchParams(Object.entries(call.query).filter((e): e is [string, string] => typeof e[1] === "string")).toString()
    : "";
  return `${method} ${call.path}${query ? `?${query}` : ""}`;
}

/** Where the records were seen: "on /expense/expenses/e_1", or "via GET /api/…" for a row with no page. */
export function financeViewPlace(row: FinanceViewRow): string {
  if (row.pagePath) return `on ${row.pagePath}`;
  const first: unknown = Array.isArray(row.calls) ? row.calls[0] : null;
  const via = callText(first) ?? row.endpoint;
  return via ? `via ${via}` : "";
}

const ROLE_LABELS: Record<string, string> = {
  isFinance: "Finance",
  isBoardMember: "Board",
  isSysadmin: "Sysadmin",
  isOperations: "Operations",
  isKeyholder: "Keyholder",
  isInventoryManager: "Inventory",
  isBackgroundCheckReviewer: "Background checks",
};

/** "Pat Lee (Finance)"; a viewer with no name is "Person #12". */
export function financeViewViewer(row: FinanceViewRow, name: string | undefined): string {
  const who = name ?? `Person #${row.actorId}`;
  return row.role ? `${who} (${ROLE_LABELS[row.role] ?? row.role})` : who;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

/** "6 Nov 2026 14:05". */
export function financeViewTime(row: FinanceViewRow): string {
  const at = new Date(row.viewedAt);
  return `${DATE.format(at)} ${TIME.format(at)}`;
}

/** A row's place in the log, newest first: its `viewedAt` (epoch ms) and id. */
export interface FinanceViewCursor {
  viewedAt: Date;
  id: number;
}

/** The `before` marker for the rows older than this one: `<viewedAt epoch ms>_<id>`. */
export function financeViewCursor(row: Pick<FinanceViewRow, "viewedAt" | "id">): string {
  return `${new Date(row.viewedAt).getTime()}_${row.id}`;
}

/** The largest id a log row can hold (a Postgres `integer`). */
const MAX_ROW_ID = 2_147_483_647;

/** A `before` marker read back; null when it is not one. */
export function parseFinanceViewCursor(value: string): FinanceViewCursor | null {
  const match = /^(\d{1,15})_(\d{1,10})$/.exec(value);
  if (!match) return null;
  const id = Number(match[2]);
  const viewedAt = new Date(Number(match[1]));
  return id > 0 && id <= MAX_ROW_ID && !Number.isNaN(viewedAt.getTime()) ? { viewedAt, id } : null;
}
