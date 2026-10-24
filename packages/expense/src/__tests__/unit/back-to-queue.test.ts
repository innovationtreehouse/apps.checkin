/** Whether an expense line still waits on the viewer after a decision, pure — no database. */
import { describe, it, expect } from "vitest";
import { lineWaitsOnViewer } from "../../lib/backToQueue";

const line = (...primary: boolean[]) => ({ actions: primary.map((p) => ({ primary: p })) });

describe("lineWaitsOnViewer", () => {
  it("is true while some line has a main act for the viewer", () => {
    expect(lineWaitsOnViewer([line(), line(true, false)])).toBe(true);
  });

  it("is false when the viewer's only acts are under More, or there are none", () => {
    expect(lineWaitsOnViewer([line(false), line()])).toBe(false);
    expect(lineWaitsOnViewer([])).toBe(false);
  });
});
