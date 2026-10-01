import { classifications, relations, parseToken, type Token, type Tier } from '@/security/core';

/**
 * Walk a response value, collecting every (Model.field, tier) pair encountered.
 * Records any keys that don't match the schema's classifications as undeclared.
 */
export interface CollectResult {
    seen: Map<string, Tier>;
    undeclared: Set<string>;
}

export function collectFieldKeys(
    value: unknown,
    modelHint: string,
    out: CollectResult = { seen: new Map(), undeclared: new Set() },
): CollectResult {
    if (value === null || value === undefined) return out;
    if (Array.isArray(value)) {
        for (const item of value) collectFieldKeys(item, modelHint, out);
        return out;
    }
    if (typeof value !== 'object') return out;

    const modelTiers = classifications[modelHint as keyof typeof classifications] as
        | Record<string, Tier>
        | undefined;
    const modelRelations = (relations[modelHint as keyof typeof relations] ?? {}) as Record<
        string,
        { model: string; isList: boolean }
    >;

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (modelTiers && k in modelTiers) {
            out.seen.set(`${modelHint}.${k}`, modelTiers[k]);
        } else if (k in modelRelations) {
            collectFieldKeys(v, modelRelations[k].model, out);
        } else if (k === '_count') {
            // ok — Prisma aggregate marker, not a model field
        } else {
            out.undeclared.add(`${modelHint}.${k}`);
        }
    }
    return out;
}

/**
 * Does the token list grant ANY visibility for this tier? Weaker than
 * fieldVisible — doesn't check that the caller holds the required scope on
 * the specific row. Use this as the generic contract assertion: when a
 * field of tier T appears in a response, the view must contain at least
 * one token that could grant T.
 *
 * Per-row scope correctness is enforced at runtime by the handler stripper
 * and verified by route-specific tests (not this generic contract).
 */
export function tierIsGrantable(tier: Tier, tokens: readonly Token[]): boolean {
    if (tier === 'secret') return false;
    if (tier === 'public') return tokens.includes('public');
    if (tier === 'member') return tokens.includes('member');
    for (const tok of tokens) {
        if (tok === 'public' || tok === 'member') continue;
        const parsed = parseToken(tok);
        if (parsed && parsed !== 'public' && parsed !== 'member' && parsed.tier === tier) return true;
    }
    return false;
}
