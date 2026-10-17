#!/usr/bin/env node
// Rewrites the workspace package scope across every tracked file:
//   node scripts/rename-package-scope.mjs <from> <to>   e.g. @inventory @checkin
// Only names of packages that live in packages/* are rewritten (plus the
// `<from>/*` glob), so a mention of a package that only exists elsewhere keeps
// its real name. package-lock.json is left to `npm install`; docs/in-design/
// records the port from the source repo under that repo's names.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';

const [from, to] = process.argv.slice(2);
if (!from?.startsWith('@') || !to?.startsWith('@')) {
  console.error('usage: rename-package-scope.mjs @from @to');
  process.exit(1);
}

const names = readdirSync('packages')
  .filter((d) => existsSync(`packages/${d}/package.json`))
  .map((d) => JSON.parse(readFileSync(`packages/${d}/package.json`, 'utf8')).name)
  .filter((n) => n.startsWith(`${from}/`))
  .map((n) => n.slice(from.length + 1));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest first so `receipt-types` wins over `receipt`; the lookahead stops
// `receipt` matching the front of an unknown `receipt-foo`.
const alt = names.sort((a, b) => b.length - a.length).map(esc).join('|');
const pattern = new RegExp(`${esc(from)}/(?=(?:${alt})(?![\\w-])|\\*)`, 'g');
const prose = new RegExp(`${esc(from)} packages\\b`, 'g');

const skip = (f) => f === 'package-lock.json' || f.startsWith('docs/in-design/') || f === 'scripts/rename-package-scope.mjs';
const files = execFileSync('git', ['grep', '-lI', '-F', from], { encoding: 'utf8' }).split('\n').filter(Boolean);

let changed = 0;
for (const f of files) {
  if (skip(f)) continue;
  const before = readFileSync(f, 'utf8');
  const after = before.replace(pattern, `${to}/`).replace(prose, `${to} packages`);
  if (after !== before) {
    writeFileSync(f, after);
    changed++;
  }
}
console.log(`${changed} files rewritten; packages: ${names.join(', ')}`);
