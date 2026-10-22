/**
 * The page a detail screen's back link returns to: `from` when it is a path on
 * this site, otherwise `fallback`. `from` arrives in the URL, so anything that
 * could leave the site (`//host`, `/\host`, a scheme) falls back.
 */
export function returnPath(from: string | string[] | undefined, fallback: string): string {
  const raw = Array.isArray(from) ? from[0] : from;
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return fallback;
  const url = new URL(raw, "http://in-app.invalid");
  return url.origin === "http://in-app.invalid" ? `${url.pathname}${url.search}` : fallback;
}
