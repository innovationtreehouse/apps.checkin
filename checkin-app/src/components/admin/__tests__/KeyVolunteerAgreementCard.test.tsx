import { screen } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { KeyVolunteerAgreementCard } from "../KeyVolunteerAgreementCard";

beforeEach(() => resetRtl());

describe("KeyVolunteerAgreementCard", () => {
  it("shows whether the document is in place", async () => {
    mockFetchJson({ "/api/membership/key-volunteer": { documentConfigured: true }, "/api/roles": { people: [] } });
    renderWithProviders(<KeyVolunteerAgreementCard initialVersion={2} />);
    expect(await screen.findByText("Document in place")).toBeInTheDocument();
  });

  it("shows a failed document status load instead of no badge", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/roles"
        ? new Response(JSON.stringify({ people: [] }))
        : new Response(JSON.stringify({ error: "Board only" }), { status: 403 }),
    ) as unknown as typeof fetch;
    renderWithProviders(<KeyVolunteerAgreementCard initialVersion={2} />);

    expect(await screen.findByText("Couldn't load the agreement document status")).toBeInTheDocument();
    expect(screen.getByText("Board only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New version (material change)" })).toBeInTheDocument();
  });
});
