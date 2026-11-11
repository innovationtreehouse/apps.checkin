import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Source uses NodeNext-style `.js` import specifiers, but on disk the files are `.ts`.
 * This pre-resolver rewrites a relative `.js` import to its `.ts` sibling when one exists;
 * generated `.js` (the Prisma client) has no sibling and falls through untouched.
 *
 * Plain JS because Node loads it directly: vitest bundles a config's relative imports but
 * leaves package imports external.
 *
 * @returns {import("vite").Plugin}
 */
export function resolveJsToTs() {
  return {
    name: "resolve-js-to-ts",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && source.startsWith(".") && source.endsWith(".js")) {
        const tsPath = resolve(dirname(importer), source.replace(/\.js$/, ".ts"));
        if (existsSync(tsPath)) return tsPath;
      }
      return null;
    },
  };
}
