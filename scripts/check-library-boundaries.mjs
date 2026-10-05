#!/usr/bin/env node
// Library boundary check (docs: INVENTORY_PARALLEL_PORT_PLAN "Library boundaries").
// A package is a library iff its package.json has "library": true. A library's
// src/**/*.{ts,tsx} and its dependencies/devDependencies may not name
// checkin-app, `@/…`, another library, or (imports only) a relative path that
// escapes the package. Rule 3 (public surface = `exports`) needs no check here:
// module resolution already refuses any subpath a package does not export.
// A library also reaches a database only through its own Prisma client: no raw
// SQL client in src/ (the driver adapter only in its db-client file), and every
// DB env var it reads, in src/, prisma/ or prisma.config*.ts, is its own
// <NAME>_DATABASE_URL. Its schema may not redeclare a checkin-app model.
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

const checkinModels = new Set(
  [...readFileSync(join(root, 'checkin-app/prisma/schema.prisma'), 'utf8').matchAll(/^\s*(?:model|enum|view|type)\s+(\w+)/gm)].map((m) => m[1]),
);

// Raw clients would let a library read the Shopify mirror or a sibling library's
// database around its Prisma client.
const RAW_SQL = /^(pg|pg-.+|postgres|@neondatabase\/.+|@vercel\/postgres|mysql2?|knex|kysely|slonik|sqlite3|better-sqlite3|@prisma\/adapter-.+)$/;
const DB_CLIENT_FILE = /^src\/(lib\/)?db\/index\.ts$/;
// global-catalog's deployed DB env var is CATALOG_DATABASE_URL, not GLOBAL_CATALOG_….
const DB_ENV_NAME = { '@inventory/global-catalog': 'catalog' };
const ownDbEnv = (name) =>
  `${(DB_ENV_NAME[name] ?? name.replace(/^@[^/]+\//, '')).toUpperCase().replace(/-/g, '_')}_DATABASE_URL`;
// ponytail: matches process.env.X, process.env['X'] and env('X') reads of a name
// containing DATABASE/POSTGRES or starting PG; a URL under any other name slips.
const ENV_READ = /(?:process\.env\.|process\.env\[\s*['"]|\benv\(\s*['"])([A-Z][A-Z0-9_]*)/g;
const DB_ENV = /DATABASE|POSTGRES|^PG/;

const isPkg = (spec, name) => spec === name || spec.startsWith(`${name}/`);

function forbidden(spec, self) {
  if (isPkg(spec, 'checkin-app')) return 'checkin-app';
  if (spec.startsWith('@/')) return 'checkin-app alias';
  for (const lib of libraryNames) if (lib !== self && isPkg(spec, lib)) return 'another library';
  return null;
}

function* files(dir, re) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p, re);
    else if (re.test(e.name)) yield p;
  }
}
const packageName = (spec) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

// ponytail: line regex, not a TS parser. Catches `from '…'`, `import '…'` and
// `import('…')`/`require('…')` on one line; misses a specifier split across lines or a
// computed dynamic import. Upgrade to ts.preProcessFile if that ever bites.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"]+)\1/g;

const violations = [];
for (const { dir, json } of pkgs.filter((p) => p.json.library === true)) {
  for (const field of ['dependencies', 'devDependencies']) {
    for (const dep of Object.keys(json[field] ?? {})) {
      const why = forbidden(dep, json.name);
      if (why) violations.push(`${relative(root, join(dir, 'package.json'))} ${field}.${dep} (${why})`);
    }
  }
  const ownEnv = ownDbEnv(json.name);
  const scanned = [
    ...files(join(dir, 'src'), /\.tsx?$/),
    ...files(join(dir, 'prisma'), /\.prisma$/),
    ...readdirSync(dir).filter((f) => /^prisma\.config.*\.ts$/.test(f)).map((f) => join(dir, f)),
  ];
  for (const file of scanned) {
    const rel = relative(dir, file).split(sep).join('/');
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const at = `${relative(root, file)}:${i + 1}`;
      if (rel.startsWith('src/')) {
        for (const [, , spec] of line.matchAll(SPEC)) {
          let why = forbidden(spec, json.name);
          if (!why && spec.startsWith('.')) {
            const target = resolve(dirname(file), spec);
            if (target !== dir && !target.startsWith(dir + sep)) why = 'escapes package';
          }
          const pkg = packageName(spec);
          if (!why && RAW_SQL.test(pkg) && !(pkg === '@prisma/adapter-pg' && DB_CLIENT_FILE.test(rel))) {
            why = 'raw SQL client; only src/db/index.ts or src/lib/db/index.ts may import @prisma/adapter-pg';
          }
          if (why) violations.push(`${at} ${spec} (${why})`);
        }
      }
      for (const [, name] of line.matchAll(ENV_READ)) {
        if (DB_ENV.test(name) && name !== ownEnv) violations.push(`${at} ${name} (DB env var other than ${ownEnv})`);
      }
      const model = rel.endsWith('.prisma') && line.match(/^\s*(?:model|enum|view|type)\s+(\w+)/);
      if (model && checkinModels.has(model[1])) violations.push(`${at} ${model[1]} (redeclares a checkin-app model)`);
    });
  }
}

if (violations.length) {
  console.error(`Library boundary violations (${violations.length}):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`Library boundaries OK: ${[...libraryNames].join(', ') || '(no libraries)'}`);
