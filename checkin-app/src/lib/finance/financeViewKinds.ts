/**
 * How the Board's finance view log (B11) reads an endpoint: which kind of
 * record it shows, where a record id links, and the row's sentence. Shared by
 * GET /api/system-status/finance-views and the System status tab.
 *
 * Kinds match by path prefix, not by registry key, because rows copied from
 * the donor-read audit can hold a concrete path (`GET /api/receipts/abc`).
 */
import type { Prisma } from "@/generated/prisma/client";

/** Rows on one page of the tab; the route returns one more to signal a next page. */
export const FINANCE_VIEWS_PAGE_SIZE = 50;

interface FinanceViewKind {
  key: string;
  label: string;
  one: string;
  many: string;
  prefixes: readonly string[];
  /** Sub-paths of `prefixes` that belong to another kind. */
  except?: readonly string[];
}

export const FINANCE_VIEW_KINDS = [
  { key: "receipts", label: "Receipts", one: "receipt", many: "receipts", prefixes: ["/api/receipts", "/api/workflow-mapping"] },
  { key: "expenses", label: "Expenses", one: "expense", many: "expenses", prefixes: ["/api/expense"] },
  { key: "payouts", label: "Payouts", one: "payout record", many: "payout records", prefixes: ["/api/income"] },
  { key: "donations", label: "Donations", one: "donation record", many: "donation records", prefixes: ["/api/donations"], except: ["/api/donations/in-kind"] },
  { key: "giftsOfGoods", label: "Gifts of goods", one: "gift of goods", many: "gifts of goods", prefixes: ["/api/donations/in-kind"] },
  { key: "payments", label: "Payments", one: "payment record", many: "payment records", prefixes: ["/api/finance-ops"] },
] as const satisfies readonly FinanceViewKind[];

export type FinanceViewKindKey = (typeof FINANCE_VIEW_KINDS)[number]["key"];

export function isFinanceViewKind(value: string): value is FinanceViewKindKey {
  return FINANCE_VIEW_KINDS.some((k) => k.key === value);
}

/** The path itself or anything below it; `/api/expense` never matches `/api/expenses`. */
function underPath(endpoint: string, path: string): boolean {
  return endpoint === `GET ${path}` || endpoint.startsWith(`GET ${path}/`);
}

function underPathWhere(path: string): Prisma.FinanceViewLogWhereInput {
  return { OR: [{ endpoint: `GET ${path}` }, { endpoint: { startsWith: `GET ${path}/` } }] };
}

function kindOf(key: FinanceViewKindKey): FinanceViewKind {
  const kind = FINANCE_VIEW_KINDS.find((k) => k.key === key);
  if (!kind) throw new Error(`unknown finance view kind ${key}`);
  return kind;
}

/** The kind an endpoint shows, or null for one outside every kind. */
export function financeViewKindOf(endpoint: string): FinanceViewKind | null {
  return (
    FINANCE_VIEW_KINDS.find(
      (k: FinanceViewKind) =>
        k.prefixes.some((p) => underPath(endpoint, p)) && !(k.except ?? []).some((p) => underPath(endpoint, p)),
    ) ?? null
  );
}

/** The log rows whose endpoint shows records of this kind. */
export function financeViewKindWhere(key: FinanceViewKindKey): Prisma.FinanceViewLogWhereInput {
  const kind = kindOf(key);
  return {
    OR: kind.prefixes.map(underPathWhere),
    ...(kind.except && { NOT: kind.except.map(underPathWhere) }),
  };
}

/** One log row as the tab reads it. */
export interface FinanceViewRow {
  id: number;
  viewedAt: string;
  actorId: number;
  role: string | null;
  endpoint: string;
  params: unknown;
  recordIds: string[];
  rowCount: number;
}

// List endpoints whose every returned id is a record with its own page.
const LIST_PAGES: Record<string, string> = {
  "GET /api/receipts": "/receipts",
  "GET /api/receipts/needs-attention": "/receipts",
  "GET /api/expense/expenses": "/expense/expenses",
  "GET /api/expense/queue": "/expense/expenses",
};

// Detail endpoints: only the record named in the path links; the other ids are its lines.
const DETAIL_PAGES = [
  { endpoint: "GET /api/receipts/[id]", concrete: /^GET \/api\/receipts\/([^/]+)$/, page: "/receipts" },
  { endpoint: "GET /api/expense/expenses/[id]", concrete: /^GET \/api\/expense\/expenses\/([^/]+)$/, page: "/expense/expenses" },
  { endpoint: "GET /api/donations/in-kind/receipt/[id]", concrete: /^GET \/api\/donations\/in-kind\/receipt\/([^/]+)$/, page: "/donations/in-kind/receipt" },
  { endpoint: "GET /api/donations/in-kind/manual/[id]", concrete: /^GET \/api\/donations\/in-kind\/manual\/([^/]+)$/, page: "/donations/in-kind/manual" },
];

function pathId(params: unknown): string | null {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const id = (params as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

/** The detail page a row's endpoint opens and the record it names, if it is one. */
function detailRecord(row: FinanceViewRow): { page: string; id: string | null } | null {
  for (const d of DETAIL_PAGES) {
    if (row.endpoint === d.endpoint) {
      // A copied donor-read row carries no params; its one record id is the record.
      const id = pathId(row.params) ?? (row.recordIds.length === 1 ? row.recordIds[0] : null);
      return { page: d.page, id };
    }
    const concrete = d.concrete.exec(row.endpoint);
    if (concrete && row.recordIds.includes(concrete[1])) return { page: d.page, id: concrete[1] };
  }
  return null;
}

/** The page a record id opens, or null where no page shows that record. */
export function financeViewRecordHref(row: FinanceViewRow, recordId: string): string | null {
  const list = LIST_PAGES[row.endpoint];
  if (list) return `${list}/${encodeURIComponent(recordId)}`;
  const detail = detailRecord(row);
  if (detail && detail.id === recordId) return `${detail.page}/${encodeURIComponent(recordId)}`;
  return null;
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

/** Where the records were seen: "on the finance queue", "on the needs attention page". */
function place(row: FinanceViewRow): string {
  if (detailRecord(row)) return "on the record's page";
  const segments = row.endpoint.replace(/^GET /, "").split("/").filter(Boolean).slice(1);
  const last = segments[segments.length - 1] ?? "";
  if (last.startsWith("[")) return "on the record's page";
  const words = last.replace(/-/g, " ");
  if (segments.length === 1) return `on the ${words} list`;
  return /(queue|list)$/.test(words) ? `on the ${words}` : `on the ${words} page`;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

/** "Pat Lee (Finance) viewed 3 receipts on the finance queue, 27 Oct 2026 14:05". */
export function financeViewSentence(row: FinanceViewRow, name: string | undefined): string {
  const who = name ?? `Person #${row.actorId}`;
  const role = row.role ? ` (${ROLE_LABELS[row.role] ?? row.role})` : "";
  const kind = financeViewKindOf(row.endpoint);
  const noun = row.rowCount === 1 ? (kind?.one ?? "finance record") : (kind?.many ?? "finance records");
  const at = new Date(row.viewedAt);
  return `${who}${role} viewed ${row.rowCount} ${noun} ${place(row)}, ${DATE.format(at)} ${TIME.format(at)}`;
}
