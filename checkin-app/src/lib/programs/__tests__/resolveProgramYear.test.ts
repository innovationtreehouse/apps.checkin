/**
 * @jest-environment node
 */
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { boardSettings: { findUnique: jest.fn() } },
}));

import prisma from "@/lib/prisma";
import { resolveProgramYear } from "../update";

const settings = prisma.boardSettings.findUnique as jest.Mock;
const d = (s: string) => new Date(`${s}T00:00:00Z`);
// Crosses 1 September 2026: touches 2025-2026 and 2026-2027.
const crossing = { startAt: d("2026-06-01"), endAt: d("2026-10-01") };

beforeEach(() => settings.mockResolvedValue({ orgMembershipYearBoundary: d("2000-09-01") }));

describe("resolveProgramYear", () => {
    it("derives the year when the dates fall inside one, overriding anything supplied", async () => {
        const r = await resolveProgramYear({ startAt: d("2026-09-15"), endAt: d("2026-12-01"), supplied: 2030, current: null, isBoardMember: false });
        expect(r).toEqual({ ok: true, appliesToYear: 2026 });
    });

    it("refuses when no boundary is configured", async () => {
        settings.mockResolvedValue({ orgMembershipYearBoundary: null });
        const r = await resolveProgramYear({ startAt: d("2026-09-15"), endAt: d("2026-12-01"), supplied: undefined, current: null, isBoardMember: true });
        expect(r).toMatchObject({ ok: false, refusal: "invalid", message: expect.stringContaining("boundary") });
    });

    it("takes a Board member's stated year when the dates cross", async () => {
        const r = await resolveProgramYear({ ...crossing, supplied: 2025, current: null, isBoardMember: true });
        expect(r).toEqual({ ok: true, appliesToYear: 2025 });
    });

    it("rejects a crossing program with no year, or a year its dates do not touch", async () => {
        expect(await resolveProgramYear({ ...crossing, supplied: undefined, current: null, isBoardMember: true }))
            .toMatchObject({ ok: false, refusal: "invalid" });
        expect(await resolveProgramYear({ ...crossing, supplied: 2027, current: null, isBoardMember: true }))
            .toMatchObject({ ok: false, refusal: "invalid", message: expect.stringContaining("2025-2026 or 2026-2027") });
    });

    it("sends anyone but the Board to ask the Board", async () => {
        expect(await resolveProgramYear({ ...crossing, supplied: 2026, current: null, isBoardMember: false }))
            .toMatchObject({ ok: false, refusal: "forbidden", message: expect.stringContaining("Ask the Board") });
        expect(await resolveProgramYear({ ...crossing, supplied: undefined, current: null, isBoardMember: false }))
            .toMatchObject({ ok: false, refusal: "forbidden" });
    });

    it("keeps a still-valid stated year across a date nudge, for anyone", async () => {
        const r = await resolveProgramYear({ startAt: d("2026-06-08"), endAt: d("2026-10-08"), supplied: undefined, current: 2025, isBoardMember: false });
        expect(r).toEqual({ ok: true, appliesToYear: 2025 });
    });

    it("rejects a non-integer year", async () => {
        expect(await resolveProgramYear({ ...crossing, supplied: "2026", current: null, isBoardMember: true }))
            .toMatchObject({ ok: false, refusal: "invalid" });
    });
});
