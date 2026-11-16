/**
 * @jest-environment node
 */
import { installPageViewTagging, PAGE_VIEW_ID_HEADER, PAGE_VIEW_PATH_HEADER, type TaggingWindow } from "@/lib/pageViewTagging";
import { PAGE_VIEW_ID_HEADER as SERVER_ID_HEADER, PAGE_VIEW_PATH_HEADER as SERVER_PATH_HEADER } from "@/security/financeView";

interface Sent {
  url: string;
  headers: Headers;
}

function fakeWindow(path: string, search = "") {
  const sent: Sent[] = [];
  const location = { origin: "https://app.test", pathname: path, search, href: `https://app.test${path}${search}` };
  const win: TaggingWindow = {
    location,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      sent.push({ url, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
      return new Response("{}");
    },
  };
  const go = (nextPath: string, nextSearch = "") => {
    location.pathname = nextPath;
    location.search = nextSearch;
    location.href = `https://app.test${nextPath}${nextSearch}`;
  };
  let n = 0;
  installPageViewTagging(win, () => `pv-${++n}`);
  return { win, sent, go };
}

describe("installPageViewTagging", () => {
  it("names the headers the server reads", () => {
    expect(PAGE_VIEW_ID_HEADER.toLowerCase()).toBe(SERVER_ID_HEADER);
    expect(PAGE_VIEW_PATH_HEADER.toLowerCase()).toBe(SERVER_PATH_HEADER);
  });

  it("tags a same-origin /api call with the page view id and the page path, without the query", async () => {
    const { win, sent } = fakeWindow("/finance/review", "?tab=holds");
    await win.fetch("/api/expense/finance-queue?tab=holds");
    expect(sent[0].headers.get(PAGE_VIEW_ID_HEADER)).toBe("pv-1");
    expect(sent[0].headers.get(PAGE_VIEW_PATH_HEADER)).toBe("/finance/review");
  });

  it("gives every call on one URL the same id", async () => {
    const { win, sent } = fakeWindow("/expense/expenses/e_1");
    await win.fetch("/api/expense/expenses/e_1");
    await win.fetch(new URL("https://app.test/api/expense/expenses/e_1/reimbursee-vendor"));
    expect(sent.map((s) => s.headers.get(PAGE_VIEW_ID_HEADER))).toEqual(["pv-1", "pv-1"]);
  });

  it("mints a new id on a navigation", async () => {
    const { win, sent, go } = fakeWindow("/finance/review");
    await win.fetch("/api/expense/finance-queue");
    go("/expense/expenses/e_1");
    await win.fetch("/api/expense/expenses/e_1");
    expect(sent[1].headers.get(PAGE_VIEW_ID_HEADER)).toBe("pv-2");
    expect(sent[1].headers.get(PAGE_VIEW_PATH_HEADER)).toBe("/expense/expenses/e_1");
  });

  it("mints a new id when only the query changes", async () => {
    const { win, sent, go } = fakeWindow("/system-status/finance-views");
    await win.fetch("/api/system-status/finance-views");
    go("/system-status/finance-views", "?before=1730902312345_9");
    await win.fetch("/api/system-status/finance-views?before=1730902312345_9");
    expect(sent.map((s) => s.headers.get(PAGE_VIEW_ID_HEADER))).toEqual(["pv-1", "pv-2"]);
    expect(sent[1].headers.get(PAGE_VIEW_PATH_HEADER)).toBe("/system-status/finance-views");
  });

  it("keeps the caller's own headers and tags a Request", async () => {
    const { win, sent } = fakeWindow("/receipts");
    await win.fetch(new Request("https://app.test/api/receipts", { headers: { "Content-Type": "application/json" } }));
    expect(sent[0].headers.get("Content-Type")).toBe("application/json");
    expect(sent[0].headers.get(PAGE_VIEW_ID_HEADER)).toBe("pv-1");
  });

  it("leaves other origins and non-API paths alone", async () => {
    const { win, sent } = fakeWindow("/receipts");
    await win.fetch("https://elsewhere.test/api/receipts");
    await win.fetch("/_next/static/chunk.js");
    expect(sent.every((s) => !s.headers.has(PAGE_VIEW_ID_HEADER))).toBe(true);
  });

  it("sends no tag for a path longer than the server accepts", async () => {
    const { win, sent } = fakeWindow(`/${"a".repeat(600)}`);
    await win.fetch("/api/receipts");
    expect(sent[0].headers.has(PAGE_VIEW_ID_HEADER)).toBe(false);
  });

  it("wraps a window once", async () => {
    const { win, sent } = fakeWindow("/receipts");
    installPageViewTagging(win, () => "other");
    await win.fetch("/api/receipts");
    expect(sent).toHaveLength(1);
    expect(sent[0].headers.get(PAGE_VIEW_ID_HEADER)).toBe("pv-1");
  });
});
