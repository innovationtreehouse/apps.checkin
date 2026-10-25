import { mockFetchJson } from "@/test-helpers/rtl";
import { receivedReceiptIds } from "../partMappingLinks";

describe("receivedReceiptIds", () => {
  it("asks the receipt queue for the page's receipts and maps each to its Part mapping id", async () => {
    const fetchMock = mockFetchJson({ "/api/workflow-mapping/receipts?": [{ id: 31, receiptId: "r-9" }, { id: 32, receiptId: "r-10" }] });
    await expect(receivedReceiptIds(["r-9", "r-10"])).resolves.toEqual({ "r-9": 31, "r-10": 32 });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/workflow-mapping/receipts?receiptId=r-9&receiptId=r-10");
  });

  it("asks nothing for an empty page", async () => {
    const fetchMock = mockFetchJson({});
    await expect(receivedReceiptIds([])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the lookup when it fails", async () => {
    mockFetchJson({});
    await expect(receivedReceiptIds(["r-9"])).rejects.toThrow("The Part mapping receipt lookup failed (HTTP 404)");
  });
});
