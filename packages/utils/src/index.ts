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
