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

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'generated', '__tests__'].includes(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
}

/** Index just past the `)` that closes the paren before `from`, skipping strings and
 *  comments so a paren inside them can't unbalance the scan. */
function closingParen(s: string, from: number): number {
    let depth = 1;
    for (let i = from; i < s.length; i++) {
        const c = s[i];
        const d = s[i + 1];
        if (c === '/' && d === '/') {
            i = s.indexOf('\n', i);
            if (i < 0) return s.length;
            continue;
        }
        if (c === '/' && d === '*') {
            i = s.indexOf('*/', i + 2);
            if (i < 0) return s.length;
            i++;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            i++;
            while (i < s.length && s[i] !== c) {
                if (s[i] === '\\') i++;
                i++;
            }
            continue;
        }
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return i + 1;
    }
    return s.length;
}

/** The argument text of each `notifications.show(` call, with its line number. */
function showCalls(src: string): { line: number; arg: string }[] {
    const calls: { line: number; arg: string }[] = [];
    const open = 'notifications.show(';
    for (let i = src.indexOf(open); i !== -1; i = src.indexOf(open, i + 1)) {
        const end = closingParen(src, i + open.length);
        calls.push({ line: src.slice(0, i).split('\n').length, arg: src.slice(i + open.length, end - 1) });
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

    it('reads a whole call when a string or comment in it holds a paren', () => {
        const src = 'notifications.show({ message: "Failed (see log", /* ) */ color: "red" });';
        expect(showCalls(src).map(({ arg }) => isRed(arg) && !staysUp(arg))).toEqual([true]);
    });

    it('every red notification sets autoClose: false', () => {
        const violations: string[] = [];
        for (const file of ROOTS.flatMap((r) => walk(r))) {
            const rel = relative(REPO, file).split(sep).join('/');
            for (const { line, arg } of showCalls(readFileSync(file, 'utf8'))) {
                if (isRed(arg) && !staysUp(arg)) violations.push(`${rel}:${line}`);
            }
        }
        expect(violations).toEqual([]);
    });
});
