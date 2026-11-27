import { planTarget, type LedgerRow } from "../diff";
import type { DesiredMember } from "../desiredState";
import type { ListTargetKind } from "@/generated/prisma/client";

const m = (personId: number | null, email: string): DesiredMember => ({ personId, email, reasons: ["r"] });
const row = (personId: number | null, appliedEmail: string | null, lastIntent: LedgerRow["lastIntent"] = null): LedgerRow => ({
    personId, appliedEmail, appliedAt: appliedEmail ? new Date(0) : null, lastIntent,
});
const plan = (members: DesiredMember[], observed: string[], ledger: LedgerRow[], targetKind: ListTargetKind = "MEMBERS") =>
    planTarget({ targetKind, members }, observed, ledger);

describe("planTarget", () => {
    it("the section 4 swap adds C and removes B_old, rebinding the shared address", () => {
        const p = plan(
            [m(1, "c@x.org"), m(2, "a_old@x.org")],
            ["a_old@x.org", "b_old@x.org"],
            [row(1, "a_old@x.org"), row(2, "b_old@x.org")],
        );
        expect(p.adds).toEqual([{ personId: 1, email: "c@x.org", reasons: ["r"] }]);
        expect(p.removes).toEqual([{ email: "b_old@x.org" }]);
        expect(p.rebinds).toEqual([{ personId: 2, email: "a_old@x.org" }]);
        expect(p.ghosts).toEqual([]);
    });

    it("compares addresses through canonicalizeEmail", () => {
        const p = plan([m(1, "a.b+x@gmail.com")], ["ab@gmail.com"], [row(1, "ab@gmail.com")]);
        expect(p).toEqual({ adds: [], removes: [], adopts: [], rebinds: [], ghosts: [] });
    });

    it("adopts a desired, present address with no ledger row, with no add", () => {
        const p = plan([m(1, "a@x.org")], ["a@x.org"], []);
        expect(p.adopts).toEqual([{ personId: 1, email: "a@x.org" }]);
        expect(p.adds).toEqual([]);
        expect(p.removes).toEqual([]);
    });

    it("an OUT intent suppresses the add", () => {
        expect(plan([m(1, "a@x.org")], [], [row(1, null, "OUT")]).adds).toEqual([]);
    });

    it("reports a ghost and never removes it", () => {
        const p = plan([], ["stranger@x.org"], []);
        expect(p.ghosts).toEqual(["stranger@x.org"]);
        expect(p.removes).toEqual([]);
    });

    it("removes an address the ledger applied once it is no longer desired", () => {
        expect(plan([], ["gone@x.org"], [row(3, "gone@x.org")]).removes).toEqual([{ email: "gone@x.org" }]);
    });

    it("the newsletter keeps an applied address that is no longer desired", () => {
        expect(plan([], ["gone@x.org"], [row(3, "gone@x.org")], "NEWSLETTER").removes).toEqual([]);
    });

    it("the newsletter removes an applied address on the person's own OUT", () => {
        const p = plan([m(3, "gone@x.org")], ["gone@x.org"], [row(3, "gone@x.org", "OUT")], "NEWSLETTER");
        expect(p.removes).toEqual([{ email: "gone@x.org" }]);
        expect(p.adopts).toEqual([]);
    });

    it("an external contact's OUT suppresses the add, and a removed contact comes off", () => {
        const ext = (email: string, intent: LedgerRow["lastIntent"] = null) => row(null, email, intent);
        expect(plan([m(null, "x@out.org")], [], [ext("x@out.org", "OUT")], "PROGRAM_EXTERNAL").adds).toEqual([]);
        expect(plan([], ["gone@out.org"], [ext("gone@out.org")], "PROGRAM_EXTERNAL").removes).toEqual([{ email: "gone@out.org" }]);
        expect(plan([m(null, "new@out.org")], ["new@out.org"], [], "PROGRAM_EXTERNAL").adopts).toEqual([{ personId: null, email: "new@out.org" }]);
    });
});
