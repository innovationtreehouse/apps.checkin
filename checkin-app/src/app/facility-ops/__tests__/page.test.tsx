// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { renderWithProviders, setSession, resetRtl, router } from "@/test-helpers/rtl";
import FacilityOpsIndex from "../page";

beforeEach(() => resetRtl());

describe("FacilityOpsIndex", () => {
    it("redirects a board member / sysadmin to /facility-ops/visits", async () => {
        setSession({ id: 1, isSysadmin: true });
        renderWithProviders(<FacilityOpsIndex />);

        await Promise.resolve();
        expect(router.replace).toHaveBeenCalledWith("/facility-ops/visits");
    });

    it("redirects an operations user to /facility-ops/print-badges — a page they can stay on", async () => {
        setSession({ id: 2, isOperations: true });
        renderWithProviders(<FacilityOpsIndex />);

        await Promise.resolve();
        expect(router.replace).toHaveBeenCalledWith("/facility-ops/print-badges");
    });
});
