// Which QuickBooks company a deployment may reach, decided only from our own config, never
// from anything read back from QuickBooks. Pure: callers pass every input.
import type { QboEnv, QboRealm } from "./types";

export interface QboTargetConfig {
  /** Raw CHECKIN_ENV. Only exactly "prod" (production) and "dev" (sandbox) get a client. */
  checkinEnv: string | undefined;
  /** QBO_ENVIRONMENT + QBO_REALM_ID; on prod the realm is set with the refresher secret. */
  realm: QboRealm;
  /** On dev: the one sandbox realm it may use, provisioned apart from the realm itself. */
  sandboxRealmAllowed: string | undefined;
}

/**
 * Throws unless `realm` is one this deployment may reach. Prod reaches the configured realm
 * through the production API. Dev reaches only the allowlisted sandbox realm through the
 * sandbox API. Every other environment (stg, local, unset) reaches nothing.
 */
export function assertQboTarget(cfg: QboTargetConfig): void {
  const { realm } = cfg;
  if (!/^\d+$/.test(realm.realmId)) throw new Error("QBO realmId must be numeric");
  if (cfg.checkinEnv === "prod") {
    if (realm.env !== "production") throw new Error("CHECKIN_ENV=prod must use the production QuickBooks API");
    return;
  }
  if (cfg.checkinEnv !== "dev") throw new Error("QuickBooks runs only on CHECKIN_ENV=prod or dev");
  if (realm.env !== "sandbox") throw new Error("Only CHECKIN_ENV=prod may use the production QuickBooks API");
  if (!cfg.sandboxRealmAllowed) throw new Error("QBO_SANDBOX_REALM_ALLOWED must be set on dev");
  if (realm.realmId !== cfg.sandboxRealmAllowed) throw new Error("QBO realm is not the allowlisted sandbox realm");
}

/**
 * Off prod the token must come from Intuit's development keys, which cannot open a
 * production company; prod refuses those keys. `devClientId` is our config, never a secret.
 */
export function assertQboClientId(checkinEnv: string | undefined, clientId: string, devClientId: string | undefined): void {
  if (!devClientId) throw new Error("QBO_DEV_CLIENT_ID must be set");
  if (checkinEnv === "prod") {
    if (clientId === devClientId) throw new Error("CHECKIN_ENV=prod refuses the development QuickBooks keys");
  } else if (clientId !== devClientId) {
    throw new Error("Off prod, QuickBooks tokens must come from the development keys");
  }
}

/** Stamped into every sandbox write's PrivateNote. */
export const TEST_NOTE_MARKER = "[checkin-test]";
/** Prefixes every sandbox Vendor's DisplayName. */
export const TEST_VENDOR_PREFIX = "TEST-";
// The sandbox is a public Intuit company: nothing written there may name the org.
const ORG_NAME = /treehouse/i;

/**
 * Sandbox writes must carry our test marker and must not name the org; production writes
 * must not carry the marker. Checked on the final request body, just before it is sent.
 */
export function assertPayloadMarked(env: QboEnv, entity: string, body: Record<string, unknown>): void {
  const marked =
    entity === "Vendor"
      ? typeof body.DisplayName === "string" && body.DisplayName.startsWith(TEST_VENDOR_PREFIX)
      : typeof body.PrivateNote === "string" && body.PrivateNote.includes(TEST_NOTE_MARKER);
  if (env === "production") {
    if (marked) throw new Error("QBO production write carries the test marker");
    return;
  }
  if (!marked) throw new Error("QBO sandbox write is missing the test marker");
  if (ORG_NAME.test(JSON.stringify(body))) throw new Error("QBO sandbox write names the org");
}
