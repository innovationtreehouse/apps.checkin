import type { ZodType } from "zod";

/**
 * Org identity for a signed inter-service call. Pass a bare orgId string when
 * orgName is irrelevant (it is signed as ""), or the object form to forward a
 * real orgName into the org token.
 */
export type OrgAuth = string | { orgId: string; orgName?: string };

export interface ServiceClientConfig {
  /**
   * Resolves the target service base URL (e.g. from a DB settings row). Called
   * on every request — the caller owns any caching/invalidation. Should throw a
   * descriptive error when the URL is not configured.
   */
  resolveBaseUrl: () => string | Promise<string>;
  /** Prepended to every request path, e.g. "/api/internal". Defaults to "". */
  pathPrefix?: string;
  /** Service name used in thrown error messages, e.g. "global catalog". */
  serviceName: string;
  /** Mints the bearer token sent with every request. */
  signToken: (claims: { orgId: string; orgName: string }) => Promise<string>;
}

/**
 * Per-request options for the convenience helpers. `headers` are merged on top
 * of the default Content-Type/Authorization headers — use this to attach
 * cross-cutting contract headers such as an idempotency key or a schema version
 * without dropping to the raw `request` escape hatch.
 */
export interface ServiceRequestInit {
  headers?: Record<string, string>;
}

export interface ServiceClient {
  /**
   * Signed fetch escape hatch returning the raw Response (no ok-check, no parse).
   * Use for endpoint-specific handling such as 404→null, unvalidated bodies, or
   * custom response unwrapping.
   */
  request(path: string, auth: OrgAuth, init?: RequestInit): Promise<Response>;
  /** GET → ok-check → zod-parse the JSON body. */
  get<T>(path: string, auth: OrgAuth, schema: ZodType<T>, init?: ServiceRequestInit): Promise<T>;
  /** POST → ok-check → zod-parse the JSON body. */
  post<T>(path: string, auth: OrgAuth, body: unknown, schema: ZodType<T>, init?: ServiceRequestInit): Promise<T>;
  /** POST → ok-check; does not read the success body. */
  post(path: string, auth: OrgAuth, body?: unknown, schema?: undefined, init?: ServiceRequestInit): Promise<void>;
}

function normalizeAuth(auth: OrgAuth): { orgId: string; orgName: string } {
  return typeof auth === "string"
    ? { orgId: auth, orgName: "" }
    : { orgId: auth.orgId, orgName: auth.orgName ?? "" };
}

export function createServiceClient(config: ServiceClientConfig): ServiceClient {
  const prefix = config.pathPrefix ?? "";

  async function request(path: string, auth: OrgAuth, init: RequestInit = {}): Promise<Response> {
    const baseUrl = await config.resolveBaseUrl();
    const { orgId, orgName } = normalizeAuth(auth);
    const token = await config.signToken({ orgId, orgName });
    return fetch(`${baseUrl}${prefix}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
  }

  async function ensureOk(res: Response): Promise<void> {
    if (res.ok) return;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    const msg = data.error;
    throw new Error(`${config.serviceName} error ${res.status}${msg ? `: ${msg}` : ""}`);
  }

  async function get<T>(path: string, auth: OrgAuth, schema: ZodType<T>, init?: ServiceRequestInit): Promise<T> {
    const res = await request(path, auth, { headers: init?.headers });
    await ensureOk(res);
    return schema.parse(await res.json());
  }

  async function post<T>(
    path: string,
    auth: OrgAuth,
    body?: unknown,
    schema?: ZodType<T>,
    init?: ServiceRequestInit,
  ): Promise<T | void> {
    const res = await request(path, auth, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      headers: init?.headers,
    });
    await ensureOk(res);
    if (schema) return schema.parse(await res.json());
  }

  return { request, get, post: post as ServiceClient["post"] };
}
