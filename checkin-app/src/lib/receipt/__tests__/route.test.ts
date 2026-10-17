/**
 * @jest-environment node
 */
import type { NextRequest as NextRequestType } from "next/server";
import { recordReceiptDonorReads } from "@checkin/bulk-donation";
import type { Role } from "@/security/core";
import { ApiResponseError, type HandlerContext } from "@/security/handler";
import { accessOf, mapServiceErrors, readJsonCapped, receiptRoute } from "@/lib/receipt/route";

jest.mock("@checkin/bulk-donation", () => ({ recordReceiptDonorReads: jest.fn() }));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>("next/server");

/** A ServiceError from another loaded copy of the library: same name and shape, different class. */
class ForeignServiceError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

describe("mapServiceErrors", () => {
  it.each([
    [400, "validation"],
    [403, "forbidden"],
    [404, "not found"],
    [409, "conflict"],
  ])("maps a ServiceError(%i) by name and status, whatever copy of the class threw it", async (status, message) => {
    const err = await mapServiceErrors(() => Promise.reject(new ForeignServiceError(status, message))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).toMatchObject({ status, message });
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

describe("readJsonCapped", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  async function* body(text: string) {
    yield bytes(text);
  }

  it("parses a JSON body within the cap", async () => {
    await expect(readJsonCapped(body('[{"a":1}]'), null, 100, "split it")).resolves.toEqual([{ a: 1 }]);
  });

  it("refuses an over-cap batch with the caller's message", async () => {
    const big = JSON.stringify([{ fileBase64: "x".repeat(200) }]);
    await expect(readJsonCapped(body(big), null, 100, "split it")).rejects.toMatchObject({ status: 413, message: "split it" });
    await expect(readJsonCapped(body("[]"), "101", 100, "split it")).rejects.toMatchObject({ status: 413, message: "split it" });
  });

  it("answers 400 for a body that is not JSON", async () => {
    await expect(readJsonCapped(body("not json"), null, 100, "split it")).rejects.toMatchObject({ status: 400 });
  });
});

describe("receiptRoute donor-read audit", () => {
  const recordReads = jest.mocked(recordReceiptDonorReads);
  const USER = {
    id: 7,
    name: "Fin Ance",
    isSysadmin: false,
    isKeyholder: false,
    isBoardMember: false,
    isBackgroundCheckReviewer: false,
    isOperations: false,
  };

  function ctx(role: Role, path = "/api/receipts"): HandlerContext<Record<string, string>> {
    return { req: new NextRequest(`http://localhost${path}`), auth: { type: "session", user: USER }, params: {}, role };
  }

  const donorRow = (id: string) => ({ id, donorFirstName: "Dana", donorLastName: "Giver", donorCompanyName: null });
  const plainRow = (id: string) => ({ id, donorFirstName: null, donorLastName: null, donorCompanyName: null });

  beforeEach(() => recordReads.mockReset());

  it.each<Role>(["isFinance", "isBoardMember"])("writes one row for a single receipt read under the %s view", async (role) => {
    await receiptRoute(async () => ({ ReceiptView: donorRow("r1") }))(ctx(role, "/api/receipts/r1"));
    expect(recordReads).toHaveBeenCalledTimes(1);
    expect(recordReads).toHaveBeenCalledWith({ actorUserId: 7, actorUsername: "Fin Ance", route: "GET /api/receipts/r1" }, ["r1"]);
  });

  it("writes one row per donor a list returns, in one batch, and none for receipts without a donor", async () => {
    const rows = [donorRow("r1"), plainRow("r2"), donorRow("r3"), { id: "r4", donorFirstName: null, donorLastName: null, donorCompanyName: "Acme" }];
    await receiptRoute(async () => ({ ReceiptView: rows }))(ctx("isFinance"));
    expect(recordReads).toHaveBeenCalledTimes(1);
    expect(recordReads.mock.calls[0][1]).toEqual(["r1", "r3", "r4"]);
  });

  it("writes nothing under a view that strips donor fields", async () => {
    await receiptRoute(async () => ({ ReceiptView: [donorRow("r1")] }))(ctx("authenticated"));
    expect(recordReads).not.toHaveBeenCalled();
  });

  it("writes nothing when no receipt shown has a donor", async () => {
    await receiptRoute(async () => ({ ReceiptView: [plainRow("r1")], ReceiptPushResult: { pushed: true } }))(ctx("isFinance"));
    expect(recordReads).not.toHaveBeenCalled();
  });

  it("fails the read when the audit write fails", async () => {
    recordReads.mockRejectedValueOnce(new Error("db down"));
    await expect(receiptRoute(async () => ({ ReceiptView: donorRow("r1") }))(ctx("isFinance"))).rejects.toThrow("db down");
  });
});
