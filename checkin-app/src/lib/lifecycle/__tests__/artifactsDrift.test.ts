/**
 * Drift guard for the generated lifecycle artifacts.
 *
 * Regenerates every machine's artifact in memory from its `TRANSITIONS` and
 * asserts byte-equality with the checked-in `docs/generated/lifecycle/<name>.md`.
 * Editing a machine's transitions without re-running
 * `npm run generate:lifecycle-artifacts` fails here — so every machine-touching
 * PR carries the diagram/matrix diff, and the picture can't rot.
 *
 * Pure unit test: no DB, no Prisma value import (the machine modules are
 * client-safe). Mirrors the pageRegistry / authzRegistry drift-guard pattern.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderMachineArtifact } from '../artifacts';
import { MACHINES } from '../machineSpecs';
import { OUTPUT_DIR } from '../generate';

describe('lifecycle artifact drift guard', () => {
    it.each(MACHINES.map((m) => [m.name, m] as const))(
        '%s.md matches the machine’s TRANSITIONS (regenerate: npm run generate:lifecycle-artifacts)',
        (name, spec) => {
            const expected = renderMachineArtifact(spec);
            let actual: string;
            try {
                actual = readFileSync(join(OUTPUT_DIR, `${name}.md`), 'utf8');
            } catch {
                throw new Error(
                    `Missing docs/generated/lifecycle/${name}.md — run npm run generate:lifecycle-artifacts`,
                );
            }
            expect(actual).toBe(expected);
        },
    );

    it('every checked-in artifact corresponds to a registered machine', () => {
        // Guards the reverse direction: a machine removed from machineSpecs.ts
        // without deleting its .md would leave an orphan the drift test above
        // never checks. Listing is cheap; enumerate the dir.
        const present = readdirSync(OUTPUT_DIR)
            .filter((f) => f.endsWith('.md'))
            .map((f) => f.replace(/\.md$/, ''))
            .sort();
        const registered = MACHINES.map((m) => m.name).sort();
        expect(present).toEqual(registered);
    });
});
