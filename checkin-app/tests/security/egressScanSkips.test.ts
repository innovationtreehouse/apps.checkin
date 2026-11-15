import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listEgressScanFiles } from "../../scripts/check-route-coverage";
import {
    PACKAGE_SKIP_DIR_RE,
    PACKAGE_SKIP_FILE_RE,
    PACKAGE_SOURCE_FILE_RE,
} from "@/security/egressAllowlist";

// Pins what the package egress scan skips: widening it must change this boundary test too.
describe("package egress scan skip patterns", () => {
    it("keeps the pattern sources", () => {
        expect(PACKAGE_SKIP_DIR_RE.source).toBe("^(node_modules|dist|generated|__tests__|__fixtures__|fixtures|test|tests)$");
        expect(PACKAGE_SOURCE_FILE_RE.source).toBe("\\.(tsx?|[cm]?js)$");
        expect(PACKAGE_SKIP_FILE_RE.source).toBe("\\.(test|spec)\\.(tsx?|[cm]?js)$");
    });

    it("keeps the patterns flag-free", () => {
        expect([PACKAGE_SKIP_DIR_RE, PACKAGE_SOURCE_FILE_RE, PACKAGE_SKIP_FILE_RE].map(re => re.flags)).toEqual(["", "", ""]);
    });

    describe("as the scan applies them", () => {
        let root: string;
        const scan = (...rels: string[]) => {
            for (const rel of rels) {
                fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
                fs.writeFileSync(path.join(root, rel), "");
            }
            return listEgressScanFiles(root).sort();
        };
        beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "egress-skips-")); });
        afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

        it("skips tests and generated dirs but enters src", () => {
            expect(scan("packages/p/tests/a.ts", "packages/p/generated/a.ts", "packages/p/src/a.ts"))
                .toEqual(["packages/p/src/a.ts"]);
        });

        it("reads .ts and .mjs source files", () => {
            expect(scan("packages/p/src/a.ts", "packages/p/src/a.mjs"))
                .toEqual(["packages/p/src/a.mjs", "packages/p/src/a.ts"]);
        });

        it("skips .test.ts and .spec.js files", () => {
            expect(scan("packages/p/src/a.test.ts", "packages/p/src/a.spec.js")).toEqual([]);
        });
    });
});
