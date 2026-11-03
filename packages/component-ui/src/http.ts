import { invalidateLoads } from "./loadCache";

/**
 * A response that was not a usable answer. Its message is the route's `error` text, or names the HTTP status.
 * `fields` names the inputs the route refused, so a form can highlight them.
 */
export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly fields: readonly string[] = []) {
    super(message);
    this.name = "HttpError";
  }
}

/** `invalidate: false` is for a loop of writes, which calls `invalidateLoads` once when it ends. */
export type RequestOptions = RequestInit & { invalidate?: boolean };

/** Fetches `url` and returns its JSON body; a failure throws `HttpError`. A successful write re-reads every cached load. */
export async function request<T>(url: string, { invalidate = true, ...options }: RequestOptions = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const res = await fetch(url, { ...(isForm ? {} : { headers: { "Content-Type": "application/json" } }), ...options });
  if (res.ok && invalidate && (options.method ?? "GET").toUpperCase() !== "GET") invalidateLoads();
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy error page or a sign-in redirect is HTML, not the route's JSON.
    throw new HttpError(res.ok ? `Unexpected non-JSON response (HTTP ${res.status})` : `HTTP ${res.status}`, res.status);
  }
  if (!res.ok) {
    const { error: message, fields } = (data ?? {}) as { error?: unknown; fields?: unknown };
    throw new HttpError(
      typeof message === "string" ? message : `HTTP ${res.status}`,
      res.status,
      Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string") : [],
    );
  }
  return data as T;
}

/** The text a person sees for a failure: the route's words, or fixed text for anything else, never exception text. */
export function errorMessage(e: unknown): string {
  return e instanceof HttpError ? e.message : "Something went wrong. Try again.";
}
