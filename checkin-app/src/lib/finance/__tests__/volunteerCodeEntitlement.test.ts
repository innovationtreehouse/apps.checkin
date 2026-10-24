/**
 * @jest-environment node
 */
/**
 * Unit tests for usesVolunteerCodeUnentitled (lib/finance/reconcile/membership.ts) — the
 * volunteer-coupon entitlement predicate. The integration matrix drives it through
 * runReconcile against a real DB, but that suite is not in the default jest run;
 * this pins the predicate itself in default CI. Heavy reconcile deps are mocked
 * away — the predicate is pure.
 */
import type { MirrorOrder } from "@/lib/shopifyRead/client";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/membership/payment", () => ({ activateByProcessId: jest.fn() }));
jest.mock("@/lib/membership/boardAlerts", () => ({ notifyBoardPaymentException: jest.fn() }));
jest.mock("@/lib/shopifyRead/client", () => ({}));

import { usesVolunteerCodeUnentitled } from "../reconcile/membership";

const order = (discountCodes: string[]) => ({ discountCodes } as MirrorOrder);

describe("usesVolunteerCodeUnentitled", () => {
    it("flags a non-volunteer order carrying the volunteer code", () => {
        expect(usesVolunteerCodeUnentitled(order(["VOLFAM"]), "VOLFAM", false)).toBe(true);
    });

    it("compares case-insensitively and ignores whitespace — Shopify codes are case-insensitive", () => {
        expect(usesVolunteerCodeUnentitled(order(["volfam"]), "VolFam", false)).toBe(true);
        expect(usesVolunteerCodeUnentitled(order([" VOLFAM "]), "volfam ", false)).toBe(true);
    });

    it("never flags a volunteer membership", () => {
        expect(usesVolunteerCodeUnentitled(order(["VOLFAM"]), "VOLFAM", true)).toBe(false);
    });

    it("ignores other coupons — promos are Shopify's business, not checkin's", () => {
        expect(usesVolunteerCodeUnentitled(order(["SUMMER26"]), "VOLFAM", false)).toBe(false);
    });

    it("an empty code list is never evidence (pre-#1048 rows mirror no codes)", () => {
        expect(usesVolunteerCodeUnentitled(order([]), "VOLFAM", false)).toBe(false);
    });

    it("no-ops when the board has not configured a volunteer code (null or blank)", () => {
        expect(usesVolunteerCodeUnentitled(order(["VOLFAM"]), null, false)).toBe(false);
        expect(usesVolunteerCodeUnentitled(order(["VOLFAM"]), undefined, false)).toBe(false);
        expect(usesVolunteerCodeUnentitled(order([""]), "  ", false)).toBe(false);
    });
});
