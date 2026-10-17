import { parseVisitTime, departureAfterArrival, withinMaxDuration, isUnchangedTime } from "../visitTimes";

const now = new Date("2026-07-04T12:00:00Z");

describe("parseVisitTime", () => {
  it("rejects an invalid string per field", () => {
    expect(parseVisitTime("not-a-date", "arrival", now)).toEqual({
      ok: false,
      error: "Invalid arrival time",
    });
    expect(parseVisitTime("not-a-date", "departure", now)).toEqual({
      ok: false,
      error: "Invalid departure time",
    });
  });

  it("rejects a future time with the right wording per field", () => {
    const future = new Date(now.getTime() + 60_000).toISOString();
    expect(parseVisitTime(future, "arrival", now)).toEqual({
      ok: false,
      error: "Arrival time cannot be in the future.",
    });
    expect(parseVisitTime(future, "departure", now)).toEqual({
      ok: false,
      error: "Departure time cannot be in the future.",
    });
  });

  it("accepts a valid past time", () => {
    const past = "2026-07-04T11:00:00Z";
    expect(parseVisitTime(past, "arrival", now)).toEqual({
      ok: true,
      value: new Date(past),
    });
  });
});

describe("departureAfterArrival", () => {
  const arrived = new Date("2026-07-04T10:00:00Z");
  it("true when strictly after", () => {
    expect(departureAfterArrival(arrived, new Date("2026-07-04T11:00:00Z"))).toBe(true);
  });
  it("false when equal (zero-length rejected)", () => {
    expect(departureAfterArrival(arrived, new Date("2026-07-04T10:00:00Z"))).toBe(false);
  });
  it("false when before", () => {
    expect(departureAfterArrival(arrived, new Date("2026-07-04T09:00:00Z"))).toBe(false);
  });
});

describe("withinMaxDuration", () => {
  const arrived = new Date("2026-07-04T10:00:00Z");
  it("true under 24h", () => {
    expect(withinMaxDuration(arrived, new Date("2026-07-05T09:00:00Z"))).toBe(true);
  });
  it("true at exactly 24h", () => {
    expect(withinMaxDuration(arrived, new Date("2026-07-05T10:00:00Z"))).toBe(true);
  });
  it("false past 24h", () => {
    expect(withinMaxDuration(arrived, new Date("2026-07-05T10:00:01Z"))).toBe(false);
  });
});

describe("isUnchangedTime", () => {
  const stored = new Date("2026-07-04T09:58:45Z");
  it("true for the stored time truncated to its minute", () => {
    expect(isUnchangedTime(new Date("2026-07-04T09:58:00Z"), stored)).toBe(true);
  });
  it("false for a different minute", () => {
    expect(isUnchangedTime(new Date("2026-07-04T09:59:00Z"), stored)).toBe(false);
  });
  it("false when nothing is stored", () => {
    expect(isUnchangedTime(stored, null)).toBe(false);
  });
});
