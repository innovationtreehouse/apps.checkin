// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { notifications } from "@mantine/notifications";
import CreateToolPage from "../page";

beforeEach(() => { resetRtl(); (notifications.show as jest.Mock).mockClear(); });

describe("CreateToolPage", () => {
    it("lists existing tools and creates a new one", async () => {
        mockFetchJson({ "/api/shop/tools": [{ id: 1, name: "Table Saw", safetyGuide: null }] });
        renderWithProviders(<CreateToolPage />);

        expect(await screen.findByText("Table Saw")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/equipment name/i), { target: { value: "Band Saw" } });
        fireEvent.click(screen.getByRole("button", { name: /create tool/i }));

        await waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "New tool added successfully!" })));
    });

    it("says the list failed and keeps the create form", async () => {
        mockFetchJson({});
        renderWithProviders(<CreateToolPage />);

        expect(await screen.findByText("Couldn't load the tools")).toBeInTheDocument();
        expect(screen.getByLabelText(/equipment name/i)).toBeInTheDocument();
    });
});
