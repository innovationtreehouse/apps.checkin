/**
 * Generator CLI for the lifecycle review artifacts.
 * Renders every machine in machineSpecs.ts and writes `<name>.md` under
 * docs/generated/lifecycle/. Run it after editing any machine's `TRANSITIONS`:
 *
 *   npm run generate:lifecycle-artifacts
 *
 * The drift test (artifactsDrift.test.ts) regenerates in memory and fails CI if
 * the checked-in files are stale, so this must be re-run whenever a transition
 * changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderMachineArtifact } from './artifacts';
import { MACHINES } from './machineSpecs';

/** Repo-relative output dir, resolved from this file (src/lib/lifecycle/). */
export const OUTPUT_DIR = join(__dirname, '..', '..', '..', 'docs', 'generated', 'lifecycle');

function main(): void {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    for (const spec of MACHINES) {
        const path = join(OUTPUT_DIR, `${spec.name}.md`);
        writeFileSync(path, renderMachineArtifact(spec), 'utf8');
        console.log(`wrote ${path}`);
    }
}

// Only write when run directly (npm run generate:lifecycle-artifacts); importing
// this module (e.g. from the drift test, to reuse OUTPUT_DIR) has no side effect.
if (require.main === module) main();
