/**
 * Normalize a raw URL string. Accepts bare hostnames (e.g. "example.com") by
 * trying https:// then http:// as prefix. Returns the normalized URL string on
 * success, or null if the input cannot be parsed as a valid URL.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try { new URL(trimmed); return trimmed; } catch { return null; }
  }
  for (const scheme of ["https://", "http://"]) {
    try { new URL(scheme + trimmed); return scheme + trimmed; } catch { /* try next */ }
  }
  return null;
}

/**
 * Like normalizeUrl but probes the URL with a HEAD request to pick https vs
 * http. If the input already has a scheme, validates it and returns as-is.
 * For bare hostnames, fires both probes in parallel (2 s timeout each) and
 * returns the first that responds — preferring https. Falls back to
 * normalizeUrl result if both probes fail or fetch is unavailable.
 * Call multiple resolveUrl calls with Promise.all to stay within 2 s total.
 */
export async function resolveUrl(raw: string): Promise<string | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    try { new URL(trimmed); return trimmed; } catch { return null; }
  }

  try { new URL("https://" + trimmed); } catch { return null; }

  const probe = async (url: string): Promise<string | null> => {
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return url;
      return null;
    } catch {
      return null;
    }
  };

  const [https, http] = await Promise.all([
    probe("https://" + trimmed),
    probe("http://" + trimmed),
  ]);

  return https ?? http ?? normalizeUrl(trimmed);
}

/**
 * Reads a request body of at most `cap` bytes. An over-cap declared length is refused before
 * any read; otherwise reading stops (and the stream is cancelled) as soon as the total passes
 * the cap. `tooLarge` builds the error each caller throws.
 */
export async function readCapped(
  body: AsyncIterable<Uint8Array> | null,
  declaredLength: string | null,
  cap: number,
  tooLarge: () => Error,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const declared = Number(declaredLength);
  if (declaredLength !== null && Number.isFinite(declared) && declared > cap) throw tooLarge();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for await (const value of body ?? []) {
    total += value.byteLength;
    if (total > cap) throw tooLarge();
    chunks.push(new Uint8Array(value));
  }
  return chunks;
}

/**
 * Strips credentials and personal data from error text before it leaves a
 * service (log lines, stored run errors, alert emails): connection-string
 * passwords, URLs carrying a query string, email addresses, auth headers,
 * key=value and NAME_SECRET=value assignments, JSON fields named like secrets,
 * provider token prefixes, and long opaque strings that look like keys.
 * Each run-matching pattern starts only at the start of its run (lookbehind),
 * and the JSON-key pattern tests the key in an atomic lookahead, so every
 * pattern scans in linear time.
 */
const PATTERNS: [RegExp, string][] = [
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+@/gi, "$1[redacted]@"],
  [/\bhttps?:\/\/[^\s"'<>]*\?[^\s"'<>]*/gi, "[url]"],
  [/(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/\b(bearer|basic|zoho-oauthtoken)\s+[^\s"',]+/gi, "$1 [redacted]"],
  [/("(?=[^"]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key))[^"]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted]"'],
  [/\b([A-Z][A-Z0-9_]*_(?:SECRET|TOKEN|KEY|PASSWORD|PASS|PWD))=[^\s"',&}]+/g, "$1=[redacted]"],
  [/\b(x-shopify-access-token|authorization|access_token|refresh_token|client_secret|api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi, "$1$2[redacted]"],
  [/\b(shpat|shpss|shpca|shppa|re|sk|pk)_[A-Za-z0-9_]{8,}/g, "[redacted]"],
  // Mixed letters and digits, so long snake_case identifiers survive.
  [/(?<![A-Za-z0-9+_-])(?=[A-Za-z_-]*\d)(?=[\d_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}/g, "[redacted]"],
];

// Bounds the size of a redacted message; the patterns are linear, so this caps
// output length rather than guarding against backtracking.
export const REDACT_MAX_CHARS = 8192;

export function redactSecrets(text: string, maxChars = REDACT_MAX_CHARS): string {
  const capped = text.length > maxChars
    ? `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`
    : text;
  return PATTERNS.reduce((s, [re, sub]) => s.replace(re, sub), capped);
}

// The organization's fiscal year ends June 30, so its Form 990 is due November 15.
const FISCAL_YEAR_END_MONTH = 6;
const FORM_990_DUE = { month: 11, day: 15 };

/**
 * The first day a record dated `day` (YYYY-MM-DD, or an ISO timestamp read in UTC) may be deleted,
 * when it is kept `keepYears` past its fiscal year's Form 990 deadline. It is kept through the
 * deadline day itself.
 */
export function form990DeleteAfter(day: string, keepYears: number): Date {
  const year = Number(day.slice(0, 4));
  const fiscalYearEnd = Number(day.slice(5, 7)) > FISCAL_YEAR_END_MONTH ? year + 1 : year;
  return new Date(Date.UTC(fiscalYearEnd + keepYears, FORM_990_DUE.month - 1, FORM_990_DUE.day + 1));
}

/**
 * The start of the oldest fiscal year still kept at `now`: every record dated before it is past
 * form990DeleteAfter, and none dated at or after it is.
 */
export function form990DueBefore(now: Date, keepYears: number): Date {
  let fiscalYearEnd = now.getUTCFullYear() - keepYears;
  const lastMonth = `${fiscalYearEnd}-${String(FISCAL_YEAR_END_MONTH).padStart(2, "0")}-01`;
  if (form990DeleteAfter(lastMonth, keepYears) > now) fiscalYearEnd--;
  // Date.UTC months count from 0, so FISCAL_YEAR_END_MONTH is the month after the year ends.
  return new Date(Date.UTC(fiscalYearEnd, FISCAL_YEAR_END_MONTH, 1));
}
