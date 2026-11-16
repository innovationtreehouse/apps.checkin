/**
 * @jest-environment node
 *
 * The review-override route's two Board actions, reset and release: the same
 * Board-only gate for both, a reason required for both, and each dispatched to
 * its own service function.
 */
import { getServerSession } from "next-auth/next";
import { boardResetReview } from "@/lib/membership/review";
import { releaseDepartedRejection } from "@/lib/membership/settleHouseholdBg";
import { POST } from "@/app/api/membership-ops/applications/review-override/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/membership/review", () => ({ ...jest.requireActual("@/lib/membership/review"), boardResetReview: jest.fn() }));
jest.mock("@/lib/membership/settleHouseholdBg", () => ({ releaseDepartedRejection: jest.fn() }));

const session = getServerSession as jest.Mock;
const reset = boardResetReview as jest.Mock;
const release = releaseDepartedRejection as jest.Mock;

const post = (body: unknown) =>
    POST(new Request("http://localhost/api/membership-ops/applications/review-override", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    }));

beforeEach(() => {
    jest.clearAllMocks();
    session.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
    reset.mockResolvedValue({ status: "PENDING_BG_REVIEW" });
    release.mockResolvedValue({ status: "PENDING_PAYMENT", steps: [] });
});

describe("POST /api/membership-ops/applications/review-override", () => {
    it.each(["reset", "release"])("refuses a non-board caller the same way for %s", async (action) => {
        session.mockResolvedValue({ user: { id: 5, isBoardMember: false, isSysadmin: true } });
        const res = await post({ processId: 1, action, reason: "moved out" });
        expect(res.status).toBe(403);
        expect(reset).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
    });

    it("releases with the trimmed reason and ignores fields it does not use", async () => {
        const res = await post({ processId: 9, action: "release", reason: "  moved out ", wrongPerson: true });
        expect(res.status).toBe(200);
        expect(release).toHaveBeenCalledWith(9, 5, "moved out");
        expect(reset).not.toHaveBeenCalled();
        expect(await res.json()).toEqual({ outcome: { status: "PENDING_PAYMENT", steps: [] } });
    });

    it.each([
        [{ processId: 9, action: "release" }],
        [{ processId: 9, action: "release", reason: "   " }],
        [{ action: "release", reason: "moved out" }],
        [{ processId: "9", action: "release", reason: "moved out" }],
        [{ processId: 9, action: "undo", reason: "moved out" }],
    ])("rejects %j with 400", async (body) => {
        expect((await post(body)).status).toBe(400);
        expect(release).not.toHaveBeenCalled();
    });

    it("still resets", async () => {
        const res = await post({ processId: 9, action: "reset", reason: "typo", wrongPerson: true });
        expect(res.status).toBe(200);
        expect(reset).toHaveBeenCalledWith(9, 5, { reason: "typo", wrongPerson: true });
    });
});
