/**
 * The page allowlist for the finance view log: the API routes each page may fold
 * into its one page-view entry (docs/in-design/FINANCE_VIEW_RECORD_IDS.md §4, Q11).
 *
 * A call claiming a page whose list lacks its route writes a row of its own, so no
 * client can fold a donation view into an expense entry. A page missing here logs
 * each of its calls as its own row: noisy, never unlogged. Patterns use the app
 * router's `[param]` segments, matching one path segment each.
 *
 * IMPORTANT: This file is CODEOWNERS-gated.
 */
export const PAGE_VIEW_FOLDS: Readonly<Record<string, readonly string[]>> = {
    '/expense/expenses/[id]': [
        'GET /api/expense/expenses/[id]',
        'GET /api/expense/expenses/[id]/reimbursee-vendor',
        'GET /api/expense/expenses/[id]/qb-candidates',
    ],
    '/finance/review': ['GET /api/expense/finance-queue'],
};

function segmentsMatch(pattern: readonly string[], path: readonly string[]): boolean {
    if (pattern.length !== path.length) return false;
    return pattern.every((seg, i) => (/^\[\w+\]$/.test(seg) ? path[i].length > 0 : seg === path[i]));
}

/** The allowlist pattern a concrete page path claims, or null when no pattern matches. */
export function foldingPage(pagePath: string): string | null {
    const path = pagePath.split('/').slice(1);
    for (const pattern of Object.keys(PAGE_VIEW_FOLDS)) {
        if (segmentsMatch(pattern.split('/').slice(1), path)) return pattern;
    }
    return null;
}
