import { invalidateLoads } from "./loadCache";

/**
 * A response that was not a usable answer. Its message is the route's `error` text, a gateway's, or `FAILURE_TEXT`.
 * `fields` names the inputs the route refused, so a form can highlight them; `code` is the route's error code, if it sent one.
 */
export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly fields: readonly string[] = [], readonly code: string | null = null) {
    super(message);
    this.name = "HttpError";
  }
}

/** The fixed text a person sees for a failure that brought no words of its own. */
export const FAILURE_TEXT = "Something went wrong. Try again.";

/** The fixed text a person sees when a request never got an answer. */
export const NETWORK_FAILURE_TEXT = "Couldn't reach the server. Check your connection and try again.";

/** The request never got an answer: offline, DNS, or the connection dropped. */
class NetworkError extends Error {
  constructor() {
    super(NETWORK_FAILURE_TEXT);
    this.name = "NetworkError";
  }
}

/** `invalidate: false` is for a loop of writes, which calls `invalidateLoads` once when it ends. */
export type RequestOptions = RequestInit & { invalidate?: boolean };

/**
 * The words for a failure that came from in front of the app rather than its routes. A sleeping dev
 * instance's waker and a load balancer both answer 503 with HTML, and a waker's carries Retry-After.
 */
function gatewayMessage(res: Response, isJson: boolean, isRead: boolean): string | null {
  if (res.status === 503 && (!isJson || res.headers.has("Retry-After"))) {
    return isRead
      ? "The app was asleep and is starting up. Try again in a minute."
      : "The app was asleep and is starting up. Nothing was saved. Try again in a minute.";
  }
  // A gateway timeout or dropped connection may come after the app committed a write.
  if (!isJson && (res.status === 502 || res.status === 504)) {
    return isRead ? "The server is unavailable. Try again in a minute." : "The server didn't answer. Reload to check whether your change saved before trying again.";
  }
  return null;
}

/** Fetches `url` and returns its JSON body; a failure throws `HttpError`. A successful write re-reads every cached load. */
export async function request<T>(url: string, { invalidate = true, ...options }: RequestOptions = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const method = (options.method ?? "GET").toUpperCase();
  let res: Response;
  try {
    res = await fetch(url, { ...(isForm ? {} : { headers: { "Content-Type": "application/json" } }), ...options });
  } catch {
    throw new NetworkError();
  }
  if (res.ok && invalidate && method !== "GET") invalidateLoads();
  const text = await res.text();
  let data: unknown = null;
  let isJson = true;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    isJson = false;
  }
  if (res.ok && !isJson) throw new HttpError(FAILURE_TEXT, res.status);
  if (!res.ok) {
    const { error: message, fields, code } = (data ?? {}) as { error?: unknown; fields?: unknown; code?: unknown };
    if (typeof message !== "string" || !message.trim()) {
      throw new HttpError(gatewayMessage(res, isJson, method === "GET" || method === "HEAD") ?? FAILURE_TEXT, res.status);
    }
    throw new HttpError(
      message,
      res.status,
      Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string") : [],
      typeof code === "string" ? code : null,
    );
  }
  return data as T;
}

/** The text a person sees for a failure: the route's words, or fixed text for anything else, never exception text. */
export function errorMessage(e: unknown): string {
  return e instanceof HttpError || e instanceof NetworkError ? e.message : FAILURE_TEXT;
}
