import { summarizeResidue } from "../route";

describe("summarizeResidue", () => {
  it("drops zero-count relations", () => {
    const { residue } = summarizeResidue({ programParticipants: 0, visits: 0 });
    expect(residue).toEqual([]);
  });

  it("keeps nonzero residue with its disposition", () => {
    const { residue } = summarizeResidue({ programParticipants: 2, roles: 1 });
    expect(residue).toEqual([
      expect.objectContaining({ key: "programParticipants", count: 2, disposition: "route" }),
      expect.objectContaining({ key: "roles", count: 1, disposition: "cascade" }),
    ]);
  });

  it("counts only no-pathway rows toward noPathwayRows", () => {
    // route (5) + cascade (1) do NOT count; toolStatuses + rsvps do.
    const { noPathwayRows } = summarizeResidue({
      programParticipants: 5,
      roles: 1,
      toolStatuses: 2,
      rsvps: 3,
    });
    expect(noPathwayRows).toBe(5);
  });

  it("treats a missing key as zero", () => {
    const { residue, noPathwayRows } = summarizeResidue({});
    expect(residue).toEqual([]);
    expect(noPathwayRows).toBe(0);
  });
});
