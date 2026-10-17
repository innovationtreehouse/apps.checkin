/**
 * Flow-test helpers: drive the *running* dev server over HTTP (no in-process
 * imports), authenticating through the local persona-mint flow like a browser.
 * Used only by `*.flow.test.ts` against a live server (see AGENTS.md → Flow tests).
 */

export const BASE = process.env.FLOW_BASE_URL || "http://localhost:4000";

type Jar = Map<string, string>;

function absorb(jar: Jar, res: Response): void {
    for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";", 1)[0];
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
}

const header = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

export interface Session { jar: Jar; personaId: number; }

/** Sign in as a seeded persona (by email) via persona-mint; returns its cookie jar and resolved persona id. */
export async function loginAs(email: string): Promise<Session> {
    const jar: Jar = new Map();

    // Persona ids are autoincrement (vary per seed) — resolve by stable email.
    const res = await fetch(`${BASE}/api/auth/dev-personas`).catch(() => null);
    if (!res) {
        throw new Error(
            `no server reachable at ${BASE}. Flow tests don't start one — run ` +
            `'npm run test:flow:standalone' (spins Postgres + a seeded dev server via ` +
            `docker), or start 'npm run dev' yourself first and rerun 'npm run test:flow'.`,
        );
    }
    const list = await res.json();
    const persona = (list.personas ?? []).find((p: { email: string }) => p.email === email);
    if (!persona) throw new Error(`dev persona not found: ${email} (need CHECKIN_ENV=local + a seeded DB)`);

    const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
    absorb(jar, csrfRes);
    const { csrfToken } = await csrfRes.json();

    const cb = await fetch(`${BASE}/api/auth/callback/persona-mint`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: header(jar) },
        body: new URLSearchParams({ csrfToken, personaId: String(persona.id), mode: "impersonate", callbackUrl: `${BASE}/`, json: "true" }),
        redirect: "manual",
    });
    absorb(jar, cb);
    if (![...jar.keys()].some((k) => k.includes("session-token"))) {
        throw new Error(`login failed for ${email}: no session cookie set`);
    }
    return { jar, personaId: persona.id };
}

/** Fetch JSON from the running server, attaching a session's cookies when given. */
export async function api<T = unknown>(
    session: Session | null,
    path: string,
    init: RequestInit = {},
): Promise<{ status: number; json: T }> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (session) headers.cookie = header(session.jar);
    if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json: json as T };
}
