/**
 * The error and route layer every component library shares: the errors a library throws,
 * the mapping from those errors to an HTTP status, and the parse helpers its route
 * factories use. Server-only; it imports no React and no database driver.
 *
 * Errors are recognised by a `Symbol.for` brand, never by `instanceof`: the instrumentation
 * chunk that configures a library and each route chunk can load separate copies of this
 * module, so class identity differs, while the global symbol registry is shared. The file
 * has no relative imports: Turbopack resolves only the package's `.` export.
 */
import type { ZodType } from "zod";

const SERVICE_ERROR = Symbol.for("@checkin/component-kit/ServiceError");
const HTTP_ERROR = Symbol.for("@checkin/component-kit/ComponentHttpError");

function branded(err: unknown, brand: symbol): err is Error & { status: number } {
  return err instanceof Error && brand in err && "status" in err && typeof err.status === "number";
}

/** An expected failure a service names by its HTTP status: 400, 403, 404, 409, 429. */
export class ServiceError extends Error {
  readonly [SERVICE_ERROR] = true;

  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** An HTTP-status error a route factory throws; the host renders it as its own API error. */
export class ComponentHttpError extends Error {
  readonly [HTTP_ERROR] = true;

  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ComponentHttpError";
  }
}

export function httpError(status: number, message: string): ComponentHttpError {
  return new ComponentHttpError(status, message);
}

export function isServiceError(err: unknown): err is ServiceError {
  return branded(err, SERVICE_ERROR);
}

export function isComponentHttpError(err: unknown): err is ComponentHttpError {
  return branded(err, HTTP_ERROR);
}

interface ZodIssueLike {
  message: string;
}

function isZodError(err: unknown): err is Error & { issues: ZodIssueLike[] } {
  return err instanceof Error && err.name === "ZodError" && "issues" in err && Array.isArray(err.issues);
}

/** The one zod message format: the first issue's message. */
export function zodMessage(error: { issues: readonly ZodIssueLike[] }, fallback = "Invalid request body"): string {
  return error.issues[0]?.message ?? fallback;
}

/**
 * The HTTP error an expected failure renders as: a ServiceError or ComponentHttpError keeps
 * its status, a ZodError is a 400. Anything else is null and stays an opaque 500.
 */
export function toHttpError(err: unknown): ComponentHttpError | null {
  if (isComponentHttpError(err)) return err;
  if (isServiceError(err)) return httpError(err.status, err.message);
  if (isZodError(err)) return httpError(400, zodMessage(err, "Invalid request"));
  return null;
}

/** Runs a service call, remapping its expected failures to a host-rendered HTTP error. */
export async function mapServiceErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttpError(err) ?? err;
  }
}

/** A positive integer path or query id; `Number()` rejects trailing junk such as `12abc`. */
export function parseId(raw: string | null | undefined, label = "id"): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `Invalid ${label}`);
  return n;
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const result = schema.safeParse(await readJson(req));
  if (!result.success) throw httpError(400, zodMessage(result.error));
  return result.data;
}

export function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}
