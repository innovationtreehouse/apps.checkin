interface P2002Meta {
    target?: string[] | string;
    driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } };
}

/**
 * Column names a P2002 collided on, or undefined if `error` is not a P2002.
 * The driver-adapter client (@prisma/adapter-pg) reports no `meta.target`; it
 * parses the fields from Postgres's `Key ("col")=(...)` detail, quotes included.
 * Pinned by src/app/__tests__/scanFlushRace.integration.test.ts.
 */
export function uniqueViolationFields(error: unknown): string[] | undefined {
    if (typeof error !== "object" || error === null || (error as { code?: unknown }).code !== "P2002") {
        return undefined;
    }
    const meta = (error as { meta?: P2002Meta }).meta;
    const raw = meta?.target ?? meta?.driverAdapterError?.cause?.constraint?.fields ?? [];
    return (Array.isArray(raw) ? raw : [raw]).map((f) => f.replace(/^"|"$/g, ""));
}
