import { Prisma } from '@/generated/prisma/client'

/**
 * Central write-time normalization for Person.email.
 *
 * Person.email is `@unique`. Lowercasing at the individual-route level is
 * drift-prone: any future write path that forgets it can store a case-variant
 * ("Foo@x.com" vs "foo@x.com") — two distinct rows on the unique column (a
 * duplicate account) and case-mismatched lookups that miss. This extension is
 * the single choke point: every top-level `person` write is lowercased here so
 * no route can drift. Enforcement only — it does NOT migrate existing rows.
 *
 * KNOWN LIMITATION: Prisma query extensions intercept top-level `person.*`
 * operations and operations inside `$transaction`, but do NOT reliably
 * intercept NESTED writes that create a Person through another model's relation
 * (e.g. `household.create({ data: { householdMembers: { create: { email } } } })`).
 * Every known write site in this codebase uses direct `tx.person.create/update`
 * (createParticipantWithHousehold creates the household then the person
 * separately; routes call `person.*` directly), so those are covered. Any
 * future nested-write path must lowercase email itself.
 */

/**
 * The single definition of how a Person.email is normalized: trim surrounding
 * whitespace, then lowercase. Writes go through this (below) — the write
 * extension calls this same function, so it inherits the trim automatically;
 * every email *lookup* must run its key through it too, or a differently-cased
 * or whitespace-padded address (` John.Doe@x ` vs the stored `john.doe@x`)
 * misses the row. Keep read and
 * write on this one function so they can never drift.
 */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

/** Lowercase `data.email`, handling the plain (`email: "X"`) and wrapped
 * (`email: { set: "X" }`) forms. Null/undefined/non-string emails are left
 * untouched. Idempotent. Mutates `data` in place. */
function lowerEmailOnData(data: unknown): void {
    if (data == null || typeof data !== 'object') return
    const d = data as { email?: unknown }
    const email = d.email
    if (typeof email === 'string' && email.length > 0) {
        d.email = normalizeEmail(email)
        return
    }
    // Wrapped update form: { email: { set: "X" } }
    if (email != null && typeof email === 'object' && 'set' in email) {
        const wrapped = email as { set?: unknown }
        if (typeof wrapped.set === 'string' && wrapped.set.length > 0) {
            wrapped.set = normalizeEmail(wrapped.set)
        }
    }
}

export const emailNormalizeExtension = Prisma.defineExtension({
    name: 'personEmailNormalize',
    query: {
        person: {
            create({ args, query }) {
                lowerEmailOnData(args.data)
                return query(args)
            },
            update({ args, query }) {
                lowerEmailOnData(args.data)
                return query(args)
            },
            updateMany({ args, query }) {
                lowerEmailOnData(args.data)
                return query(args)
            },
            upsert({ args, query }) {
                lowerEmailOnData(args.create)
                lowerEmailOnData(args.update)
                return query(args)
            },
            createMany({ args, query }) {
                const data = args.data
                if (Array.isArray(data)) {
                    for (const row of data) lowerEmailOnData(row)
                } else {
                    lowerEmailOnData(data)
                }
                return query(args)
            },
        },
    },
})
