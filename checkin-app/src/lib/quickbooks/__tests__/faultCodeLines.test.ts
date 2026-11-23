import { linesByCode, type FaultCodeRow } from "@/lib/quickbooks/faultCodeLines";

const row = (over: Partial<FaultCodeRow>): FaultCodeRow => ({
  code: "6000",
  kind: "data",
  count: 1,
  firstSeenAt: "2026-11-03T10:00:00.000Z",
  lastSeenAt: "2026-11-03T10:00:00.000Z",
  lastLane: "expense posting",
  ...over,
});

describe("linesByCode", () => {
  it("folds a code's kinds into one line, counts summed, dates widened, lane from the latest row", () => {
    const lines = linesByCode([
      row({ kind: "connection", count: 1, firstSeenAt: "2026-11-01T08:00:00.000Z", lastSeenAt: "2026-11-01T08:00:00.000Z", lastLane: "income deposit-build" }),
      row({ kind: "data", count: 14, lastSeenAt: "2026-11-20T09:12:00.000Z", lastLane: "expense posting" }),
    ]);
    expect(lines).toEqual([
      {
        code: "6000",
        kinds: [
          { kind: "data", count: 14 },
          { kind: "connection", count: 1 },
        ],
        count: 15,
        firstSeenAt: "2026-11-01T08:00:00.000Z",
        lastSeenAt: "2026-11-20T09:12:00.000Z",
        lastLane: "expense posting",
      },
    ]);
  });

  it("orders codes by last seen, newest first", () => {
    const lines = linesByCode([
      row({ code: "6190", lastSeenAt: "2026-11-06T00:00:00.000Z" }),
      row({ code: "6000", lastSeenAt: "2026-11-20T00:00:00.000Z" }),
    ]);
    expect(lines.map((l) => l.code)).toEqual(["6000", "6190"]);
  });
});
