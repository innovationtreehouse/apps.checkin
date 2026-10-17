/**
 * Outbound gateway — the only legal way to send data to a third party.
 *
 * Every Shopify / email / external webhook call goes through `outboundCall`.
 * The runtime strips the payload to the surface's declared tier-list BEFORE
 * the user's `send` callback ever sees it, so the network layer never has
 * access to fields outside the policy.
 *
 * Outbound has no caller — there's no row-relationship to evaluate. The tier
 * list is unconditional: only those tiers leave; `secret` is always stripped.
 *
 * IMPORTANT: This file is CODEOWNERS-gated.
 */
import { classifications, relations, getOutbound } from './core';
// Side-effect import to register outbound surfaces.
import './registry';

export type OutboundPayload = Record<string, unknown>;

export async function outboundCall<T>(
    surface: string,
    payload: OutboundPayload,
    send: (stripped: OutboundPayload) => Promise<T>,
): Promise<T> {
    const spec = getOutbound(surface);
    if (!spec) {
        throw new Error(`[security] No registered outbound surface: ${surface}`);
    }

    const allowedTiers = new Set<string>(spec.tiers);
    const stripped: OutboundPayload = {};
    for (const [modelName, value] of Object.entries(payload)) {
        if (!(modelName in classifications)) {
            throw new Error(
                `[security] Outbound ${surface}: bag key '${modelName}' is not a known model`,
            );
        }
        stripped[modelName] = stripForOutbound(modelName, value, allowedTiers);
    }
    return send(stripped);
}

function stripForOutbound(
    modelName: string,
    value: unknown,
    allowedTiers: ReadonlySet<string>,
): unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
        return value.map(item => stripForOutbound(modelName, item, allowedTiers));
    }
    if (typeof value !== 'object') return value;

    const obj = value as Record<string, unknown>;
    const tiers = classifications[modelName as keyof typeof classifications] as
        | Record<string, string>
        | undefined;
    if (!tiers) return null;
    const rels = (relations[modelName as keyof typeof relations] ?? {}) as Record<
        string,
        { model: string; isList: boolean }
    >;

    const result: Record<string, unknown> = {};
    for (const [field, tier] of Object.entries(tiers)) {
        if (!(field in obj)) continue;
        if (tier === 'secret') continue;
        if (allowedTiers.has(tier)) result[field] = obj[field];
    }
    for (const [relName, relInfo] of Object.entries(rels)) {
        if (!(relName in obj)) continue;
        result[relName] = stripForOutbound(relInfo.model, obj[relName], allowedTiers);
    }
    // ponytail: no `_count` handling — it is intentionally not copied, so counts
    // never leave on the wire (fail-closed). If a future surface needs `_count`,
    // gate each key like the stripper does: pass only relations with a visible
    // field, here meaning the target model has a field in `allowedTiers`.
    return result;
}
