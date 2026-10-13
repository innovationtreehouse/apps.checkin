// Which QuickBooks company a deployment may reach, decided only from our own config and
// database, never from anything read back from QuickBooks. Pure: callers pass every input.
import type { QboRealm } from "./types";

export interface QboTargetConfig {
  /** Raw CHECKIN_ENV. Only exactly "prod" is production; unset or anything else is not. */
  checkinEnv: string | undefined;
  realm: QboRealm;
  /** Off prod: the one sandbox realm this deployment may use, provisioned apart from the realm itself. */
  sandboxRealmAllowed: string | undefined;
  /** The Board-set production realm in this deployment's database; null while unset. */
  productionRealmId: string | null;
}

/**
 * Throws unless `realm` is the one company this deployment may reach. Prod reaches only the
 * Board-set realm, and nothing while it is unset. Everywhere else reaches only the allowlisted
 * sandbox realm, and never the realm its own database names as production, which is how a
 * prod-data copy (stg) is kept off the real company.
 */
export function assertQboTarget(cfg: QboTargetConfig): void {
  const { realm } = cfg;
  if (!/^\d+$/.test(realm.realmId)) throw new Error("QBO realmId must be numeric");
  if (cfg.checkinEnv === "prod") {
    if (realm.env !== "production") throw new Error("CHECKIN_ENV=prod must use the production QuickBooks API");
    if (!cfg.productionRealmId) throw new Error("QuickBooks is off: the Board has not set the production realm");
    if (realm.realmId !== cfg.productionRealmId) throw new Error("QBO realm is not the Board-set production realm");
    return;
  }
  if (realm.env !== "sandbox") throw new Error("Only CHECKIN_ENV=prod may use the production QuickBooks API");
  if (!cfg.sandboxRealmAllowed) throw new Error("QBO_SANDBOX_REALM_ALLOWED must be set off prod");
  if (realm.realmId !== cfg.sandboxRealmAllowed) throw new Error("QBO realm is not the allowlisted sandbox realm");
  if (cfg.productionRealmId !== null && realm.realmId === cfg.productionRealmId) {
    throw new Error("QBO realm is this database's production realm; refused off prod");
  }
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
