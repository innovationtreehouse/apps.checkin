import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `sendTemplated` is the only way app code sends an email: a text scan of
 * `checkin-app/src` for a `sendEmail(` call or a `sendEmail` import outside the
 * transport and the template send door. Test files and `__mocks__` are exempt.
 *
 * Blind spot: a call through a renamed reference that never names `sendEmail`
 * (a namespace import used as `mail["send" + "Email"](...)`) escapes the scan.
 */

const SRC = join(__dirname, "..", "..", "..");
const DOORS = ["lib/email.ts", "lib/email-templates/send.ts"];
const USES_SEND_EMAIL = [/\bsendEmail\s*\(/, /import\s*(type\s*)?\{[^}]*\bsendEmail\b[^}]*\}\s*from/];

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "generated", "__tests__", "__mocks__"].includes(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
}

describe("sendEmail stays behind the template door", () => {
    const files = walk(SRC).map((f) => relative(SRC, f).split("\\").join("/"));

    it("finds both doors", () => {
        expect(files).toEqual(expect.arrayContaining(DOORS));
    });

    it("no other source file calls or imports sendEmail (send through sendTemplated instead)", () => {
        const offenders = files.filter((f) => !DOORS.includes(f) && USES_SEND_EMAIL.some((re) => re.test(readFileSync(join(SRC, f), "utf8"))));
        expect(offenders).toEqual([]);
    });
});
