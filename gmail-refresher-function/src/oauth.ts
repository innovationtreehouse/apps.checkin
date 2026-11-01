const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export interface OauthClient {
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** Errors name Google's error code only; the response body never reaches a log. */
async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) {
    const code = typeof json?.error === "string" ? json.error : "unknown";
    throw new Error(`Google token request failed ${res.status}: ${code}`);
  }
  return json as TokenResponse;
}

/** access_type=offline and prompt=consent make Google issue a refresh token on every consent. */
export function authUrl(clientId: string, redirectUri: string, mailbox: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_READONLY_SCOPE,
    access_type: "offline",
    prompt: "consent",
    login_hint: mailbox,
    state,
  });
  return `${AUTH_ENDPOINT}?${q}`;
}

/** Exchanges a consent code, refusing a grant that is wider or narrower than gmail.readonly. */
export async function exchangeCode(client: OauthClient, code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string }> {
  const t = await tokenRequest(new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  }));
  if (t.scope !== GMAIL_READONLY_SCOPE) throw new Error("Google granted a scope other than gmail.readonly");
  if (!t.refresh_token) throw new Error("Google returned no refresh token");
  return { accessToken: t.access_token, refreshToken: t.refresh_token };
}

export async function refreshAccessToken(client: OauthClient, refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const t = await tokenRequest(new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }));
  return { accessToken: t.access_token, expiresIn: t.expires_in };
}
