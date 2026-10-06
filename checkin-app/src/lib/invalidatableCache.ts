/**
 * Per-process read cache with explicit invalidation.
 *
 * - A fill stores only if no `invalidate()` ran while it computed, so a write
 *   that commits mid-compute is never overwritten by the older result.
 * - While `isLive(value)` holds (e.g. the building is occupied) the entry also
 *   expires after `ttlMs`, bounding staleness from a writer that forgot to
 *   invalidate. An idle value never expires, so an empty building issues no
 *   queries and the database can auto-pause.
 */
export function invalidatableCache<T>(
    compute: () => Promise<T>,
    isLive: (value: T) => boolean,
    ttlMs = 60_000,
) {
    let generation = 0;
    let entry: { value: T; at: number } | null = null;

    return {
        invalidate(): void {
            generation++;
            entry = null;
        },
        async get(): Promise<T> {
            if (entry && !(isLive(entry.value) && Date.now() - entry.at > ttlMs)) return entry.value;
            const startGeneration = generation;
            const at = Date.now();
            const value = await compute();
            if (startGeneration === generation) entry = { value, at };
            return value;
        },
    };
}
