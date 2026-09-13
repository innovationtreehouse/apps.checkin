/**
 * The bag stripper — the enforcement function that decides whether each field
 * reaches the response wire. Separated from handler.ts so it can be unit-
 * tested in isolation, without dragging in NextAuth / NextResponse / etc.
 *
 * Inputs:
 *   - modelName / value : the bag entry being walked (recursive)
 *   - tokens            : the view's permission tokens for the resolved role
 *   - callerCtx         : prefetched per-request caller context
 *
 * For each scalar field, visibility is decided by `fieldVisible(tier, tokens,
 * scopes)` where `scopes = scopesHeld(modelName, row, callerCtx)` — the
 * per-row predicate. Relations are recursed into; each `_count` key is gated
 * to relations the view can see (see relationVisible).
 *
 * IMPORTANT: This file is CODEOWNERS-gated.
 */
import { classifications, relations, fieldVisible, type Scope, type Tier, type Token } from './core';
import { scopesHeld, type CallerContext } from './access-resolvers';

export function stripBag(
    bag: Record<string, unknown>,
    tokens: readonly Token[],
    callerCtx: CallerContext,
): Record<string, unknown> {
    const stripped: Record<string, unknown> = {};
    for (const [modelName, value] of Object.entries(bag)) {
        if (!(modelName in classifications)) {
            console.warn(`[security] bag key '${modelName}' is not a known model — dropping`);
            continue;
        }
        stripped[modelName] = stripValue(modelName, value, tokens, callerCtx);
    }
    return stripped;
}

export function stripValue(
    modelName: string,
    value: unknown,
    tokens: readonly Token[],
    callerCtx: CallerContext,
): unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
        return value.map(item => stripValue(modelName, item, tokens, callerCtx));
    }
    if (typeof value !== 'object') return value;

    const obj = value as Record<string, unknown>;
    const tiers = classifications[modelName as keyof typeof classifications] as
        | Record<string, Tier>
        | undefined;
    if (!tiers) return null;

    const scopes = scopesHeld(modelName, obj, callerCtx);
    const rels = (relations[modelName as keyof typeof relations] ?? {}) as Record<
        string,
        { model: string; isList: boolean }
    >;

    const result: Record<string, unknown> = {};
    for (const [field, tier] of Object.entries(tiers)) {
        if (!(field in obj)) continue;
        if (fieldVisible(tier, tokens, scopes)) {
            result[field] = obj[field];
        }
    }

    if ('_count' in obj && typeof obj._count === 'object' && obj._count !== null) {
        // Gate each relation count like a field: a count is in the whitelist only
        // for relations this view can actually see. Unknown relation keys drop
        // (fail-closed). Without this, `_count: { select: { rel: true } }` would
        // leak aggregate counts of relations the caller has no grant on.
        const counts = obj._count as Record<string, unknown>;
        const gated: Record<string, unknown> = {};
        for (const [relName, count] of Object.entries(counts)) {
            const rel = rels[relName];
            if (rel && relationVisible(rel.model, tokens, scopes)) gated[relName] = count;
        }
        if (Object.keys(gated).length > 0) result._count = gated;
    }

    for (const [relName, relInfo] of Object.entries(rels)) {
        if (!(relName in obj)) continue;
        result[relName] = stripValue(relInfo.model, obj[relName], tokens, callerCtx);
    }
    return result;
}

/**
 * Whether the caller can see a relation at all — true iff at least one field of
 * the target model is visible under these tokens/scopes. A `_count` reveals no
 * more than the existence of the relation's rows, so it rides the same
 * visibility as the relation's least-sensitive visible field. Evaluated with the
 * parent row's scopes (an aggregate has no per-child row to resolve). Unknown
 * model → false (fail-closed).
 */
function relationVisible(
    targetModel: string,
    tokens: readonly Token[],
    scopes: ReadonlySet<Scope>,
): boolean {
    const tiers = classifications[targetModel as keyof typeof classifications] as
        | Record<string, Tier>
        | undefined;
    if (!tiers) return false;
    for (const tier of Object.values(tiers)) {
        if (fieldVisible(tier, tokens, scopes)) return true;
    }
    return false;
}
