/** @jest-environment node */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Fails on a reader of the copy of QuickBooks' lists that could offer an inactive entry
 * (docs/rules/revenue.md): every file that loads either list route filters on `.active`
 * and shows a stored inactive pick with InactivePickWarning.
 *
 * ponytail: text match on the route paths. A reader that builds the path from parts, or
 * filters in a helper in another file, slips; parse the call sites if that ever happens.
 */
const LIST_ROUTES = ['/api/books-map/quickbooks-accounts', '/api/budget-owners/quickbooks-classes'];

const readsList = (source: string) => LIST_ROUTES.some((route) => source.includes(route));
const bypassesActiveFilter = (source: string) => readsList(source) && !(/\.active\b/.test(source) && source.includes('<InactivePickWarning'));

const repo = join(__dirname, '../../../../..');

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (['__tests__', 'node_modules', 'generated', 'api', 'security'].includes(entry.name)) return [];
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

const readers = () =>
    [join(repo, 'checkin-app/src'), ...readdirSync(join(repo, 'packages')).map((p) => join(repo, 'packages', p, 'src'))]
        .flatMap((dir) => { try { return sourceFiles(dir); } catch { return []; } })
        .filter((path) => readsList(readFileSync(path, 'utf8')));

describe('readers of the QuickBooks list routes', () => {
    it('flags a planted reader that lists every entry', () => {
        expect(bypassesActiveFilter('const live = useLoad("/api/books-map/quickbooks-accounts"); const options = live.data.map((a) => a.id);')).toBe(true);
        expect(bypassesActiveFilter('api("/api/budget-owners/quickbooks-classes").then((c) => c.filter((o) => o.active));')).toBe(true);
    });

    it('passes a reader that filters on active and warns on a stored inactive pick', () => {
        expect(bypassesActiveFilter('useLoad("/api/books-map/quickbooks-accounts"); live.filter((a) => a.active); <InactivePickWarning saved={id} options={live} />')).toBe(false);
    });

    it('finds the pickers, and none of them bypasses the active filter', () => {
        const found = readers();
        expect(found.length).toBeGreaterThanOrEqual(8);
        expect(found.filter((path) => bypassesActiveFilter(readFileSync(path, 'utf8'))).map((path) => relative(repo, path))).toEqual([]);
    });
});
