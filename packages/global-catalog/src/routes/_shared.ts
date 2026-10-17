/**
 * Thin parse helpers for the route factories. Validation failures throw a
 * host-rendered HTTP error (runtime.catalogError → checkin ApiResponseError),
 * which handler() maps to a 4xx — the library never touches NextResponse.
 */
import type { ZodType } from "zod";
import { catalogError } from "../runtime";

export function parseId(raw: string | undefined, label = "id"): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(n) || n <= 0) throw catalogError(400, `Invalid ${label}`);
  return n;
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw catalogError(400, "Invalid JSON body");
  }
}

export function parseBody<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw catalogError(400, result.error.issues[0]?.message ?? "Invalid request body");
  }
  return result.data;
}

export function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}
