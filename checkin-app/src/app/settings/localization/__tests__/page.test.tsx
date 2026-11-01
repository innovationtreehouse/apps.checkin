// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import LocalizationSettingsPage from "../page";

beforeEach(() => { resetRtl(); (notifications.show as jest.Mock).mockClear(); });

describe("LocalizationSettingsPage", () => {
    it("loads current settings and saves an update", async () => {
        setSession({ id: 1, isSysadmin: true });
        mockFetchJson({
            "/api/admin/settings/localization": { settings: { timezone: "America/Chicago", locale: "en-US" } },
        });
        renderWithProviders(<LocalizationSettingsPage />);

        const saveButton = await screen.findByRole("button", { name: /save settings/i });
        fireEvent.click(saveButton);

        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Settings saved." })));
    });

    it("shows the failure and no form when the load fails", async () => {
        setSession({ id: 1, isSysadmin: true });
        mockFetchJson({});
        renderWithProviders(<LocalizationSettingsPage />);

        expect(await screen.findByText("Couldn't load the localization settings")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /save settings/i })).not.toBeInTheDocument();
    });
});
