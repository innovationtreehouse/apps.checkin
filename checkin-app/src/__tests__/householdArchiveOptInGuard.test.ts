import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * withArchivedHouseholds is the one way to see archived households. A session
 * SET elsewhere would stick to a pooled connection and leak them into later
 * requests, so the setting's name may appear nowhere else in source. Migrations
 * are skipped: the policy itself reads the setting there.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..');
const HELPER = ['checkin-app', 'src', 'lib', 'household', 'archived.ts'].join(sep);
const THIS_FILE = relative(REPO_ROOT, __filename);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', 'generated', 'dist', 'docs', 'migrations']);
const SOURCE = /\.(ts|tsx|js|mjs|cjs|sh|py|sql|yml)$/;
const SETTING = 'app.include_archived';

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
        return SOURCE.test(entry.name) ? [path] : [];
    });
}

describe('household archive opt-in guard', () => {
    it('names the setting only in withArchivedHouseholds', () => {
        const offenders = sourceFiles(REPO_ROOT)
            .filter((path) => readFileSync(path, 'utf8').includes(SETTING))
            .map((path) => relative(REPO_ROOT, path))
            .filter((path) => path !== THIS_FILE);

        expect(offenders).toEqual([HELPER]);
    });

    it('sets it only with SET LOCAL', () => {
        const helper = readFileSync(join(REPO_ROOT, HELPER), 'utf8');

        expect(helper.match(/app\.include_archived/g)).toHaveLength(1);
        expect(helper).toContain(`SET LOCAL ${SETTING} = 'on'`);
    });
});
