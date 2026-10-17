// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
jest.mock("@mantine/modals", () => ({
    modals: {
        openConfirmModal: jest.fn((opts: { onConfirm: () => void }) => opts.onConfirm()),
    },
}));

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import RolesPage from "../page";

beforeEach(() => resetRtl());

const people = [
    { id: 1, name: "Ann Admin", email: "ann@example.com", isYouth: false, isSysadmin: true, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false, isOperations: false },
    { id: 2, name: "Bob Board", email: "bob@example.com", isYouth: false, isSysadmin: false, isBoardMember: true, isKeyholder: false, isBackgroundCheckReviewer: false, isOperations: false },
];

describe("RolesPage — holders-first roles editor", () => {
    it("groups holders per role as named pills", async () => {
        setSession({ id: 99, isBoardMember: true });
        mockFetchJson({ "/api/roles": { people } });
        renderWithProviders(<RolesPage />);

        expect(await screen.findByText("Ann Admin")).toBeInTheDocument();
        expect(screen.getByText("Bob Board")).toBeInTheDocument();
        // Roles with no holder render the empty state.
        expect(screen.getAllByText("No one holds this role.").length).toBeGreaterThan(0);
    });

    it("person-picker opens the edit modal for the picked person, and a save updates the group", async () => {
        setSession({ id: 99, isBoardMember: true });
        const cara = { id: 3, name: "Cara Candidate", email: "cara@example.com", isSysadmin: false, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false, isOperations: false };
        const getFetch = mockFetchJson({ "/api/roles": { people }, "/api/people/search": { people: [cara] } });
        renderWithProviders(<RolesPage />);
        await screen.findByText("Ann Admin");

        fireEvent.change(screen.getByPlaceholderText("Search people by name, email, or ID..."), { target: { value: "cara" } });
        fireEvent.click(await screen.findByText("Cara Candidate"));

        // The shared modal opened for the picked person.
        expect(await screen.findByText(/Edit Roles — Cara Candidate/)).toBeInTheDocument();

        // Route the PATCH before triggering it — modals.openConfirmModal is mocked to
        // auto-confirm synchronously from inside the Save click handler.
        const patchFetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ message: "ok", user: { ...cara, isKeyholder: true } }),
        }));
        global.fetch = ((...args: Parameters<typeof fetch>) => {
            const init = args[1] as RequestInit | undefined;
            if (init?.method === "PATCH") return patchFetch();
            return getFetch(...args);
        }) as unknown as typeof fetch;

        fireEvent.click(screen.getByLabelText("Keyholder"));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(patchFetch).toHaveBeenCalled());
        // The new Keyholder holder now shows up in that role's section.
        await waitFor(() => expect(screen.getAllByText("Cara Candidate").length).toBeGreaterThan(0));
    });
});
