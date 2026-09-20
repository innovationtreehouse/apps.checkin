/**
 * @jest-environment node
 */
/**
 * The scope oracles under src/security/__tests__/ are the per-model assertions
 * of what each role may see. Nothing else pins that they exist.
 *
 * security-boundary-isolation.yml deliberately does NOT treat them as boundary
 * files — a decommission has to update its own oracle, and classifying them as
 * boundary made the exception refuse the shape it exists for. That is the right
 * call, and it costs the one mechanical guard those files had: an oracle can now
 * ride along inside an ordinary feature PR, and a deleted test is invisible to a
 * green run. CODEOWNERS still forces a security owner onto the review, but that
 * is a human reading a large diff, which is the failure isolation exists to stop.
 *
 * So the set is pinned here. Adding an oracle costs one line and makes a
 * reviewer see the new file; removing one has to be written down on purpose.
 *
 * This file cannot pin itself — a deleted test cannot fail — so its own
 * existence is asserted by security-boundary-isolation.yml, which runs on every
 * PR into main whether or not the Jest suite does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ORACLE_DIR = path.join(__dirname, '..', '..', 'src', 'security', '__tests__');

// Each entry is a model or route whose visibility nothing else asserts.
const ORACLES = [
    'active-visitors-tombstone.test.ts',
    'emergency-contact-program-scope.test.ts',
    'household-lead-program-scope.test.ts',
    'impersonatedBy-inertness.test.ts',
    'led-households-roster.test.ts',
    'member-tier.test.ts',
    'payment-plans-strip.test.ts',
    'program-participant-pending-since-strip.test.ts',
    'rsvp-program-scope.test.ts',
    'scopeValidators.test.ts',
    'shop-certifications-strip.test.ts',
    'shop-org-members-strip.test.ts',
    'toolstatus-self-scope.test.ts',
    'visit-household-lead-scope.test.ts',
    'visit-program-scope.test.ts',
] as const;

describe('scope oracle set', () => {
    const present = readdirSync(ORACLE_DIR).filter(f => f.endsWith('.test.ts')).sort();

    it('has not lost an oracle', () => {
        // Sorted set equality, so the failure names the missing file rather than
        // a count. A rename reads as one removal plus one addition.
        expect(present).toEqual([...ORACLES].sort());
    });

    // ponytail: presence, not depth — a file gutted to a single assertion still
    // passes. Catches deletion and emptying, which are the invisible edits; a
    // weakened assertion is a diff a reviewer can see. Pin per-oracle assertion
    // counts here if that stops being true.
    it.each(ORACLES)('%s still asserts something', (name) => {
        const src = readFileSync(path.join(ORACLE_DIR, name), 'utf8');
        expect(src).toMatch(/\bexpect\(/);
    });
});
