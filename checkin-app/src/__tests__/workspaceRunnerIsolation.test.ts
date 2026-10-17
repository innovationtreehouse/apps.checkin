import { isAbsolute, relative, resolve, sep } from 'node:path';
import { customJestConfig as rawJestConfig } from '../../jest.config';

/**
 * Guards the runner boundary from issue #228: checkin-app runs on Jest, every
 * `packages/*` and `*-function` workspace runs on Vitest, and a Vitest
 * `.test.ts` must never be swept into this Jest run. The only levers that widen
 * Jest's collection scope are `rootDir` and `roots`, so this asserts against the
 * RESOLVED config: neither escapes `checkin-app/`. next/jest leaves both unset,
 * so Jest defaults `rootDir` to the config's own directory (checkin-app) and
 * `roots` to `[rootDir]` — inside by construction. Setting either to reach a
 * sibling workspace (`rootDir: '..'`, `roots: ['<rootDir>/../packages']`) is
 * exactly how a Vitest suite would leak in, and it fails here.
 */

type JestCollectionConfig = { rootDir?: string; roots?: string[] };
const customJestConfig = rawJestConfig as JestCollectionConfig;

const appDir = resolve(__dirname, '..', '..'); // checkin-app/, where jest.config.js lives

const toAbsolute = (p: string, base: string): string => {
    const substituted = p.replace(/<rootDir>/g, base);
    return isAbsolute(substituted) ? substituted : resolve(base, substituted);
};

const isInsideAppDir = (abs: string): boolean => {
    const rel = relative(appDir, abs);
    return rel === '' || (!rel.startsWith('..' + sep) && !isAbsolute(rel));
};

describe('runner boundary (app=Jest, packages/functions=Vitest)', () => {
    it('confines Jest collection to checkin-app/', () => {
        const cfg = customJestConfig;

        // Unset rootDir => Jest defaults it to the config's directory (checkin-app).
        const effectiveRootDir = cfg.rootDir === undefined ? appDir : toAbsolute(cfg.rootDir, appDir);
        expect(isInsideAppDir(effectiveRootDir)).toBe(true);

        // Unset roots => Jest defaults to [rootDir]; any explicit root must stay within it.
        const roots = cfg.roots ?? [effectiveRootDir];
        const escaping = roots.filter((r) => !isInsideAppDir(toAbsolute(r, effectiveRootDir)));
        expect(escaping).toEqual([]);
    });
});
