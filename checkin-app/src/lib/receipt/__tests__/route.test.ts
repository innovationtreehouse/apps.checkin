/**
 * @jest-environment node
 */
import { MAX_UPLOAD_BODY_BYTES as RECEIPT_UPLOAD_CEILING } from "@checkin/receipt";
import { accessOf } from "@/lib/receipt/route";
import { MAX_UPLOAD_BODY_BYTES } from "@/lib/requestBodyLimit";

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
