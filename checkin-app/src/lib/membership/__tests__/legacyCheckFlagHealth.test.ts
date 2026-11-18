/**
 * @jest-environment node
 */
import prisma from "@/lib/prisma";
import { openProcess } from "@/lib/membership/lifecycle";
import { legacyCheckFlagCheck, legacyCheckFlagWhere } from "../legacyCheckFlagHealth";

const count = jest.fn();

beforeEach(() => {
    count.mockReset();
    prisma.orgMembershipProcess.count = count;
});

describe("legacyCheckFlagWhere", () => {
    it("counts open INITIAL and RENEWAL applications with the flag set and no clearance", () => {
        expect(legacyCheckFlagWhere).toEqual({
            status: { in: [...openProcess.statuses] },
            kind: { in: ["INITIAL", "RENEWAL"] },
            bgConsentAt: { not: null },
            bgClearedAt: null,
        });
    });
});

describe("Applications on the old household check flag", () => {
    it("is green at 0 and says step 3 can go", async () => {
        count.mockResolvedValue(0);
        expect(await legacyCheckFlagCheck()).toEqual({
            id: "membership-legacy-check-flag",
            label: "Applications on the old household check flag",
            ok: true,
            detail: "0. The legacy clause can be removed (step 3 of the check-started cutover).",
        });
        expect(count).toHaveBeenCalledWith({ where: legacyCheckFlagWhere });
    });

    it("stays green with the count while some remain", async () => {
        count.mockResolvedValue(3);
        expect(await legacyCheckFlagCheck()).toMatchObject({ ok: true, detail: expect.stringMatching(/^3 open\./) });
    });

    it("is red when the count cannot be read", async () => {
        count.mockRejectedValue(new Error("db down"));
        expect(await legacyCheckFlagCheck()).toMatchObject({ ok: false, detail: "Could not read it: db down." });
    });
});
