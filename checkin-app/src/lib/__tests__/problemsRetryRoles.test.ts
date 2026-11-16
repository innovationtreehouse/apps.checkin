import { readFileSync } from "fs";
import path from "path";
import { mayRetry } from "@/lib/problemsRetryRoles";

const SYSADMIN = { isSysadmin: true };

/** The QuickBooks step names each library declares in its stuckItems port. */
function quickBooksSteps(pkg: string): string[] {
    const src = readFileSync(path.join(__dirname, "../../../../packages", pkg, "src/stuckItems.ts"), "utf8");
    return [...src.matchAll(/const QB_\w+ = "([^"]+)"/g)].map((m) => m[1]);
}

describe("mayRetry", () => {
    it.each([
        ["expense", "expense", 2],
        ["gifts", "bulk-donation", 1],
    ])("keeps every QuickBooks step the %s library declares from a sysadmin", (library, pkg, count) => {
        const steps = quickBooksSteps(pkg);
        expect(steps).toHaveLength(count);
        for (const step of steps) {
            expect(mayRetry(SYSADMIN, { library, step })).toBe(false);
            expect(mayRetry({ isBoardMember: true }, { library, step })).toBe(true);
        }
    });

    it("lets a sysadmin retry a step that does not post to QuickBooks", () => {
        expect(mayRetry(SYSADMIN, { library: "expense", step: "intake" })).toBe(true);
    });

    it("refuses a viewer with neither role", () => {
        expect(mayRetry({}, { library: "receipt", step: "flow" })).toBe(false);
        expect(mayRetry(null, { library: "receipt", step: "flow" })).toBe(false);
    });
});
