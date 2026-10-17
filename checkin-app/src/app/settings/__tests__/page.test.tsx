// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { renderWithProviders, resetRtl, router, setSession } from "@/test-helpers/rtl";
import SettingsIndex from "../page";

beforeEach(() => resetRtl());

describe("SettingsIndex", () => {
    it("lands board/sysadmin on Membership Settings", () => {
        setSession({ id: 1, isBoardMember: true });
        renderWithProviders(<SettingsIndex />);
        expect(router.replace).toHaveBeenCalledWith("/settings/membership");
    });

    // Operations reach only Outreach; the board-only Membership Settings would
    // bounce them, so the hub must not send them there (#1569).
    it("lands an operations-only user on Outreach", () => {
        setSession({ id: 2, isOperations: true });
        renderWithProviders(<SettingsIndex />);
        expect(router.replace).toHaveBeenCalledWith("/settings/outreach");
    });

    it("does not redirect before the session is authenticated", () => {
        setSession(null);
        renderWithProviders(<SettingsIndex />);
        expect(router.replace).not.toHaveBeenCalled();
    });
});
