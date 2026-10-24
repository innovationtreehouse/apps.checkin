/** `page` (1-based) and `limit` (1–200, default 50) as Prisma skip/take. */
export function pageArgs(sp: URLSearchParams): { skip: number; take: number } {
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const take = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  return { skip: (page - 1) * take, take };
}
