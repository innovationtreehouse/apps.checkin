/**
 * Parse helpers for the route factories. Failures throw a host-rendered HTTP
 * error (runtime.inventoryError), so the library never touches NextResponse.
 */
import type { ZodType } from "zod";
import { inventoryError } from "../runtime";

export function parseId(raw: string | undefined, label = "id"): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(n) || n <= 0) throw inventoryError(400, `Invalid ${label}`);
  return n;
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw inventoryError(400, "Invalid JSON body");
  }
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const result = schema.safeParse(await readJson(req));
  if (!result.success) {
    throw inventoryError(400, result.error.issues[0]?.message ?? "Invalid request body");
  }
  return result.data;
}

export function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

/** `page` (1-based) and `limit` (1–200, default 50) as Prisma skip/take. */
export function pageArgs(sp: URLSearchParams): { skip: number; take: number } {
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const take = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  return { skip: (page - 1) * take, take };
}
