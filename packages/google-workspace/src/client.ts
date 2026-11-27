// The only file in this package that calls fetch. No database, no checkin-app imports.
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1/groups";
export const GROUP_MEMBER_SCOPE = "https://www.googleapis.com/auth/admin.directory.group.member";

export interface GoogleMember {
  email: string;
  role: string;
  type: string;
  status: string;
}

/** Carries status and Google's error code only; never a token or a response body. */
export class GoogleApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "GoogleApiError";
  }
}

async function errorCode(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const e = json?.error;
  if (typeof e === "string") return e;
  const reason = (e as { errors?: { reason?: unknown }[] } | undefined)?.errors?.[0]?.reason;
  return typeof reason === "string" ? reason : "unknown";
}

export interface OauthClient {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }: OauthClient): Promise<{ accessToken: string; expiresAt: number }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const code = await errorCode(res);
    throw new GoogleApiError(`Google token request failed ${res.status}: ${code}`, res.status, code);
  }
  const t = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
}

/** Caches the token in memory until 60s before it expires. */
export function cachedAccessToken(refresh: () => Promise<{ accessToken: string; expiresAt: number }>): () => Promise<string> {
  let cur: { accessToken: string; expiresAt: number } | undefined;
  return async () => {
    if (!cur || cur.expiresAt - 60_000 <= Date.now()) cur = await refresh();
    return cur.accessToken;
  };
}

export interface DirectoryOptions {
  getAccessToken: () => Promise<string>;
  /** Test seam; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 4;

export function createDirectoryClient({ getAccessToken, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: DirectoryOptions) {
  async function call(method: string, path: string, body?: unknown, okStatus?: number): Promise<Response | null> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${DIRECTORY}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${await getAccessToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res;
      if (res.status === okStatus) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      const code = await errorCode(res);
      throw new GoogleApiError(`Google Directory ${method} failed ${res.status}: ${code}`, res.status, code);
    }
  }
  const members = (g: string) => `${encodeURIComponent(g)}/members`;

  return {
    async listMembers(groupKey: string): Promise<GoogleMember[]> {
      const out: GoogleMember[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ maxResults: "200" });
        if (pageToken) q.set("pageToken", pageToken);
        const res = (await call("GET", `${members(groupKey)}?${q}`))!;
        const page = (await res.json()) as { members?: GoogleMember[]; nextPageToken?: string };
        for (const m of page.members ?? []) out.push({ email: m.email, role: m.role, type: m.type, status: m.status });
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },
    /** 409 means already a member, which is the state we wanted. */
    async insertMember(groupKey: string, email: string): Promise<void> {
      await call("POST", members(groupKey), { email, role: "MEMBER" }, 409);
    },
    /** 404 means already gone. */
    async removeMember(groupKey: string, email: string): Promise<void> {
      await call("DELETE", `${members(groupKey)}/${encodeURIComponent(email)}`, undefined, 404);
    },
  };
}
