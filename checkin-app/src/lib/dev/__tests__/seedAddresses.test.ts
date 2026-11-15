/**
 * @jest-environment node
 */
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.join(__dirname, "../../../..");
const SEED_SOURCES = ["prisma/seed.ts", "prisma/seed_20_users.ts", "src/lib/dev/seed-helpers.ts"];
// Domains reserved for examples and tests (RFC 2606, RFC 6761): mail to them never reaches a person.
const RESERVED = /@([a-z0-9-]+\.)*(example\.(com|org|net)|invalid|test)$/i;

describe("seed email addresses", () => {
    it.each(SEED_SOURCES)("%s uses only reserved example domains", (file) => {
        const source = readFileSync(path.join(ROOT, file), "utf8");
        const addresses = source.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
        expect(addresses.filter((a) => !RESERVED.test(a))).toEqual([]);
    });

    it("seeds a placeholder alert address", () => {
        const source = readFileSync(path.join(ROOT, "src/lib/dev/seed-helpers.ts"), "utf8");
        expect(source).toMatch(/alertEmailAddress: "[^"]+@example\.com"/);
    });
});
