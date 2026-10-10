/**
 * @jest-environment node
 */
import { ApiResponseError } from "@/security/handler";
import { accessOf, mapServiceErrors, OCR_DAILY_LIMIT, readCapped, spendOcrQuota } from "@/lib/receipt/route";

/** A ServiceError from another loaded copy of the library: same name and shape, different class. */
class ForeignServiceError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

describe("mapServiceErrors", () => {
  it("maps a ServiceError by name and status, whatever copy of the class threw it", async () => {
    const err = await mapServiceErrors(() => Promise.reject(new ForeignServiceError(409, "conflict"))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).toMatchObject({ status: 409, message: "conflict" });
  });

  it("leaves any other error to become an opaque 500", async () => {
    const plain = new Error("boom");
    await expect(mapServiceErrors(() => Promise.reject(plain))).rejects.toBe(plain);
    const noStatus = Object.assign(new Error("odd"), { name: "ServiceError", statusCode: "409" });
    await expect(mapServiceErrors(() => Promise.reject(noStatus))).rejects.toBe(noStatus);
  });
});

describe("accessOf", () => {
  it("acts org-wide only for the finance and board views", () => {
    expect(accessOf("isFinance")).toBe("finance");
    expect(accessOf("isBoardMember")).toBe("finance");
    expect(accessOf("authenticated")).toBe("submitter");
    expect(accessOf("isSysadmin")).toBe("submitter");
  });
});

describe("readCapped", () => {
  const CAP = 1000;
  const CHUNK = new Uint8Array(100);

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
    const chunks = await readCapped(body(), "200", CAP);
    expect(chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(200);
  });

  it("refuses an over-cap Content-Length before reading the body", async () => {
    const { state, body } = endless();
    await expect(readCapped(body, String(CAP + 1), CAP)).rejects.toMatchObject({ status: 413 });
    expect(state.read).toBe(0);
  });

  it("stops reading once a body without a length passes the cap", async () => {
    const { state, body } = endless();
    await expect(readCapped(body, null, CAP)).rejects.toMatchObject({ status: 413 });
    expect(state.read).toBe(CAP + CHUNK.byteLength);
  });
});

describe("spendOcrQuota", () => {
  it("allows a person OCR_DAILY_LIMIT reads a day, then answers 429; others are unaffected", () => {
    const person = 424242;
    for (let i = 0; i < OCR_DAILY_LIMIT; i++) expect(() => spendOcrQuota(person)).not.toThrow();
    expect(() => spendOcrQuota(person)).toThrow(expect.objectContaining({ status: 429 }));
    expect(() => spendOcrQuota(person + 1)).not.toThrow();
  });
});
