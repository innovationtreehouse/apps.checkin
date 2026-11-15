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
});
