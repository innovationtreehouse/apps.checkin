/**
 * Page smoke: each seeded persona opens every page its nav shows, every tab or view of those
 * pages, and the API routes the pages load. A 5xx anywhere fails; so does a 401 or 403 on a page
 * the nav offered, or on an API that page loads. The page list is the nav's own: the section
 * descriptors (src/lib/nav/sections) and the page directory (src/components/pageRegistry),
 * evaluated against the persona's session and nav counts exactly as the browser does, so a new
 * tab is covered once it is in the nav. Real HTTP against the running dev server.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PAGES } from "@/components/pageRegistry";
import { LIBRARY_KEYS, type LibraryKey } from "@/lib/libraryRelease";
import { hasAnyRole, sectionShown, tabHrefs, visibleLinks } from "@/lib/nav/gates";
import { RECEIVING_ROLES } from "@/lib/nav/sections/inventory";
import type { NavSection, NavUser } from "@/lib/nav/types";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { NOT_PUSHED, OTHER_QUEUES, QUEUES, queueListPath } from "../../packages/receipt/src/components/reviewQueue";
import { api, loginAs, type Session } from "./helpers";

// The first persona pays the dev server's compile of every page and route it opens.
jest.setTimeout(600_000);

const FINANCE = "finance@example.com";
const BOARD = "boardmember@example.com";
const APPROVER = "keyholder1@example.com";
const TREASURER = "keyholder2@example.com";
const INVENTORY_MANAGER = "inventory.manager@example.com";
const MEMBER = "parent.family@example.com";

const PAGE_SIZE = 50;
const CONCURRENCY = 6;

/** A page or API that fails today, skipped by the sweep and asserted on its own as `test.failing` until its fix lands. */
interface KnownFailure { path: string; personas: string[]; fix: string; why: string }
const KNOWN_FAILURES: KnownFailure[] = [
  {
    path: "/api/budget-owners/quickbooks-classes",
    personas: [FINANCE, BOARD],
    fix: "#2550",
    why: "/budgets reads QuickBooks Classes live; with no QuickBooks on CHECKIN_ENV=local the route answers 503",
  },
];

/** Pages a persona's nav must show, so a nav that renders nothing cannot pass the sweep by opening nothing. */
const EXPECTED_PAGES: Record<string, string[]> = {
  [FINANCE]: ["/receipts/review", "/receipts/mail", "/expense/expenses", "/expense/holds", "/expense/flags", "/budgets", "/donations"],
  [BOARD]: ["/receipts/review", "/expense/expenses", "/budgets", "/donations", "/programs-i-lead/attendance"],
  [APPROVER]: ["/programs-i-lead/expense-approvals"],
  [TREASURER]: ["/programs-i-lead/expense-approvals"],
  [INVENTORY_MANAGER]: ["/receipts", "/receipts/upload", "/inventory/org-items", "/inventory/receiving", "/receipt-flow"],
  [MEMBER]: ["/my-household"],
};

/** Pages the nav does not show on main yet; each is asserted present as `test.failing` until the PR that adds it lands. */
const PENDING_PAGES: Record<string, string> = { "/finance/review": "#2543" };

interface Viewer { session: Session; user: NavUser; counts: TodoCounts | null; email: string }

/** The allowed values of a list route's selector, read from the 400 the route answers for an unknown one. */
async function allowedValues(s: Session, path: string, param: string): Promise<string[]> {
  const res = await api(s, `${path}?${param}=-`);
  const match = new RegExp(`${param} must be one of: ([A-Za-z0-9_, -]+)`).exec(JSON.stringify(res.json));
  if (res.status !== 400 || !match) throw new Error(`${path} did not list its ${param} values (status ${res.status})`);
  return match[1].split(",").map((v) => v.trim()).filter(Boolean);
}

async function firstId<T extends { id: string | number }>(s: Session, path: string): Promise<T["id"] | null> {
  const res = await api<T[]>(s, path);
  return res.status === 200 && Array.isArray(res.json) && res.json.length > 0 ? res.json[0].id : null;
}

const receiptQueues = [...QUEUES, ...OTHER_QUEUES].map((q) => q.value);

const expenseList = async (v: Viewer, href: string): Promise<string[]> => {
  const views = await allowedValues(v.session, "/api/expense/expenses", "view");
  const urls = ["/api/expense/counts"];
  for (const view of views) {
    const filter = `view=${view}${view === "all" ? "&active=1" : ""}`;
    urls.push(`${href}?view=${view}&page=1`, `/api/expense/expenses?${filter}&page=1&limit=${PAGE_SIZE}`, `/api/expense/expenses/count?${filter}`);
  }
  const id = await firstId<{ id: string }>(v.session, `/api/expense/expenses?view=all&page=1&limit=1`);
  if (id !== null) {
    const base = `/api/expense/expenses/${encodeURIComponent(id)}`;
    urls.push(`${href}/${encodeURIComponent(id)}`, base, `${base}/line-item-approvals`, `${base}/signoffs`);
    if (v.user.isFinance) urls.push(`${base}/reimbursee-vendor`);
    if (v.user.isFinance || v.user.isBoardMember) urls.push("/api/expense/local-owners");
  }
  return urls;
};

const receiptDetail = async (v: Viewer, list: string, page: (id: string) => string): Promise<string[]> => {
  const id = await firstId<{ id: string }>(v.session, list);
  if (id === null) return [];
  const urls = [page(id), `/api/receipts/${encodeURIComponent(id)}`];
  if (v.user.isFinance || v.user.isBoardMember) urls.push(`/api/receipts/${encodeURIComponent(id)}/audit-logs`);
  return urls;
};

const paged = (path: string) => `${path}${path.includes("?") ? "&" : "?"}page=1&limit=${PAGE_SIZE}`;

/** What each page loads: its tab and view URLs and the API GETs, by nav href. A page not listed loads only the nav's counts. */
const PAGE_LOADS: Record<string, (v: Viewer, href: string) => string[] | Promise<string[]>> = {
  "/receipts": async (v) => [
    "/api/receipts/mine",
    "/api/receipts/mine?hideCompleted=1",
    ...(await receiptDetail(v, "/api/receipts/mine", (id) => `/receipts/${encodeURIComponent(id)}`)),
  ],
  "/receipts/review": async (v, href) => [
    "/api/receipts/queue-counts",
    ...receiptQueues.flatMap((q) => [`${href}?queue=${q || "all"}`, `/api/receipts${queueListPath(q)}`]),
    ...(await receiptDetail(v, "/api/receipts", (id) => `${href}/${encodeURIComponent(id)}?queue=all`)),
  ],
  "/receipts/settings": () => ["/api/receipts/settings"],
  "/receipts/mail": () => ["/api/receipts/mail-items", "/api/receipts/ignored-files"],
  "/receipt-flow": () => ["/api/receipt-flow/status"],
  "/finance/review": async (v, href) => {
    const tabs = await allowedValues(v.session, "/api/expense/finance-queue", "tab");
    return [
      "/api/receipts/queue-counts",
      "/api/expense/finance-queue/counts",
      "/api/workflow-mapping/receipts/counts",
      ...receiptQueues.filter((q) => q !== NOT_PUSHED).flatMap((q) => [`${href}?queue=${q || "all"}`, `/api/receipts${queueListPath(q)}`]),
      `${href}?queue=${NOT_PUSHED}`,
      `/api/receipts${queueListPath(NOT_PUSHED)}`,
      ...tabs.flatMap((t) => [`${href}?queue=${t}`, `/api/expense/finance-queue?tab=${t}`]),
    ];
  },
  "/expense/expenses": expenseList,
  "/programs-i-lead/expense-approvals": expenseList,
  "/expense/holds": () => ["/api/expense/expense-holds"],
  "/expense/flags": () => ["/api/expense/flags"],
  "/expense/account-mapping": () => [paged("/api/expense/account-mapping"), "/api/expense/qb-accounts"],
  "/expense/qb-accounts": () => ["/api/expense/qb-accounts"],
  "/expense/ownership-map": () => [paged("/api/expense/ownership-map")],
  "/expense/settings": () => ["/api/expense/org-settings"],
  "/budgets": async (v) => {
    const urls = ["/api/budget-owners?includeArchived=1", "/api/budget-owners/quickbooks-classes"];
    const id = await firstId<{ id: number }>(v.session, "/api/budget-owners?includeArchived=1");
    if (id !== null) urls.push(`/api/budget-owners/${id}/approvers`);
    if (v.user.isBoardMember) urls.push("/api/budget-owners/approver-options");
    return urls;
  },
  "/inventory/org-items": (v) => [
    "/api/inventory/org-items?sortBy=gtin13&sortDir=asc&page=1&limit=50",
    "/api/inventory/org-items/count",
    "/api/inventory/locations",
    // The Inventory Log tab shows only to the receiving roles.
    ...(hasAnyRole(v.user, RECEIVING_ROLES) ? [paged("/api/inventory/inventory-log"), "/api/inventory/inventory-log/count"] : []),
  ],
  "/inventory/locations": () => ["/api/inventory/locations"],
  "/inventory/receive-queue": () => ["/api/inventory/receive-queue?includeFulfilled=false", "/api/inventory/receive-queue?includeFulfilled=true"],
  "/inventory/received-deltas": () => [paged("/api/inventory/received-inventory-deltas"), "/api/inventory/received-inventory-deltas/count"],
  "/inventory/merge-conflicts": () => ["/api/inventory/inventory-merge-conflicts"],
  "/inventory/provisional-items": () => ["/api/inventory/provisional-items"],
  "/inventory/org-events": () => ["/api/inventory/received-org-events"],
  "/inventory/receiving": async (v, href) => {
    const urls = ["/api/workflow-mapping/receipts/counts", "/api/workflow-mapping/receipts"];
    for (const [queue, state] of [["mapping", "pending_review"], ["failed", "apply_failed"], ["inProgress", "applying"], ["all", ""]]) {
      urls.push(`${href}?queue=${queue}`);
      if (state) urls.push(`/api/workflow-mapping/receipts?state=${state}`);
    }
    const id = await firstId<{ id: number }>(v.session, "/api/workflow-mapping/receipts");
    if (id !== null) urls.push(`${href}/${id}`, `/api/workflow-mapping/receipts/${id}`, "/api/catalog/categories", "/api/catalog/subcategories");
    urls.push(`${href}/audit-log`, "/api/workflow-mapping/audit-log?limit=100");
    return urls;
  },
  "/inventory/in-kind": () => [paged("/api/donations/in-kind/manual")],
  "/donations/unassigned": () => [paged("/api/donations/transactions/unassigned"), "/api/budget-owners"],
  "/donations/uploads": () => [paged("/api/donations/uploaded-files")],
  "/donations/transactions": () => [
    paged("/api/donations/transactions"),
    paged("/api/donations/transactions?assigned=true"),
    paged("/api/donations/transactions?assigned=false"),
    "/api/budget-owners",
  ],
  "/donations/holds": () => [paged("/api/donations/disbursement-holds")],
  "/donations/in-kind": () => ["/api/donations/in-kind/queue", "/api/budget-owners"],
  "/donations/events": () => [paged("/api/donations/disbursement-events")],
  "/donations/qb-queue": () => [paged("/api/donations/disbursement-events?qbState=AMBIGUOUS,UNBOOKED,BEFORE_LINE,POST_FAILED,NEEDS_FINANCE,DRIFT&noted=1")],
  "/donations/comment-rules": () => [paged("/api/donations/comment-rules"), "/api/budget-owners"],
  "/donations/account-map": () => [paged("/api/donations/account-map")],
  "/donations/qb-exclusions": () => [paged("/api/donations/qb-exclusions")],
};

const isSection = (v: unknown): v is NavSection =>
  typeof v === "object" && v !== null
  && "id" in v && typeof v.id === "string"
  && "href" in v && typeof v.href === "string"
  && "links" in v && Array.isArray(v.links)
  && "visible" in v && typeof v.visible === "function";

/** Every section descriptor in src/lib/nav/sections, so a new section is covered without a list to update. */
async function navSections(): Promise<NavSection[]> {
  const dir = join(__dirname, "../src/lib/nav/sections");
  const modules = await Promise.all(readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => import(join(dir, f)) as Promise<Record<string, unknown>>));
  return [...new Set(modules.flatMap((m) => Object.values(m).filter(isSection)))];
}

/** The pages the nav shows this viewer: shown sections' destinations and tabs, and the directory's visible pages. */
function navPages(sections: NavSection[], { user, counts }: Viewer): string[] {
  const hrefs = new Set<string>();
  for (const section of sections) {
    if (!sectionShown(section, user, counts)) continue;
    hrefs.add(section.hrefFor?.(user, counts) ?? section.href);
    for (const link of visibleLinks(section, user, counts)) for (const href of tabHrefs(link)) hrefs.add(href);
  }
  for (const page of PAGES) if (page.visible(user, counts)) hrefs.add(page.href);
  return [...hrefs].filter((h) => h.startsWith("/") && !h.includes("["));
}

async function viewer(email: string): Promise<Viewer> {
  const session = await loginAs(email);
  const me = await api<{ user?: NavUser }>(session, "/api/auth/session");
  if (!me.json.user) throw new Error(`no session user for ${email}`);
  const counts = await api<TodoCounts>(session, "/api/nav/todo-counts");
  expect([email, "/api/nav/todo-counts", counts.status]).toEqual([email, "/api/nav/todo-counts", 200]);
  return { session, user: me.json.user, counts: counts.json, email };
}

const isKnown = (email: string, path: string) =>
  KNOWN_FAILURES.some((k) => k.personas.includes(email) && path.split("?")[0] === k.path);

/** A status the sweep fails on: any 5xx, or a denial of a page the nav offered or an API it loads. */
const broken = (status: number) => status >= 500 || status === 401 || status === 403;

/** Every URL a persona's nav leads to, with the page each came from. */
async function sweepUrls(sections: NavSection[], v: Viewer): Promise<Array<{ page: string; url: string }>> {
  const out: Array<{ page: string; url: string }> = [];
  for (const page of navPages(sections, v)) {
    out.push({ page, url: page });
    const loads = PAGE_LOADS[page];
    if (loads) for (const url of await loads(v, page)) out.push({ page, url });
  }
  return out;
}

async function sweep(sections: NavSection[], v: Viewer): Promise<string[]> {
  const urls = (await sweepUrls(sections, v)).filter(({ url }) => !isKnown(v.email, url));
  const failures: string[] = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    await Promise.all(urls.slice(i, i + CONCURRENCY).map(async ({ page, url }) => {
      const { status, json } = await api(v.session, url);
      if (broken(status)) failures.push(`${status} ${url} (from ${page})${status >= 500 ? `: ${JSON.stringify(json).slice(0, 200)}` : ""}`);
    }));
  }
  return failures;
}

let sections: NavSection[];
const viewers = new Map<string, Viewer>();
let bucketId: number;
let releasedBefore: string[] = [];

const send = (s: Session, method: string, path: string, body?: unknown) =>
  api(s, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const release = (board: Session, library: LibraryKey, released: boolean) =>
  send(board, "PUT", "/api/settings/membership", { releaseLibrary: { library, released } });

beforeAll(async () => {
  sections = await navSections();
  const finance = await loginAs(FINANCE);
  const board = await loginAs(BOARD);
  // A fresh seed releases no library, which hides every library page from everyone but the Board.
  releasedBefore = (await api<TodoCounts>(board, "/api/nav/todo-counts")).json.releasedLibraries ?? [];
  for (const library of LIBRARY_KEYS) expect([library, (await release(board, library, true)).status]).toEqual([library, 200]);
  // A bucket of this suite's own makes the approver its owner and the treasurer its treasurer.
  const bucket = await send(finance, "POST", "/api/budget-owners", { name: `Page smoke ${Date.now()}` });
  expect(bucket.status).toBe(200);
  bucketId = (bucket.json as { id: number }).id;
  const approver = await loginAs(APPROVER);
  const treasurer = await loginAs(TREASURER);
  expect((await send(board, "PUT", `/api/budget-owners/${bucketId}/owner`, { personId: approver.personaId })).status).toBe(200);
  expect((await send(board, "PUT", `/api/budget-owners/${bucketId}/treasurers/${treasurer.personaId}`)).status).toBe(200);
  for (const email of Object.keys(EXPECTED_PAGES)) viewers.set(email, await viewer(email));
});

afterAll(async () => {
  const board = await loginAs(BOARD);
  await send(board, "DELETE", `/api/budget-owners/${bucketId}/treasurers/${(await loginAs(TREASURER)).personaId}`);
  await send(board, "PUT", `/api/budget-owners/${bucketId}/owner`, { personId: null });
  for (const library of LIBRARY_KEYS.filter((l) => !releasedBefore.includes(l))) await release(board, library, false);
});

describe("page smoke — the nav", () => {
  it("finds the section descriptors", () => {
    expect(sections.length).toBeGreaterThan(10);
  });

  it.each(Object.entries(EXPECTED_PAGES))("shows %s the pages their role works", (email, expected) => {
    const pages = navPages(sections, viewers.get(email)!);
    expect(expected.filter((p) => !pages.includes(p))).toEqual([]);
  });

  it("keeps the finance and budget pages from a plain member", () => {
    const pages = navPages(sections, viewers.get(MEMBER)!);
    expect(pages.filter((p) => /^\/(receipts\/review|expense|budgets|donations|finance)/.test(p))).toEqual([]);
  });

  for (const [page, fix] of Object.entries(PENDING_PAGES)) {
    it.failing(`shows FINANCE and BOARD ${page} (lands with ${fix})`, () => {
      for (const email of [FINANCE, BOARD]) expect([email, navPages(sections, viewers.get(email)!).includes(page)]).toEqual([email, true]);
    });
  }
});

describe("page smoke — every nav page and the APIs it loads", () => {
  it.each(Object.keys(EXPECTED_PAGES))("opens everything %s's nav shows without a 5xx or a denial", async (email) => {
    expect(await sweep(sections, viewers.get(email)!)).toEqual([]);
  });

  for (const known of KNOWN_FAILURES) {
    for (const email of known.personas) {
      it.failing(`${email} loads ${known.path} (fixed by ${known.fix}: ${known.why})`, async () => {
        const { status } = await api(viewers.get(email)!.session, known.path);
        expect([known.path, broken(status)]).toEqual([known.path, false]);
      });
    }
  }
});
