import { describe, it, expect } from "vitest";
import { CROSSINGS, editTargetsExist, loadRefusalsFile, refusals } from "./index";

describe("refusals fixtures", () => {
  for (const crossing of CROSSINGS) {
    describe(crossing, () => {
      const file = loadRefusalsFile(crossing);
      const { base } = refusals(crossing, { orgId: "org-1" });

      it("names its own crossing", () => expect(file.crossing).toBe(crossing));

      it("keeps an accepted case and one that is not accepted", () => {
        expect(file.cases.some((c) => c.expect === "accepted")).toBe(true);
        expect(file.cases.some((c) => c.expect !== "accepted")).toBe(true);
      });

      it("gives every case a distinct name", () => {
        const names = file.cases.map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
      });

      it.each(file.cases.map((c) => [c.name, c] as const))("edits only fields the base has: %s", (_name, c) => {
        expect(editTargetsExist(base, c)).toBe(true);
      });
    });
  }
});
