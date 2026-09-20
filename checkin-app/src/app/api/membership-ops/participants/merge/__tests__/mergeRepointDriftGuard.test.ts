import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Merge-repoint exhaustiveness guard — the Person-FK analogue of
 * livePersonDriftGuard.test.ts, and the same two-assertion shape (nothing
 * unlisted, nothing stale).
 *
 * A participant merge has to decide something about EVERY foreign key pointing
 * at `Person`. The list of those decisions lived only in `merge/route.ts`'s
 * control flow, hand-maintained, and it drifted: #1456 slice 2b-0 found SIX
 * relations the merge had never touched at all — including `RawBadgeLog`
 * (RESTRICT, so the tombstone could never be deleted) and `PersonRole`
 * (CASCADE, so a later delete would destroy a security grant with no audit
 * row). None of that produced a compiler error or a failing test; the relations
 * were simply absent, and absence is invisible.
 *
 * So the key set is DERIVED from the schema at test time and matched against
 * the annotated DISPOSITIONS map below. Add a Person FK to schema.prisma and
 * this test fails until someone writes down what the merge does with it.
 *
 * The four dispositions:
 *   - repointed        the row moves to the survivor
 *   - deduped          moved unless the survivor already has the equivalent
 *                      row, in which case the duplicate is deleted
 *   - pre-refused      a collision here refuses the whole merge before the
 *                      transaction opens (a human has to settle it first)
 *   - deliberately-left the row stays where it is, for a stated reason
 *
 * ponytail: the map is declarative — it does not grep route.ts to prove the
 * repoint still exists. Deleting a repoint is caught by the per-relation
 * integration cases in route.integration.test.ts (each one fails if its
 * `updateMany` goes away); a text grep here would just match some other line
 * using the same field name. This guard closes the OTHER half — a relation
 * nobody considered at all.
 */

const SCHEMA = join(__dirname, '..', '..', '..', '..', '..', '..', '..', 'prisma', 'schema.prisma');

/**
 * Every `<Model>.<fkField>` in the schema whose relation targets `Person`,
 * read out of the schema rather than listed here: a Person FK nobody thought
 * about is exactly the blind spot this test exists to close, and a hand-kept
 * key set reopens it the day someone adds one.
 *
 * Matches the to-one side only (`foo Person @relation(fields: [fooId], ...)`),
 * which is where the FK column and its `onDelete` actually live — the `Person[]`
 * back-reference carries neither.
 *
 * ponytail: line-oriented regex, matching how this schema is actually written.
 * Two shapes it cannot see, neither of which occurs here — if either ever does,
 * this parser is what needs upgrading (to the DMMF, which knows both):
 *   - an `@relation(...)` wrapped across multiple lines
 *   - an implicit many-to-many (`Person[]` on both sides, no `fields:` at all),
 *     whose FKs live in a generated join table rather than in either model
 */
function personForeignKeys(): string[] {
    const out: string[] = [];
    let model: string | null = null;
    for (const line of readFileSync(SCHEMA, 'utf8').split('\n')) {
        const start = /^model\s+(\w+)\s*\{/.exec(line);
        if (start) {
            model = start[1];
            continue;
        }
        if (line.trim() === '}') {
            model = null;
            continue;
        }
        if (!model) continue;
        // `name  Person?  @relation(... fields: [nameId] ...)` — `Person[]` is the
        // back-reference and is deliberately not matched.
        const rel = /^\s+\w+\s+Person\??\s+@relation\((.*)/.exec(line);
        const fk = rel && /fields:\s*\[(\w+)\]/.exec(rel[1]);
        if (fk) out.push(`${model}.${fk[1]}`);
    }
    return out.sort();
}

/**
 * What `merge/route.ts` does with each Person FK. Every entry names the FK's
 * `onDelete` too, because that is what decides how bad "do nothing" is: RESTRICT
 * blocks a later delete outright, CASCADE destroys the row silently, SET NULL
 * quietly erases whichever fact the column recorded.
 */
const DISPOSITIONS: Record<string, string> = {
    // ── repointed: the same human did this, so it follows the survivor ────────
    'Account.userId': 'repointed (CASCADE) — step 5 updateMany. Login follows the survivor.',
    'BackgroundCheckAttestation.reviewerId': 'repointed (RESTRICT) — loop-or-skip. A shared process is pre-refused above (#1686): the same human attesting under two identities needs investigation, not a silent move.',
    'BackgroundCheckAttestation.subjectPersonId': 'repointed (SET NULL) — loop-or-skip on bgSubjectKey. Two collision classes are pre-refused: one reviewer naming both identities (the unique triple), and the cross-role case where one record reviewed a check naming the other, which would otherwise become a self-review.',
    'Event.attendanceConfirmedById': 'repointed (SET NULL) — who confirmed attendance is a staff-action audit fact; left behind it reads as nobody.',
    'OrgMembershipProcess.noteAckById': 'repointed (SET NULL) — who read the family intake note, same audit-fact rationale.',
    'OrgMembershipProcess.subjectPersonId': 'repointed (SET NULL) — step 5 updateMany, then archiveDuplicatePersonBg leaves the survivor exactly one open PERSON_BG.',
    'PresenceEvent.personId': 'repointed (CASCADE) — the append-only presence log projects visits, so events left on a tombstone would flush against a person the projection can no longer treat as live; the log follows the survivor like RawBadgeLog does.',
    'PersonMerge.toId': 'repointed (RESTRICT) — an earlier merge\'s archive row naming this record as ITS survivor. Repointed, not chained: the archive answers "where is this person now", and RESTRICT means a row left here would pin the very Person that #1456 2b-3 exists to delete. Deliberately the opposite call from Person.mergedIntoId below, which keeps its chain for provenance — the archive already has mergedAt and the AuditLog for that.',
    'PersonRole.grantedById': 'repointed (SET NULL) — swept AFTER the holder pass, so a granter stamp on a row the dedupe just deleted is not counted as moved.',
    'Program.leadMentorId': 'repointed (SET NULL) — step 5 updateMany.',
    'ProgramInstance.leadMentorId': 'repointed (SET NULL) — step 5 updateMany, same as Program.leadMentorId (the offering-tier lead of a run follows the survivor).',
    'RawBadgeLog.personId': 'repointed (RESTRICT) — the FK that makes a later Person delete possible at all. Plain updateMany; no unique constraint.',
    'TrustedAdult.disclosedById': 'repointed (RESTRICT) — step 5 updateMany.',
    'TrustedAdult.trustedAdultPersonId': 'repointed (SET NULL) — step 5 updateMany.',
    'TrustedAdultReview.decidedById': 'repointed (SET NULL) — which board member decided the review, same audit-fact rationale.',
    'Visit.personId': 'repointed (RESTRICT) — step 3 updateMany. Both-sides-open is pre-refused; the in-tx guard that leaves a tombstone open visit in place is defense-in-depth for a TOCTOU race, and the nightly/scan-service force-checkout sweeps drain it.',

    // ── deduped: bare joins, where a duplicate carries no extra decision ──────
    'CorporationLead.personId': 'deduped (RESTRICT) — bare join, the duplicate is deleted.',
    'CorporationMember.personId': 'deduped (RESTRICT) — bare join, the duplicate is deleted.',
    'PersonRole.personId': 'deduped (CASCADE) — PK is (personId, role). Moved unless the survivor already holds that role, in which case the duplicate goes: the survivor already has the grant. Never left on the tombstone, because CASCADE would later destroy a security grant with no audit row (#1456 Decision 4). Person\'s legacy role mirrors are rewritten from an IN-TX read of the survivor\'s final rows, since moving rows directly bypasses applyRoleFlag\'s dual-write and an unconditional four-flag overwrite must not be sourced from a pre-tx snapshot. CAVEAT: which rows to move is still decided from that snapshot, so a grant landing mid-merge stays on the tombstone — the roles surface should refuse tombstone targets, filed as an epic follow-up.',
    'ProgramVolunteer.personId': 'deduped (RESTRICT) — bare join, the duplicate is deleted.',
    'RSVP.personId': 'repointed/deduped/pre-refused (RESTRICT) — moved when only one side has it; a past-event duplicate is deleted; a FUTURE-event duplicate is pre-refused, because which answer is real is a human call.',

    // ── pre-refused: a collision here is a decision the merge must not make ───
    'ProgramParticipant.personId': 'pre-refused (RESTRICT) — a shared enrollment carries a seat and a payment. Refused before the transaction; the in-tx `left` branch is defense-in-depth for a race.',
    'ToolStatus.personId': 'pre-refused (RESTRICT) — two certification levels for one human is a decision an operator makes, not a merge.',

    // ── deliberately left ─────────────────────────────────────────────────────
    'Person.mergedIntoId': 'deliberately-left (SET NULL) — the tombstone pointer itself, written BY the merge (step 1 CAS). Rows already pointing at the merged-away record are NOT re-pointed at the survivor: the chain is walked at read time (MAX_MERGE_HOPS), so A→B→C stays a two-hop chain and each merge keeps its own provenance.',
    'Session.userId': 'deliberately-left (CASCADE) — deleted, not moved. The one deliberate exception to the no-deletion rule: a session is an auth artifact, and there is no reason for the survivor to inherit the tombstone\'s login.',
};

describe('merge repoint drift guard', () => {
    const keys = personForeignKeys();

    // An empty/short parse would make both assertions below pass vacuously, so
    // the schema read is asserted rather than trusted (same reason
    // livePersonDriftGuard asserts its relation-name parse).
    it('derives the Person foreign keys from the schema', () => {
        expect(keys).toEqual(expect.arrayContaining([
            'PersonRole.personId', 'RawBadgeLog.personId', 'BackgroundCheckAttestation.subjectPersonId',
        ]));
        expect(keys.length).toBeGreaterThanOrEqual(22);
    });

    it('every Person foreign key has a merge disposition', () => {
        // A new one of these must be handled in merge/route.ts and recorded above.
        // "It does not need handling" is itself a disposition — write it down as
        // deliberately-left with the reason, so the next reader inherits it.
        expect(keys.filter((k) => !(k in DISPOSITIONS))).toEqual([]);
    });

    it('has no stale disposition (a listed FK the schema no longer has)', () => {
        const live = new Set(keys);
        expect(Object.keys(DISPOSITIONS).filter((k) => !live.has(k)).sort()).toEqual([]);
    });
});
