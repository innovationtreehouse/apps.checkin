// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import BoardContactInfoPage from "../page";

beforeEach(() => resetRtl());

describe("safety/board-contacts page", () => {
  it("loads and renders the board member directory", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({
      "/api/safety/board-contacts": {
        members: [{ id: 1, name: "Bob Board", phone: "5551234567", email: "bob@example.com" }],
      },
    });
    renderWithProviders(<BoardContactInfoPage />);

    expect(await screen.findByText("Bob Board")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getByText("555-123-4567")).toBeInTheDocument();
  });

  it("shows the empty state with no members", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({ "/api/safety/board-contacts": { members: [] } });
    renderWithProviders(<BoardContactInfoPage />);

    expect(await screen.findByText("No board members found.")).toBeInTheDocument();
  });

  it("shows the failure in place of the directory when the load fails", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({});
    renderWithProviders(<BoardContactInfoPage />);

    expect(await screen.findByText("Couldn't load board contacts")).toBeInTheDocument();
    expect(screen.queryByText("No board members found.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
