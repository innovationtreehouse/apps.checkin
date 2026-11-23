jest.mock("@mantine/modals", () => ({ modals: { openConfirmModal: (opts: { onConfirm: () => void }) => opts.onConfirm() } }));

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { KeyVolunteerAgreementCard } from "../KeyVolunteerAgreementCard";

beforeEach(() => resetRtl());
afterEach(() => act(() => notifications.clean()));

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

  it("shows the route's words when a new version is refused", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ error: "The agreement document is not in place." }), { status: 409 })
        : new Response(JSON.stringify(String(input) === "/api/roles" ? { people: [] } : { documentConfigured: false })),
    ) as unknown as typeof fetch;
    renderWithProviders(<KeyVolunteerAgreementCard initialVersion={2} />);

    fireEvent.click(screen.getByRole("button", { name: "New version (material change)" }));
    await waitFor(() =>
      expect(notificationsStore.getState().notifications[0]).toMatchObject({ message: "The agreement document is not in place.", color: "red" }),
    );
  });
});
