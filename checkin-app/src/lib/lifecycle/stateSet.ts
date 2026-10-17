/**
 * StateSet — a named set of statuses (+ optional presence-flag rule) that emits
 * BOTH a client-safe runtime predicate (`has`) AND a server Prisma `where`
 * fragment from ONE spec, so the two can never drift apart.
 *
 * Client-safe: a Prisma value here would pull the generated client into a page
 * bundle, so the `where` type is a caller-supplied generic (`Where`) and the
 * value a plain object literal. Enforced by `no-restricted-imports` in
 * `eslint.config.mjs` — `import type` only.
 */

export type StateSet<Row, Where> = {
    /** The status literals this set matches. */
    readonly statuses: readonly string[];
    /** Client-safe predicate. Booleans in, no Prisma. */
    has(row: Row): boolean;
    /** Prisma `where` fragment. Plain object literal, typed only via the generic. */
    readonly where: Where;
};

/**
 * Emit the identifying STATUS `where` clause for a from-state: a scalar
 * `{ status: X }` for a single status, `{ status: { in: [...] } }` for many.
 *
 * This is the from-state drift-closer (#1080). A CAS transition guard's from-clause
 * is `from-state ∧ nothing-else-moved`; the ONLY part that a status rename/split
 * changes is the `status:` literal. Sourcing THAT from the definition (each machine
 * wraps this as `fromWhere(edge)`) — instead of hand-writing it per guard — is what
 * keeps the ~10 CAS guards in sync with the TRANSITIONS table. The guard keeps its
 * transition-specific flag narrowing (`inventoryHeldAt`, `isPaymentPlanRequested`, …)
 * literal: those are not statuses and cannot drift with a status rename.
 *
 * Client-safe: the caller supplies the Prisma `Where` type param; the value is an
 * inert object literal (no `@/generated/prisma` value reaches the client bundle).
 * The scalar/`in` split mirrors what the guards already hand-write, so a migrated
 * guard's runtime query is byte-for-byte identical.
 */
export function fromStatusWhere<Where>(statuses: readonly string[]): Where {
    return (statuses.length === 1
        ? { status: statuses[0] }
        : { status: { in: [...statuses] } }) as Where;
}

/**
 * A field-rule map: field name → required boolean. Reused for both `flags`
 * (presence of a nullable column) and `equals` (value of a boolean column) —
 * see `defineStateSet`. The two differ only in how the boolean maps to `where`.
 */
export type FlagRule = Readonly<Record<string, boolean>>;

/**
 * Build a StateSet. Curried so an entity fixes its own Prisma `WhereInput` as the
 * `Where` type arg while the status/flag types still infer from the spec:
 *
 *   defineStateSet<Prisma.ProgramParticipantWhereInput>()({
 *       statuses: ['ACTIVE'],
 *       flags: { paidAt: true },              // nullable-timestamp PRESENCE
 *       equals: { isPaymentPlanRequested: true }, // boolean-column VALUE
 *   })
 *
 * Two rule kinds, because a nullable timestamp and a real boolean column need
 * different `where`:
 *
 * - `flags` — PRESENCE of a nullable column (timestamps like `paidAt`):
 *     `true`  → `has`: `row.field === true`,  `where`: `{ field: { not: null } }`
 *     `false` → `has`: `row.field === false`, `where`: `{ field: null }`
 *   Callers pass presence as a boolean (`!!row.paidAt`), keeping `Date | null`
 *   out of the client-safe predicate.
 *
 * - `equals` — VALUE of a genuine boolean column (`Boolean @default(false)`):
 *     `req`   → `has`: `row.field === req`,   `where`: `{ field: req }`
 *   `{ not: null }` would match BOTH true and false, so presence is wrong here.
 *
 * `has` and `where` derive from the same `flags`/`equals`, so they can't diverge.
 */
export function defineStateSet<Where>() {
    return function <
        S extends string,
        Flags extends FlagRule = Record<never, boolean>,
        Equals extends FlagRule = Record<never, boolean>,
    >(spec: {
        statuses: readonly S[];
        flags?: Flags;
        equals?: Equals;
    }): StateSet<{ status: string } & Record<keyof Flags | keyof Equals, boolean>, Where> {
        const { statuses, flags, equals } = spec;
        const flagEntries = flags ? Object.entries(flags) : [];
        const equalEntries = equals ? Object.entries(equals) : [];
        const statusSet = new Set<string>(statuses);

        // `status: string` (not the set's own literal): callers pass a full row
        // typed with the entity's whole status union, not one narrowed to this set.
        const has = (row: { status: string } & Record<keyof Flags | keyof Equals, boolean>): boolean => {
            if (!statusSet.has(row.status)) return false;
            const r = row as Record<string, unknown>;
            for (const [field, required] of flagEntries) {
                if (Boolean(r[field]) !== required) return false;
            }
            for (const [field, required] of equalEntries) {
                if (Boolean(r[field]) !== required) return false;
            }
            return true;
        };

        // Plain object literal → no Prisma runtime dependency. Cast once: the shape
        // is built dynamically, so TS can't check it against an arbitrary caller
        // `Where`; the caller's type arg is the contract.
        const where = {
            status: { in: statuses },
            // presence: nullable column not-null / null
            ...Object.fromEntries(flagEntries.map(([f, req]) => [f, req ? { not: null } : null])),
            // value-equality: boolean column === req
            ...Object.fromEntries(equalEntries.map(([f, req]) => [f, req])),
        } as Where;

        return { statuses, has, where };
    };
}
