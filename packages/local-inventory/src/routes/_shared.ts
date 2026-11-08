import { db } from "../lib/db";

/** `page` (1-based) and `limit` (1–200, default 50) as Prisma skip/take. */
export function pageArgs(sp: URLSearchParams): { skip: number; take: number } {
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const take = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  return { skip: (page - 1) * take, take };
}

/** The org's provisional parts among these GTINs, for the names the catalog doesn't hold. */
export function provisionalNames(orgId: string, gtin13s: readonly string[]) {
  return db.inventoryProvisionalItem.findMany({
    where: { orgId, provisionalGtin13: { in: [...new Set(gtin13s)] } },
    select: { provisionalGtin13: true, name: true },
  });
}
