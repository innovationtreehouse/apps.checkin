import { describe, it, expect } from "vitest";
import { FIXTURE_MANIFEST, loadRaw, type Seam } from "./index";

/**
 * Corpus guard (Phase P0). Every seam fixture must validate against the shared
 * contract schema it claims, and every seam must keep a minimum set of branch
 * fixtures. This is what makes the corpus trustworthy: if a contract schema
 * changes in a way that orphans a fixture, this test fails loudly — before any
 * producer/consumer test built on the fixture can silently rot.
 */

describe("contract fixture corpus", () => {
  it("discovers fixtures for every seam", () => {
    expect(FIXTURE_MANIFEST.length).toBeGreaterThanOrEqual(16);
  });

  describe("every fixture validates against its seam schema", () => {
    for (const entry of FIXTURE_MANIFEST) {
      it(entry.id, () => {
        const raw = loadRaw(entry);
        const result = entry.schema.safeParse(raw);
        if (!result.success) {
          throw new Error(`${entry.id} failed schema validation:\n${JSON.stringify(result.error.issues, null, 2)}`);
        }
        expect(result.success).toBe(true);
      });
    }
  });

  it("re-serializing a fixture is byte-stable (no hidden non-JSON values)", () => {
    for (const entry of FIXTURE_MANIFEST) {
      const raw = loadRaw(entry);
      expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
    }
  });

  describe("branch coverage — each seam keeps its required variants", () => {
    const required: Record<Seam, string[]> = {
      "S1-completed-receipt": [
        "single-item-recognized",
        "multi-item-mixed-gtin",
        "with-tax-shipping-discount",
        "reimbursement-flagged",
        "non-inventory-present",
      ],
      "S2-expense-receipt": ["all-recognized-gtin", "has-provisional"],
      "S3-inventory-delta": ["recognized-only", "with-provisional"],
      "S4-catalog-submissions": ["item-reference-proposal", "reference-conflict", "items-lookup"],
      "S5-org-events": [
        "provisional-approved",
        "provisional-rejected",
        "provisional-mapped-to-existing",
        "item-reference-proposal-approved",
      ],
    };

    for (const [seam, names] of Object.entries(required) as [Seam, string[]][]) {
      it(`${seam} has all required branch fixtures`, () => {
        const present = FIXTURE_MANIFEST.filter((e) => e.seam === seam).map((e) => e.id.split("/")[1]);
        for (const name of names) expect(present).toContain(name);
      });
    }
  });
});
