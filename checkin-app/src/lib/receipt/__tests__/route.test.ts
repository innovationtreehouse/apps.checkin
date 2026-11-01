/**
 * @jest-environment node
 */
import { MAX_UPLOAD_BODY_BYTES as RECEIPT_UPLOAD_CEILING, type ReceiptRouteCtx } from "@checkin/receipt";
import { accessOf, receiptRoute } from "@/lib/receipt/route";
import { MAX_UPLOAD_BODY_BYTES } from "@/lib/requestBodyLimit";
import type { Role } from "@/security/core";
import type { HandlerContext } from "@/security/handler";

describe("accessOf", () => {
  it("acts org-wide only for the finance and board views", () => {
    expect(accessOf("isFinance")).toBe("finance");
    expect(accessOf("isBoardMember")).toBe("finance");
    expect(accessOf("authenticated")).toBe("submitter");
    expect(accessOf("isSysadmin")).toBe("submitter");
  });
});

describe("upload ceiling", () => {
  it("matches the API's body limit", () => {
    expect(RECEIPT_UPLOAD_CEILING).toBe(MAX_UPLOAD_BODY_BYTES);
  });
});

describe("receiptRoute", () => {
  const mounted = async (role: Role, auth: unknown) => {
    const factory = jest.fn<Promise<Record<string, unknown>>, [ReceiptRouteCtx]>(async () => ({}));
    await receiptRoute(factory)({ params: {}, role, auth } as unknown as HandlerContext);
    return factory.mock.calls[0][0];
  };
  const session = { type: "session", user: { id: 7 } };

  it("names the submitter only under the submitter view", async () => {
    expect((await mounted("authenticated", session)).submitterActorId).toBe(7);
    expect((await mounted("isFinance", session)).submitterActorId).toBeNull();
    expect((await mounted("isBoardMember", session)).submitterActorId).toBeNull();
  });

  it("leaves the submitter unnamed without a session person", async () => {
    expect((await mounted("authenticated", { type: "kiosk" })).submitterActorId).toBeNull();
    expect((await mounted("authenticated", { type: "session", user: { id: "x" } })).submitterActorId).toBeNull();
  });
});
