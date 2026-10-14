/**
 * @jest-environment node
 *
 * The Shopify mirror's classification map (generated/shopify-read-classifications.ts)
 * is generated from packages/s-ingest-core/prisma/schema.prisma, which s-read changes.
 * No build step regenerates and diffs it, so this test does: it runs the security
 * generator on a copy of that schema into a temp file and requires the committed map
 * to match. A stale map would strip mirror fields at their old tiers.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../../..');
const SCHEMA = path.join(REPO, 'packages/s-ingest-core/prisma/schema.prisma');
const GENERATOR = path.join(REPO, 'checkin-app/scripts/security-generator.js');
const COMMITTED = path.join(REPO, 'checkin-app/src/security/generated/shopify-read-classifications.ts');

it('the committed mirror classification map matches the s-ingest-core schema', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopify-read-cls-'));
    try {
        const out = path.join(tmp, 'classifications.ts');
        const schema = fs.readFileSync(SCHEMA, 'utf8');
        const security = /generator security \{[^}]*\}/.exec(schema);
        expect(security).not.toBeNull();
        // Same generator, pointed at absolute paths so the copy runs from the temp dir.
        const retargeted = schema.replace(
            security![0],
            `generator security {\n  provider = "node ${GENERATOR}"\n  output   = "${out}"\n}`,
        );
        fs.writeFileSync(path.join(tmp, 'schema.prisma'), retargeted);

        execFileSync(
            process.execPath,
            [require.resolve('prisma/build/index.js'), 'generate', '--schema', 'schema.prisma', '--generator', 'security'],
            { cwd: tmp, stdio: 'pipe' },
        );

        expect(fs.readFileSync(out, 'utf8')).toBe(fs.readFileSync(COMMITTED, 'utf8'));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}, 60_000);
