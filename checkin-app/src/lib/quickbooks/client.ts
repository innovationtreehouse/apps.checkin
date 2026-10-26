/**
 * checkin's one QuickBooks connection, shared by every library with a QuickBooks port.
 * getQuickBooks() answers null (QuickBooks off) unless packages/quickbooks/src/guard.ts
 * admits the configured company; the guard's inputs are our config only.
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  QuickBooksClient,
  assertQboClientId,
  assertQboTarget,
  qboEnvFromEnv,
  type AccessTokenSource,
  type QboRealm,
  type RefresherToken,
} from "@checkin/quickbooks";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";

/** Re-ask the refresher this long before the token it handed out expires. Must stay below the refresher's own 10-min refresh margin, or every call re-invokes it. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** How long a built client is reused. */
const CLIENT_TTL_MS = 60_000;

export type InvokeRefresher = (functionName: string) => Promise<unknown>;

const invokeLambda: InvokeRefresher = async (functionName) => {
  const lambda = new LambdaClient({ region: config.awsRegion() });
  const res = await lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: JSON.stringify({ action: "current" }) }));
  // The error payload can echo token-endpoint detail; name only the function.
  if (res.FunctionError) throw new Error(`QBO token refresher ${functionName} failed`);
  return JSON.parse(new TextDecoder().decode(res.Payload));
};

function parseRefresherToken(value: unknown): RefresherToken {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const { accessToken, expiresAt, realmId, clientId } = v;
  if (typeof accessToken !== "string" || !accessToken || typeof expiresAt !== "number" || typeof realmId !== "string" || typeof clientId !== "string") {
    throw new Error("QBO token refresher returned a malformed answer");
  }
  return { accessToken, expiresAt, realmId, clientId };
}

/**
 * The access token the refresher Lambda publishes, kept in memory until near expiry.
 * The refresher is the only holder of the refresh token; this source never refreshes.
 * Its answer must name our realm and keys, or no token is handed out.
 */
export function lambdaAccessTokenSource(opts: {
  functionName: string;
  realmId: string;
  checkinEnv: string | undefined;
  devClientId: string | undefined;
  invoke?: InvokeRefresher;
  now?: () => number;
}): AccessTokenSource {
  const invoke = opts.invoke ?? invokeLambda;
  const now = opts.now ?? Date.now;
  let cached: RefresherToken | null = null;
  let inFlight: Promise<RefresherToken> | null = null;

  const fetchToken = async (): Promise<RefresherToken> => {
    const token = parseRefresherToken(await invoke(opts.functionName));
    if (token.realmId !== opts.realmId) throw new Error("QBO token refresher holds a different realm");
    assertQboClientId(opts.checkinEnv, token.clientId, opts.devClientId);
    return token;
  };

  return {
    async current() {
      if (cached && now() < cached.expiresAt - TOKEN_MARGIN_MS) return cached.accessToken;
      inFlight ??= fetchToken().finally(() => {
        inFlight = null;
      });
      cached = await inFlight;
      return cached.accessToken;
    },
  };
}

// Kept across client rebuilds, so a rebuild does not drop the cached access token.
let lambdaSource: { key: string; source: AccessTokenSource } | null = null;

function tokenSource(checkinEnv: string | undefined, realmId: string): AccessTokenSource | null {
  const functionName = process.env.QBO_REFRESHER_FN;
  if (functionName) {
    const key = `${functionName}|${realmId}`;
    if (lambdaSource?.key !== key) {
      lambdaSource = { key, source: lambdaAccessTokenSource({ functionName, realmId, checkinEnv, devClientId: process.env.QBO_DEV_CLIENT_ID }) };
    }
    return lambdaSource.source;
  }
  return null;
}

/** Builds the client, or answers null with the reason logged. Never throws. */
export function buildQuickBooks(): QuickBooksClient | null {
  const realmId = process.env.QBO_REALM_ID;
  if (!realmId) return null;
  try {
    const checkinEnv = process.env.CHECKIN_ENV;
    const realm: QboRealm = { env: qboEnvFromEnv(), realmId };
    assertQboTarget({ checkinEnv, realm, sandboxRealmAllowed: process.env.QBO_SANDBOX_REALM_ALLOWED });
    const tokens = tokenSource(checkinEnv, realmId);
    if (!tokens) {
      logger.error("QuickBooks is off: no token source (set QBO_REFRESHER_FN)");
      return null;
    }
    return new QuickBooksClient(tokens, realm);
  } catch (err) {
    logger.error("QuickBooks is off:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

let built: { at: number; client: Promise<QuickBooksClient | null> } | null = null;

/** The shared QuickBooks client, or null while QuickBooks is off. Rebuilt every CLIENT_TTL_MS. */
export function getQuickBooks(): Promise<QuickBooksClient | null> {
  if (!built || Date.now() - built.at >= CLIENT_TTL_MS) built = { at: Date.now(), client: Promise.resolve(buildQuickBooks()) };
  return built.client;
}
