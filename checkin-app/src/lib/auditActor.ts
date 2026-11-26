import type { AuditAction, Prisma } from "@/generated/prisma/client";
import { type TxClient, isRootClient } from "@/lib/db-client";

/**
 * Who an AuditLog row is attributed to.
 *
 * Two rules are enforced here rather than at 85
 * scattered `auditLog.create` call sites:
 *
 * - *Accountability — a system actor names itself.* `actorId: 0` alone cannot
 *   tell the nightly sweep from the renewal sweep from a Shopify webhook, so a
 *   system row carries `actorSystem` as well and the name comes from a closed
 *   list.
 * - *Fail closed.* A person's action with a missing actor is refused, never
 *   quietly filed as System.
 */

/** Sentinel actorId for every non-person write; `actorSystem` says which one. */
export const SYSTEM_ACTOR = 0;

/**
 * Every automated path that writes audit rows, named `surface:path` — `cron:` for
 * a scheduled route, `webhook:` for an inbound call, `system:` for a library path
 * more than one surface can wake, `kiosk:` for the check-in station, `migration:`
 * for a one-off data migration or backfill script.
 */
export const SYSTEM_ACTORS = [
    "cron:nightly",
    "cron:trusted-adult-expiry",
    "cron:lifecycle-reconcile",
    "system:google-sign-in",
    "system:sign-in",
    "system:renewal-open",
    "system:membership-renewal-advance",
    "system:membership-external-advance",
    "system:person-bg-open",
    "system:membership-bg-settle",
    "system:person-agreement-open",
    "system:person-agreement-close-on-lead",
    "system:bootstrap-sysadmin",
    "system:dev-seed",
    "system:facility-close",
    "system:bucket-class-check",
    "webhook:zoho-contract",
    "webhook:shopify-order",
    "webhook:shopify-receipt",
    "webhook:shopify-refund",
    "kiosk:two-deep",
    "migration:key-volunteer-grandfather",
    "migration:membership-year-order-fill",
] as const;

export type SystemActorName = (typeof SYSTEM_ACTORS)[number];

/** The actor half of an `auditLog.create` payload. Spread into `data`. */
export type AuditActor = { actorId: number; actorSystem: string | null };

/** Attribute a row to a named automated path. */
export function systemActor(name: SystemActorName): AuditActor {
    return { actorId: SYSTEM_ACTOR, actorSystem: name };
}

/**
 * Attribute a row to a person. Throws on a missing/zero actor rather than
 * letting it fall through to System — an unattributable decision is a bug at
 * the call site, and a row that blames the system for it is worse than none.
 */
export function personActor(actorId: number): AuditActor {
    if (!Number.isInteger(actorId) || actorId <= 0) {
        throw new Error(`Audit actor missing (got ${actorId}): a person's action cannot be filed as System.`);
    }
    return { actorId, actorSystem: null };
}

/** For paths a person OR an automated path can take (e.g. board certify vs. Shopify webhook). */
export function personOrSystemActor(actorId: number | null | undefined, name: SystemActorName): AuditActor {
    return actorId ? personActor(actorId) : systemActor(name);
}

/** The change half of an `auditLog.create` payload. */
export type AuditEntry = {
    action: AuditAction;
    tableName: string;
    affectedEntityId: number;
    secondaryAffectedEntity?: number | null;
    oldData?: Prisma.InputJsonValue;
    newData?: Prisma.InputJsonValue;
};

/**
 * Write an audit row with the transaction client that made the change, so the
 * two commit together. Opens no transaction of its own. Refuses the root client,
 * which the `TxClient` type accepts but which would commit the row on its own.
 */
export function recordAudit(tx: TxClient, actor: AuditActor, entry: AuditEntry) {
    if (isRootClient(tx)) throw new Error("recordAudit must run inside the change's transaction.");
    return tx.auditLog.create({ data: { ...actor, ...entry } });
}
