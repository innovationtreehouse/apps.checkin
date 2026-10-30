// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, within } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import AdminParticipantsIndex from "../page";

beforeEach(() => {
    resetRtl();
});

const bob = {
    id: 2, name: "Bob B", email: "bob@example.com", phone: null,
    household: { id: 20, name: "The B Family", householdMembers: [{ id: 2, name: "Bob B", email: "bob@example.com" }] },
};

// Operations holds the Participants directory read-only, plus add-contact — every
// other write/rich-create affordance (household assign, edit-details,
// new person, the roles editor link) is board/sysadmin-only. The API is the real
// guard (people/search's opsOnly strip, the edit endpoints' roles: [...] gates);
// this pins the UI mirror so an ops session isn't shown a button whose endpoint
// would 403 it anyway.
describe("AdminParticipantsIndex — operations sees a read-only directory", () => {
    it("shows the directory and + Add contact, but no write affordances", async () => {
        setSession({ id: 42, isOperations: true });
        mockFetchJson({ "/api/people/search": { people: [bob] } });
        renderWithProviders(<AdminParticipantsIndex />);

        expect(await screen.findByText("Bob B")).toBeInTheDocument();
        expect(screen.getByText("The B Family")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "+ Add contact" })).toBeInTheDocument();

        expect(screen.queryByRole("button", { name: "+ New Person" })).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Manage" })).not.toBeInTheDocument();
        expect(screen.queryByText("Actions")).not.toBeInTheDocument();

        // Row-level write actions (not the "Household" sort-toggle column header,
        // which shares the same accessible name and stays for read-only browsing).
        const bobRow = screen.getByText("Bob B").closest("tr")!;
        expect(within(bobRow).queryByRole("button", { name: "Household" })).not.toBeInTheDocument();
        expect(within(bobRow).queryByRole("button", { name: "Assign" })).not.toBeInTheDocument();
        expect(within(bobRow).queryByRole("button", { name: "Details" })).not.toBeInTheDocument();
    });
});
