#!/usr/bin/env node
// Library boundary check (docs: INVENTORY_PARALLEL_PORT_PLAN "Library boundaries").
// A package is a library iff its package.json has "library": true. A library's
// src/**/*.{ts,tsx} and its dependencies/devDependencies may not name
// checkin-app, `@/…`, another library, or (imports only) a relative path that
// escapes the package. Rule 3 (public surface = `exports`) needs no check here:
// module resolution already refuses any subpath a package does not export.
// Usage: node scripts/check-library-boundaries.mjs [repoRoot]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
const pkgsDir = join(root, 'packages');

const pkgs = readdirSync(pkgsDir)
  .map((d) => join(pkgsDir, d))
  .filter((dir) => existsSync(join(dir, 'package.json')))
  .map((dir) => ({ dir, json: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }));
const libraryNames = new Set(pkgs.filter((p) => p.json.library === true).map((p) => p.json.name));

const isPkg = (spec, name) => spec === name || spec.startsWith(`${name}/`);

function forbidden(spec, self) {
  if (isPkg(spec, 'checkin-app')) return 'checkin-app';
  if (spec.startsWith('@/')) return 'checkin-app alias';
  for (const lib of libraryNames) if (lib !== self && isPkg(spec, lib)) return 'another library';
  return null;
}

function* sourceFiles(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p);
    else if (/\.tsx?$/.test(e.name)) yield p;
  }
}

// ponytail: line regex, not a TS parser. Catches `from '…'`, `import '…'` and
// `import('…')` on one line; misses a specifier split across lines or a
// computed dynamic import. Upgrade to ts.preProcessFile if that ever bites.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\1/g;

const violations = [];
for (const { dir, json } of pkgs.filter((p) => p.json.library === true)) {
  for (const field of ['dependencies', 'devDependencies']) {
    for (const dep of Object.keys(json[field] ?? {})) {
      const why = forbidden(dep, json.name);
      if (why) violations.push(`${relative(root, join(dir, 'package.json'))} ${field}.${dep} (${why})`);
    }
  }
  for (const file of sourceFiles(join(dir, 'src'))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const [, , spec] of line.matchAll(SPEC)) {
        let why = forbidden(spec, json.name);
        if (!why && spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          if (target !== dir && !target.startsWith(dir + sep)) why = 'escapes package';
        }
        if (why) violations.push(`${relative(root, file)}:${i + 1} ${spec} (${why})`);
      }
    });
  }
}

if (violations.length) {
  console.error(`Library boundary violations (${violations.length}):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`Library boundaries OK: ${[...libraryNames].join(', ') || '(no libraries)'}`);
