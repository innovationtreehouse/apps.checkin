import { describe, it, expect } from "vitest";
import { proposalSupersedes } from "../../services/proposalService";

type P = Parameters<typeof proposalSupersedes>[0];

const base = (overrides: Partial<P> = {}): P => ({
  partNumber: null,
  manufacturer: null,
  retailer: null,
  description: null,
  ...overrides,
});

// ── partNumber + manufacturer + retailer (all three) ──────────────────────────

describe("approved has partNumber + manufacturer + retailer", () => {
  const approved = base({ partNumber: "PN1", manufacturer: "MFR1", retailer: "RTL1" });

  it("supersedes candidate with same partNumber+manufacturer (retailer differs)", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN1", manufacturer: "MFR1", retailer: "RTL2" }))).toBe(true);
  });

  it("supersedes candidate with same partNumber+manufacturer (null retailer)", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN1", manufacturer: "MFR1", retailer: null }))).toBe(true);
  });

  it("supersedes candidate with same partNumber+retailer and null manufacturer", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN1", retailer: "RTL1", manufacturer: null }))).toBe(true);
  });

  it("does NOT supersede candidate with same partNumber+retailer but non-null manufacturer", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN1", retailer: "RTL1", manufacturer: "OTHER" }))).toBe(false);
  });

  it("does NOT supersede candidate with different partNumber", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN2", manufacturer: "MFR1", retailer: "RTL1" }))).toBe(false);
  });

  it("does NOT supersede unrelated candidate", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN9", manufacturer: "MFR9" }))).toBe(false);
  });
});

// ── partNumber + manufacturer only ────────────────────────────────────────────

describe("approved has partNumber + manufacturer (no retailer)", () => {
  const approved = base({ partNumber: "PN1", manufacturer: "MFR1" });

  it("supersedes candidate with same partNumber+manufacturer", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN1", manufacturer: "MFR1" }))).toBe(true);
  });

  it("does NOT supersede candidate with same partNumber but different manufacturer", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN1", manufacturer: "MFR2" }))).toBe(false);
  });

  it("does NOT supersede candidate with same partNumber only (null manufacturer)", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN1", manufacturer: null }))).toBe(false);
  });
});

// ── partNumber + retailer only ────────────────────────────────────────────────

describe("approved has partNumber + retailer (no manufacturer)", () => {
  const approved = base({ partNumber: "PN1", retailer: "RTL1" });

  it("supersedes candidate with same partNumber+retailer", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN1", retailer: "RTL1" }))).toBe(true);
  });

  it("does NOT supersede candidate with different retailer", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN1", retailer: "RTL2" }))).toBe(false);
  });
});

// ── description + manufacturer (independent axis) ─────────────────────────────

describe("description + manufacturer match (independent of partNumber rules)", () => {
  const approved = base({ description: "Widget A", manufacturer: "MFR1" });

  it("supersedes candidate with same description+manufacturer", () => {
    expect(proposalSupersedes(approved, base({ description: "Widget A", manufacturer: "MFR1" }))).toBe(true);
  });

  it("does NOT supersede candidate with same description but different manufacturer", () => {
    expect(proposalSupersedes(approved, base({ description: "Widget A", manufacturer: "MFR2" }))).toBe(false);
  });

  it("does NOT supersede candidate with same manufacturer but different description", () => {
    expect(proposalSupersedes(approved, base({ description: "Widget B", manufacturer: "MFR1" }))).toBe(false);
  });
});

// ── description+manufacturer fires even when partNumber rules also apply ───────

describe("both partNumber and description+manufacturer rules active", () => {
  const approved = base({ partNumber: "PN1", manufacturer: "MFR1", description: "Widget A" });

  it("supersedes via partNumber+manufacturer match", () => {
    expect(proposalSupersedes(approved, base({ partNumber: "PN1", manufacturer: "MFR1" }))).toBe(true);
  });

  it("supersedes via description+manufacturer match independently", () => {
    expect(proposalSupersedes(approved, base({ description: "Widget A", manufacturer: "MFR1" }))).toBe(true);
  });
});

// ── no criteria → never supersedes ───────────────────────────────────────────

describe("approved has no matching criteria", () => {
  it("returns false when approved has partNumber only", () => {
    expect(proposalSupersedes(base({ partNumber: "PN1" }), base({ partNumber: "PN1" }))).toBe(false);
  });

  it("returns false when approved has no fields", () => {
    expect(proposalSupersedes(base(), base())).toBe(false);
  });
});
