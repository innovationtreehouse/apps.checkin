import fs from "fs";
import path from "path";

/**
 * Every source file that writes Person.email must call removeAliasesForSignInEmail, so a new
 * writer cannot leave an alias equal to someone's sign-in address.
 */
describe("sign-in email writers", () => {
    const srcRoot = path.join(__dirname, "../../..");
    const PERSON_WRITE = /\.person\.(create|createMany|createManyAndReturn|update|updateMany|upsert)\(/g;

    function sourceFiles(dir: string): string[] {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) return ["__tests__", "generated", "dev"].includes(e.name) ? [] : sourceFiles(full);
            return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
        });
    }

    /** The source of the call opening just before `start`, by balancing parentheses. */
    function callText(src: string, start: number): string {
        let depth = 1;
        let i = start;
        while (i < src.length && depth > 0) {
            if (src[i] === "(") depth++;
            if (src[i] === ")") depth--;
            i++;
        }
        return src.slice(start, i);
    }

    function writesEmail(src: string): boolean {
        if (/\bupdateData\.email\s*=/.test(src)) return true;
        return [...src.matchAll(PERSON_WRITE)].some((m) => {
            const call = callText(src, m.index + m[0].length).replace(/(where|select):\s*\{[^}]*\}/g, "");
            return /(^|[\s{,])email\s*[:,}]|\.\.\.data\b/.test(call);
        });
    }

    const writers = sourceFiles(srcRoot)
        .map((f) => ({ rel: path.relative(srcRoot, f), src: fs.readFileSync(f, "utf8") }))
        .filter(({ src }) => writesEmail(src));

    // The merge moves aliases itself (moveMailAliases). createInOwnHousehold's caller holds the call.
    const OWN_HANDLING = ["lib/person/merge/execute.ts", "lib/person/ownHousehold.ts"];

    it("finds the known writers", () => {
        expect(writers.map((w) => w.rel).sort()).toEqual([
            "app/api/household/member/route.ts",
            "app/api/household/route.ts",
            "app/api/membership-ops/participants/[id]/route.ts",
            "app/api/membership-ops/participants/route.ts",
            "lib/auth-options.ts",
            "lib/membership/intake.ts",
            "lib/person/merge/execute.ts",
            "lib/person/ownHousehold.ts",
        ]);
    });

    it.each(writers.filter((w) => !OWN_HANDLING.includes(w.rel)).map((w) => [w.rel, w.src]))("%s calls removeAliasesForSignInEmail", (_rel, src) => {
        expect(src).toMatch(/\bremoveAliasesForSignInEmail\(/);
    });
});
