import { describe, it, expect } from "vitest";
import { normalizeUrl, readCapped } from "./index";

describe("normalizeUrl", () => {
  it("keeps a URL that already has a scheme", () => {
    expect(normalizeUrl("  http://example.com/x ")).toBe("http://example.com/x");
  });

  it("prefixes https:// onto a bare hostname", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
  });

  it("returns null for empty or unparseable input", () => {
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl("http://")).toBeNull();
  });
});

describe("readCapped", () => {
  const CAP = 1000;
  const CHUNK = new Uint8Array(100);
  const tooLarge = () => Object.assign(new Error("too large"), { status: 413 });

  /** An endless body that records how much of it was read. */
  function endless() {
    const state = { read: 0 };
    async function* body() {
      for (;;) {
        state.read += CHUNK.byteLength;
        yield CHUNK;
      }
    }
    return { state, body: body() };
  }

  it("returns a body within the cap", async () => {
    async function* body() {
      yield CHUNK;
      yield CHUNK;
    }
    const chunks = await readCapped(body(), "200", CAP, tooLarge);
    expect(chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(200);
  });

  it("refuses an over-cap Content-Length before reading the body", async () => {
    const { state, body } = endless();
    await expect(readCapped(body, String(CAP + 1), CAP, tooLarge)).rejects.toMatchObject({ status: 413 });
    expect(state.read).toBe(0);
  });

  it("stops reading once a body without a length passes the cap", async () => {
    const { state, body } = endless();
    await expect(readCapped(body, null, CAP, tooLarge)).rejects.toMatchObject({ status: 413 });
    expect(state.read).toBe(CAP + CHUNK.byteLength);
  });
});
