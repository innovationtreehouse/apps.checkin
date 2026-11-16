/**
 * Tags every same-origin `/api` call with the page view it came from, so the finance view
 * log can merge one page's calls into one entry. A page view is one URL (path and query):
 * a page load, an in-app navigation and a query change such as `?before=…` each start a new one.
 *
 * The server reads the id and path headers (`checkin-app/src/security/financeView.ts`); an id
 * or path it does not accept leaves the call untagged, never unlogged.
 */

export const PAGE_VIEW_ID_HEADER = "X-Page-View-Id";
export const PAGE_VIEW_PATH_HEADER = "X-Page-View-Path";

/** The longest page path the server accepts. */
const MAX_PAGE_PATH = 512;

type Fetch = typeof fetch;

export interface TaggingWindow {
  fetch: Fetch;
  location: Pick<Location, "href" | "origin" | "pathname" | "search">;
}

export interface PageView {
  id: string;
  path: string;
}

const installed = new WeakMap<TaggingWindow, () => PageView>();

function mintId(): string {
  return crypto.randomUUID();
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isSameOriginApi(input: RequestInfo | URL, location: TaggingWindow["location"]): boolean {
  let url: URL;
  try {
    url = new URL(requestUrl(input), location.href);
  } catch {
    return false;
  }
  return url.origin === location.origin && url.pathname.startsWith("/api/");
}

/**
 * Wraps `win.fetch` once. Returns the current page view, for tests; a second install on the
 * same window leaves the first wrapper in place.
 */
export function installPageViewTagging(win: TaggingWindow, newId: () => string = mintId): () => PageView {
  const existing = installed.get(win);
  if (existing) return existing;

  const original = win.fetch.bind(win);
  let url = "";
  let current: PageView = { id: "", path: "" };

  // A new id whenever the URL has changed since the last call, so the calls of the page a
  // navigation lands on never carry the page it left.
  const pageView = (): PageView => {
    const { pathname, search } = win.location;
    if (pathname + search !== url) {
      url = pathname + search;
      current = { id: newId(), path: pathname };
    }
    return current;
  };

  win.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isSameOriginApi(input, win.location)) return original(input, init);
    const { id, path } = pageView();
    if (path.length > MAX_PAGE_PATH) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has(PAGE_VIEW_ID_HEADER)) headers.set(PAGE_VIEW_ID_HEADER, id);
    if (!headers.has(PAGE_VIEW_PATH_HEADER)) headers.set(PAGE_VIEW_PATH_HEADER, path);
    if (input instanceof Request) return original(new Request(input, { ...init, headers }));
    return original(input, { ...init, headers });
  };
  installed.set(win, pageView);
  return pageView;
}
