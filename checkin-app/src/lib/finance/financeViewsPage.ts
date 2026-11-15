import { Prisma } from "@/generated/prisma/client";
import type { FinanceViewCursor, FinanceViewModelName } from "@/lib/finance/financeViewKinds";

/** The Board's finance view log filters, each optional. */
export interface FinanceViewsFilter {
  actorId?: number;
  /** Rows naming at least one record of this model. */
  model?: FinanceViewModelName;
  /** Rows naming any of these `recordIds` values (`recordSearchRefs`). */
  records?: readonly string[];
  from?: Date;
  to?: Date;
  /** Only rows older than this one, newest first. */
  before?: FinanceViewCursor;
}

/**
 * The query for the ids of one page of log rows, newest first, `limit` at most. Paging by
 * position rather than offset keeps a view logged between two pages from repeating a row.
 */
export function financeViewsPageQuery(filter: FinanceViewsFilter, limit: number): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (filter.actorId !== undefined) conditions.push(Prisma.sql`"actorId" = ${filter.actorId}`);
  // Array overlap, which the GIN index on recordIds serves.
  if (filter.records?.length) conditions.push(Prisma.sql`"recordIds" && ARRAY[${Prisma.join(filter.records)}]::text[]`);
  if (filter.model !== undefined) {
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM unnest("recordIds") AS ref WHERE starts_with(ref, ${`${filter.model}:`}))`);
  }
  if (filter.from) conditions.push(Prisma.sql`"viewedAt" >= ${filter.from}`);
  if (filter.to) conditions.push(Prisma.sql`"viewedAt" <= ${filter.to}`);
  if (filter.before) {
    const { viewedAt, id } = filter.before;
    conditions.push(Prisma.sql`("viewedAt" < ${viewedAt} OR ("viewedAt" = ${viewedAt} AND "id" < ${id}))`);
  }
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
  return Prisma.sql`SELECT "id" FROM "FinanceViewLog" ${where} ORDER BY "viewedAt" DESC, "id" DESC LIMIT ${limit}`;
}
