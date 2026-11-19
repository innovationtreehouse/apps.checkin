/** A failure that cannot be recorded on the receipt is logged with the receipt id, and the request goes on. */
import { beforeEach, expect, it, vi } from "vitest";
import { describeDb } from "../helpers/db";
import { clearAll, configure, manualDetails, recordingPorts, textFile, uploadRead } from "../helpers/setup";

const unrecorded = new Error("database unavailable");

vi.mock("../../repositories/receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../repositories/receipt")>()),
  recordFailure: async () => {
    throw unrecorded;
  },
}));

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink });
});

describeDb("recordFailure errors", () => {
  it.each(["push", "donor"] as const)("a failed %s whose failure cannot be recorded is logged, and the upload still answers", async (step) => {
    ports.fail[step] = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const r = await uploadRead(textFile(), "text/plain", { details: manualDetails(), ...(step === "donor" ? { isInKind: true, donor: { self: true } } : {}) });

    expect(logged).toHaveBeenCalledWith(expect.stringContaining(`recording the failure of receipt ${r.id}`), unrecorded);
    logged.mockRestore();
  });
});
