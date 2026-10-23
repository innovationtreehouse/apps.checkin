/**
 * The page a detail screen's back link returns to: `from` when it is a path on
 * this site, otherwise `fallback`. `from` arrives in the URL, so anything that
 * could leave the site (`//host`, `/\host`, a scheme) falls back. The check runs
 * on the normalized path too, since dot segments (`/..//host`) collapse to `//host`.
 */
export function returnPath(from: string | string[] | undefined, fallback: string): string {
  const raw = Array.isArray(from) ? from[0] : from;
  if (!raw || !isSitePath(raw)) return fallback;
  const url = new URL(raw, "http://in-app.invalid");
  const path = `${url.pathname}${url.search}`;
  return url.origin === "http://in-app.invalid" && isSitePath(path) ? path : fallback;
}

const isSitePath = (p: string) => p.startsWith("/") && !p.startsWith("//") && !p.includes("\\");
