import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Every red notification stays up until the reader dismisses it: an error chip that
 * closes itself is gone before anyone can read or copy it. A text scan of the app
 * and every `packages/*` library for `notifications.show(...)` calls that use the
 * colour red without `autoClose: false`.
 *
 * Blind spots: a colour or options object held in a variable, or a wrapper that
 * calls `notifications.show` with a colour it was passed, escapes the scan.
 */

const REPO = join(__dirname, '..', '..', '..');
const ROOTS = [join(REPO, 'checkin-app', 'src'), join(REPO, 'packages')];

/** Files an open PR is already fixing, with the PR that does it. */
const ALLOWLIST: Record<string, string> = {
    'packages/expense/src/components/api.ts': 'Fixed in #2543 (finance review queue).',
};

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'generated', '__tests__'].includes(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
}

/** The argument text of each `notifications.show(` call, with its line number. */
function showCalls(src: string): { line: number; arg: string }[] {
    const calls: { line: number; arg: string }[] = [];
    const open = 'notifications.show(';
    for (let i = src.indexOf(open); i !== -1; i = src.indexOf(open, i + 1)) {
        let j = i + open.length;
        for (let depth = 1; depth > 0 && j < src.length; j++) {
            if (src[j] === '(') depth++;
            else if (src[j] === ')') depth--;
        }
        calls.push({ line: src.slice(0, i).split('\n').length, arg: src.slice(i + open.length, j - 1) });
    }
    return calls;
}

const isRed = (arg: string) => /color:[^,}]*["']red["']/.test(arg);
const staysUp = (arg: string) => /autoClose:[^,}]*\bfalse\b/.test(arg);

describe('error notifications stay up', () => {
    it('finds the notification calls it scans', () => {
        const total = ROOTS.flatMap((r) => walk(r)).reduce(
            (n, f) => n + showCalls(readFileSync(f, 'utf8')).length,
            0,
        );
        expect(total).toBeGreaterThan(100);
    });

    it('every red notification sets autoClose: false', () => {
        const violations: string[] = [];
        for (const file of ROOTS.flatMap((r) => walk(r))) {
            const rel = relative(REPO, file).split(sep).join('/');
            if (ALLOWLIST[rel]) continue;
            for (const { line, arg } of showCalls(readFileSync(file, 'utf8'))) {
                if (isRed(arg) && !staysUp(arg)) violations.push(`${rel}:${line}`);
            }
        }
        expect(violations).toEqual([]);
    });
});
