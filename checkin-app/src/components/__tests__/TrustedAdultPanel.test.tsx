import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import TrustedAdultPanel from "../TrustedAdultPanel";

beforeEach(() => resetRtl());
afterEach(() => act(() => notifications.clean()));

const shown = () => notificationsStore.getState().notifications;

const trustedAdult = (overrides: Partial<{ id: number; status: string }> = {}) => ({
  id: overrides.id ?? 1,
  trustedAdultName: "Jane Doe",
  trustedAdultPhone: "555-010-0000",
  trustedAdultEmail: null,
  familyContext: "Aunt, may pick up the kids.",
  createdAt: "2026-01-01T00:00:00.000Z",
  reviews: [
    {
      id: 1,
      kind: "INITIAL",
      status: overrides.status ?? "APPROVED",
      sharedNote: null,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      reviewBy: "2027-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
});

describe("TrustedAdultPanel", () => {
  it("loads and renders the list from the mine endpoint", async () => {
    mockFetchJson({ "/api/trusted-adults/mine": { trustedAdults: [trustedAdult()] } });
    renderWithProviders(<TrustedAdultPanel />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Phone: 555-010-0000")).toBeInTheDocument();
    expect(screen.queryByText("No trusted adults added yet.")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are none", async () => {
    mockFetchJson({ "/api/trusted-adults/mine": { trustedAdults: [] } });
    renderWithProviders(<TrustedAdultPanel />);

    expect(await screen.findByText("No trusted adults added yet.")).toBeInTheDocument();
  });

  it("opens the add modal, blocks submit until the form is valid, then POSTs and reloads", async () => {
    const fetchSpy = mockFetchJson({
      "/api/trusted-adults/mine": () => ({ trustedAdults: [] }),
      "/api/trusted-adults": { id: 2 },
    });
    renderWithProviders(<TrustedAdultPanel />);
    await screen.findByText("No trusted adults added yet.");

    fireEvent.click(screen.getByRole("button", { name: /Add a trusted adult/i }));
    const submitBtn = await screen.findByRole("button", { name: /Submit for board review/i });
    // Nothing filled in yet: submit is blocked (no POST fires).
    fireEvent.click(submitBtn);
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/trusted-adults", expect.anything());

    fireEvent.change(screen.getByLabelText(/Trusted adult's name/i), { target: { value: "Uncle Bob" } });
    fireEvent.change(screen.getByLabelText(/Their phone/i), { target: { value: "555-222-3333" } });
    fireEvent.change(
      screen.getByLabelText(/For the board: your relationship to this adult/i),
      { target: { value: "May pick up on Fridays." } },
    );

    fireEvent.click(submitBtn);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/trusted-adults",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    // Submitting closes the modal and reloads the list.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Submit for board review/i })).not.toBeInTheDocument());
  });

  it("withdraws an approved entry via the action endpoint", async () => {
    const fetchSpy = mockFetchJson({
      "/api/trusted-adults/mine": { trustedAdults: [trustedAdult()] },
      "/api/trusted-adults/1/withdraw": {},
    });
    renderWithProviders(<TrustedAdultPanel />);

    const card = (await screen.findByText("Jane Doe")).closest(".mantine-Card-root") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /Withdraw/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/trusted-adults/1/withdraw",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("says a withdraw worked", async () => {
    mockFetchJson({
      "/api/trusted-adults/mine": { trustedAdults: [trustedAdult()] },
      "/api/trusted-adults/1/withdraw": {},
    });
    renderWithProviders(<TrustedAdultPanel />);

    const card = (await screen.findByText("Jane Doe")).closest(".mantine-Card-root") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /Withdraw/i }));

    await waitFor(() => expect(shown()).toEqual([expect.objectContaining({ color: "green", message: "Trusted adult withdrawn." })]));
  });

  it("shows fixed text in the lower right when a withdraw never answers, instead of nothing", async () => {
    const list = mockFetchJson({ "/api/trusted-adults/mine": { trustedAdults: [trustedAdult()] } });
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? Promise.reject(new TypeError("fetch failed: ECONNRESET")) : list(input, init),
    ) as unknown as typeof fetch;
    renderWithProviders(<TrustedAdultPanel />);

    const card = (await screen.findByText("Jane Doe")).closest(".mantine-Card-root") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /Withdraw/i }));

    await waitFor(() =>
      expect(shown()).toEqual([
        expect.objectContaining({ color: "red", message: "Couldn't reach the server. Check your connection and try again.", autoClose: false }),
      ]),
    );
  });

  it("keeps the add modal open and shows a refused submit in the lower right", async () => {
    const list = mockFetchJson({ "/api/trusted-adults/mine": { trustedAdults: [] } });
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? Promise.resolve(new Response(JSON.stringify({ error: "This trusted adult is already on your list." }), { status: 409 }))
        : list(input, init),
    ) as unknown as typeof fetch;
    renderWithProviders(<TrustedAdultPanel />);
    await screen.findByText("No trusted adults added yet.");

    fireEvent.click(screen.getByRole("button", { name: /Add a trusted adult/i }));
    fireEvent.change(await screen.findByLabelText(/Trusted adult's name/i), { target: { value: "Uncle Bob" } });
    fireEvent.change(screen.getByLabelText(/Their phone/i), { target: { value: "555-222-3333" } });
    fireEvent.change(screen.getByLabelText(/For the board: your relationship to this adult/i), { target: { value: "May pick up on Fridays." } });
    fireEvent.click(screen.getByRole("button", { name: /Submit for board review/i }));

    await waitFor(() =>
      expect(shown()).toEqual([
        expect.objectContaining({ color: "red", message: "This trusted adult is already on your list.", autoClose: false }),
      ]),
    );
    expect(screen.getByRole("button", { name: /Submit for board review/i })).toBeInTheDocument();
  });

  it("shows the load failure with a retry, not an empty list, when the load fails", async () => {
    mockFetchJson({});
    renderWithProviders(<TrustedAdultPanel />);

    expect(await screen.findByText("Couldn't load your trusted adults")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
    expect(screen.queryByText("No trusted adults added yet.")).not.toBeInTheDocument();
  });

  it("offers Delete (not Withdraw) once an entry is withdrawn", async () => {
    mockFetchJson({ "/api/trusted-adults/mine": { trustedAdults: [trustedAdult({ status: "REVOKED" })] } });
    renderWithProviders(<TrustedAdultPanel />);

    const card = (await screen.findByText("Jane Doe")).closest(".mantine-Card-root") as HTMLElement;
    expect(within(card).getByRole("button", { name: /Delete/i })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Withdraw/i })).not.toBeInTheDocument();
  });
});
