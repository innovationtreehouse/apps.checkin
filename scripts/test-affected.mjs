#!/usr/bin/env node
// DRAFT, NOT ADOPTED: not wired into any package.json script, and --db / --flow
// have never been run. It depends on two changes that are not made yet: the
// PG_TEST_HARNESS=off opt-out in pg-test-harness and the FLOW_ARGS passthrough
// on test:flow:standalone. See the rollout in docs/in-design/PER_LIBRARY_TESTING-migration.md.
//
// Local per-area test runner (docs/in-design/PER_LIBRARY_TESTING.md).
// Maps the files changed against a base ref to areas and runs only the light
// tiers for those areas, serially: tsc, eslint, vitest unit (no DB container),
// and the related checkin jest unit tests. Heavier tiers are opt-in and scoped
// to the area. CI still runs every suite; this never replaces it.
//
// Usage: node scripts/test-affected.mjs [--base <ref>] [--db] [--flow] [--wide] [--dry-run]
//        node scripts/test-affected.mjs --all --yes
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const app = join(root, 'checkin-app');

// Each library's package and the checkin paths that wire it in. `key` names its
// security tests (src/security/__tests__/<key>-*.test.ts, tests/security/<key>Admission.test.ts).
const LIBRARIES = [
  {
    key: 'catalog', pkg: 'packages/global-catalog', flow: 'flow-tests/catalog.flow.test.ts',
    checkin: ['src/lib/catalog/', 'src/lib/catalogNav.ts', 'src/app/catalog/', 'src/app/api/catalog/',
      'src/security/registry/catalog.ts', 'src/security/catalogSyntheticClassifications.ts'],
  },
  {
    key: 'inventory', pkg: 'packages/local-inventory', flow: 'flow-tests/local-inventory.flow.test.ts',
    checkin: ['src/lib/localInventory/', 'src/app/inventory/', 'src/app/api/inventory/',
      'src/security/registry/inventory.ts', 'src/security/inventorySyntheticClassifications.ts'],
  },
  {
    key: 'income', pkg: 'packages/income',
    checkin: ['src/lib/income/', 'src/app/income/', 'src/app/api/income/',
      'src/security/registry/income.ts', 'src/security/incomeSyntheticClassifications.ts'],
  },
  {
    key: 'expense', pkg: 'packages/expense',
    checkin: ['src/lib/expense/', 'src/app/expense/', 'src/app/api/expense/',
      'src/security/registry/expense.ts', 'src/security/expenseSyntheticClassifications.ts'],
  },
  {
    key: 'receipt', pkg: 'packages/receipt',
    checkin: ['src/lib/receipt/', 'src/app/receipts/', 'src/app/api/receipts/',
      'src/security/registry/receipt.ts', 'src/security/receiptSyntheticClassifications.ts'],
  },
  {
    key: 'workflow', pkg: 'packages/workflow-mapping',
    checkin: ['src/lib/workflowMapping/', 'src/app/api/workflow-mapping/',
      'src/security/registry/workflow.ts', 'src/security/workflowSyntheticClassifications.ts'],
  },
  {
    key: 'donation', pkg: 'packages/bulk-donation',
    checkin: ['src/lib/bulkDonation/', 'src/app/donations/', 'src/app/api/donations/',
      'src/security/registry/donation.ts', 'src/security/donationSyntheticClassifications.ts'],
  },
];

// Checkin paths whose change runs the whole security tier.
const SECURITY = [/^src\/security\//, /^src\/middleware\.ts$/, /^prisma\/schema\.prisma$/, /^tests\/security\//];
const SECURITY_TESTS = 'src/security/__tests__/|tests/security/';
// ponytail: fixed caps on related jest files; a core change past them is CI's job unless --wide.
const UNIT_CAP = 80;
const INTEGRATION_CAP = 15;

// ---- args
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const baseIdx = argv.indexOf('--base');
const baseRef = baseIdx >= 0 ? argv[baseIdx + 1] : 'origin/main';
const known = new Set(['--base', '--db', '--flow', '--all', '--yes', '--wide', '--dry-run', baseRef]);
const unknown = argv.filter((a) => !known.has(a));
if (unknown.length) die(`unknown argument(s): ${unknown.join(' ')}`);
const opts = { db: flag('--db'), flow: flag('--flow'), all: flag('--all'), yes: flag('--yes'), wide: flag('--wide'), dry: flag('--dry-run') };

function die(msg) {
  console.error(`test:affected: ${msg}`);
  process.exit(2);
}
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

// ---- --all: the full suites, only on explicit confirmation
if (opts.all) {
  console.log('Plan: npm run test:all (every jest unit test, every package and function vitest incl. DB containers).');
  if (!opts.yes) die('--all runs every suite on this machine. CI already does. Re-run with --all --yes to confirm.');
  if (opts.dry) process.exit(0);
  process.exit(spawnSync('npm', ['run', 'test:all'], { cwd: root, stdio: 'inherit' }).status ?? 1);
}

// ---- changed files: committed since the merge base, plus staged, unstaged and untracked
const mergeBase = git('merge-base', baseRef, 'HEAD')[0];
const changed = [...new Set([...git('diff', '--name-only', mergeBase), ...git('ls-files', '--others', '--exclude-standard')])].sort();

// ---- workspaces and their reverse @inventory/* dependencies
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const workspaces = rootPkg.workspaces.flatMap((glob) => {
  const [parent, pat] = glob.includes('/') ? glob.split('/') : ['.', glob];
  const re = new RegExp(`^${pat.replace('*', '.*')}$`);
  return readdirSync(join(root, parent), { withFileTypes: true })
    .filter((e) => e.isDirectory() && re.test(e.name) && existsSync(join(root, parent, e.name, 'package.json')))
    .map((e) => (parent === '.' ? e.name : `${parent}/${e.name}`));
}).map((dir) => {
  const json = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  return {
    dir, name: json.name, library: json.library === true,
    prodDeps: Object.keys(json.dependencies ?? {}),
    deps: Object.keys({ ...json.dependencies, ...json.devDependencies }),
    vitest: existsSync(join(root, dir, 'vitest.config.ts')),
    tsconfig: existsSync(join(root, dir, 'tsconfig.json')),
  };
});
const byDir = new Map(workspaces.map((w) => [w.dir, w]));
// A dev dependency reaches only its direct consumer's tests; a runtime
// dependency also reaches that consumer's own consumers.
const consumersOf = (name, seen = new Set()) => {
  for (const w of workspaces) {
    if (w.deps.includes(name) && !seen.has(w.dir)) {
      seen.add(w.dir);
      if (w.prodDeps.includes(name)) consumersOf(w.name, seen);
    }
  }
  return seen;
};

// ---- classify
const areas = new Set(); // library keys
const touched = new Set(); // workspace dirs with a direct change
const fanOut = new Set(); // workspace dirs reached through a shared package
const appFiles = []; // changed checkin-app paths, relative to checkin-app/
let security = false;
const reachesApp = new Set(); // changed packages, and their consumers, on a runtime path into checkin-app
const other = [];
for (const file of changed) {
  const ws = workspaces.find((w) => file.startsWith(`${w.dir}/`));
  if (!ws) { other.push(file); continue; }
  touched.add(ws.dir);
  if (ws.dir === 'checkin-app') {
    const rel = file.slice('checkin-app/'.length);
    appFiles.push(rel);
    for (const lib of LIBRARIES) if (lib.checkin.some((p) => rel.startsWith(p))) areas.add(lib.key);
    if (SECURITY.some((re) => re.test(rel))) security = true;
    continue;
  }
  const lib = LIBRARIES.find((l) => l.pkg === ws.dir);
  if (lib) areas.add(lib.key);
  const consumers = consumersOf(ws.name);
  for (const c of consumers) fanOut.add(c);
  if (consumers.has('checkin-app')) for (const d of [ws.dir, ...consumers]) reachesApp.add(d);
}
const libs = LIBRARIES.filter((l) => areas.has(l.key));
const reached = new Set([...touched, ...fanOut]);
const appReached = reached.has('checkin-app');

// ---- jest file lists (checkin-app)
// A library area runs the tests that live under its checkin paths, plus its
// key-named security tests. Related-test discovery runs only for checkin core
// files and for checkin importers of a changed shared package: through the
// registry and nav, a library file is related to most of the app.
const appExists = (rel) => existsSync(join(app, rel));
const inArea = (rel) => LIBRARIES.some((l) => l.checkin.some((p) => rel.startsWith(p)));
const coreFiles = appFiles.filter((f) => appExists(f) && /\.(t|j)sx?$/.test(f) && !inArea(f) && !SECURITY.some((re) => re.test(f)));
const appDeps = byDir.get('checkin-app').deps;
const libraryPkgs = new Set(LIBRARIES.map((l) => byDir.get(l.pkg)?.name));
const importedPkgs = [...reachesApp].map((d) => byDir.get(d).name).filter((n) => appDeps.includes(n) && !libraryPkgs.has(n));
const importers = importedPkgs.length
  ? spawnSync('git', ['grep', '-l', '-E', `from ['"](${importedPkgs.join('|')})(/|['"])`, '--', 'src'], { cwd: app, encoding: 'utf8' })
    .stdout.split('\n').filter(Boolean)
  : [];
const relatedInputs = [...new Set([...coreFiles, ...importers])];
const escape = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namePattern = [
  ...libs.flatMap((l) => l.checkin.map((p) => `/checkin-app/${escape(p)}`)),
  ...libs.map((l) => `src/security/__tests__/${l.key}-|tests/security/${l.key}Admission`),
  ...(security ? [SECURITY_TESTS] : []),
].join('|');

function listTests(script, extra) {
  const out = execFileSync('npm', ['run', '-s', script, '--', '--listTests', ...extra], { cwd: app, encoding: 'utf8', maxBuffer: 1 << 26 });
  return out.split('\n').filter((l) => l.startsWith('/')).map((l) => relative(app, l));
}
function jestList(script) {
  if (!appReached) return [];
  const files = new Set();
  if (relatedInputs.length) for (const f of listTests(script, ['--findRelatedTests', ...relatedInputs])) files.add(f);
  if (namePattern) for (const f of listTests(script, ['--testPathPatterns', namePattern])) files.add(f);
  return [...files].sort();
}

// ---- plan
const steps = [];
const add = (label, cmd, args, cwd, env) => steps.push({ label, cmd, args, cwd, env });
const strippedDbEnv = () => {
  const env = { ...process.env, PG_TEST_HARNESS: 'off' };
  for (const k of Object.keys(env)) if (/DATABASE_URL$/.test(k)) delete env[k];
  return env;
};

// A fresh worktree has no checkin Prisma client (CI generates it before tsc).
if (appReached && !existsSync(join(app, 'src/generated/prisma'))) add('prisma generate checkin-app', 'npx', ['prisma', 'generate'], app);
for (const dir of [...reached].sort()) {
  const w = byDir.get(dir);
  if (w?.tsconfig) add(`tsc ${dir}`, 'npx', ['tsc', '--noEmit', '-p', '.'], join(root, dir));
}
const lintFiles = appFiles.filter(appExists).filter((f) => /\.(t|j)sx?$|\.mjs$/.test(f));
if (lintFiles.length) add('eslint (changed checkin-app files)', 'npx', ['eslint', '--max-warnings', '0', '--no-warn-ignored', ...lintFiles], app);
if (touched.has('packages/pg-test-harness') || [...touched].some((d) => byDir.get(d)?.library)) {
  add('library boundaries', 'node', ['scripts/check-library-boundaries.mjs'], root);
}
for (const dir of [...reached].sort()) {
  if (byDir.get(dir)?.vitest) add(`vitest unit ${dir}`, 'npx', ['vitest', 'run'], join(root, dir), strippedDbEnv());
}

const unit = jestList('test');
let refused = null;
if (unit.length > UNIT_CAP && !opts.wide) {
  refused = `${unit.length} related jest unit files exceed the local cap of ${UNIT_CAP}; that change is CI's to test. Re-run with --wide to run them anyway.`;
} else if (unit.length) {
  add(`jest unit (${unit.length} files)`, 'npm', ['test', '--', '--ci', '--forceExit', '--runTestsByPath', ...unit], app);
}

if (opts.db) {
  for (const l of libs) {
    if (byDir.get(l.pkg)?.vitest) add(`vitest DB tier ${l.pkg} (Docker container)`, 'npx', ['vitest', 'run'], join(root, l.pkg));
  }
  const integ = jestList('test:integration');
  if (integ.length > INTEGRATION_CAP && !opts.wide) {
    refused = [refused, `${integ.length} related integration files exceed the local cap of ${INTEGRATION_CAP}; CI runs them. Re-run with --wide to run them anyway.`].filter(Boolean).join(' ');
  } else if (integ.length) {
    if (!process.env.DATABASE_URL) die('--db needs DATABASE_URL pointing at a running Postgres (the integration tier clones a template DB from it).');
    add(`jest integration (${integ.length} files)`, 'npm', ['run', 'test:integration', '--', '--forceExit', '--runTestsByPath', ...integ], app);
  }
}

if (opts.flow) {
  const flows = libs.map((l) => l.flow).filter(Boolean);
  if (flows.length && process.env.FLOW_BASE_URL) {
    add(`flow ${flows.join(' ')} against ${process.env.FLOW_BASE_URL}`, 'npm', ['run', 'test:flow', '--', '--runTestsByPath', ...flows], app);
  } else if (flows.length) {
    add(`flow ${flows.join(' ')} on the standalone stack (docker compose up, test, down -v)`, 'npm', ['run', 'test:flow:standalone'], app,
      { ...process.env, FLOW_ARGS: `--runTestsByPath ${flows.join(' ')}` });
  }
}

// ---- print, then run serially
console.log(`Base: ${baseRef} (${mergeBase.slice(0, 10)}), ${changed.length} changed file(s)`);
console.log(`Library areas: ${libs.map((l) => l.key).join(', ') || '(none)'}`);
console.log(`Workspaces changed: ${[...touched].sort().join(', ') || '(none)'}`);
console.log(`Fan-out consumers: ${[...fanOut].filter((d) => !touched.has(d)).sort().join(', ') || '(none)'}`);
console.log(`Security tier: ${security ? 'yes' : 'no'}`);
if (other.length) console.log(`Not mapped to a test (docs, CI, deploy, scripts): ${other.length} file(s)`);
if (opts.flow && !libs.some((l) => l.flow)) console.log('--flow: no flow test is mapped to these areas; CI runs the flow suite.');
console.log('\nPlan:');
steps.forEach((s, i) => {
  const args = s.args.length > 12 ? [...s.args.slice(0, 12), `… +${s.args.length - 12} more`] : s.args;
  console.log(`  ${i + 1}. ${s.label}\n     (cd ${relative(root, s.cwd) || '.'} && ${s.cmd} ${args.join(' ')})`);
});
if (!steps.length) console.log('  (nothing to run)');
if (unit.length && unit.length <= UNIT_CAP) console.log(`\njest unit files:\n  ${unit.join('\n  ')}`);
if (refused) console.log(`\nSkipped: ${refused}`);
if (opts.dry) process.exit(refused ? 1 : 0);

const results = [];
const t0 = Date.now();
for (const s of steps) {
  console.log(`\n▶ ${s.label}`);
  const t = Date.now();
  const r = spawnSync(s.cmd, s.args, { cwd: s.cwd, env: s.env ?? process.env, stdio: 'inherit' });
  results.push({ label: s.label, ok: r.status === 0, secs: (Date.now() - t) / 1000 });
}
console.log('\nSummary:');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.secs.toFixed(1)}s  ${r.label}`);
console.log(`  total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (refused) console.log(`  SKIPPED  ${refused}`);
process.exit(results.every((r) => r.ok) && !refused ? 0 : 1);
