/**
 * @jest-environment node
 */
import { ApiResponseError } from "@/security/handler";
import { accessOf, mapServiceErrors } from "@/lib/receipt/route";

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
