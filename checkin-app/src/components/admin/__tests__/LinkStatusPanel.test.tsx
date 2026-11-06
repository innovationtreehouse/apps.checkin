import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { LinkStatusPanel } from "../LinkStatusPanel";

beforeEach(() => resetRtl());
afterEach(() => act(() => notifications.clean()));

const errors = [
  {
    id: 1,
    source: "Shopify",
    message: "Timed out",
    context: { orderId: 7 },
    timestamp: "2026-06-01T12:00:00Z",
    resolvedAt: null,
  },
];

describe("LinkStatusPanel", () => {
  it("renders loaded errors", async () => {
    mockFetchJson({ "/api/system-status/links": { errors } });
    renderWithProviders(<LinkStatusPanel />);
    expect(await screen.findByText("Shopify")).toBeInTheDocument();
    expect(screen.getByText("Timed out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark resolved" })).toBeInTheDocument();
  });

  it("shows the empty message when there are no errors", async () => {
    mockFetchJson({ "/api/system-status/links": { errors: [] } });
    renderWithProviders(<LinkStatusPanel />);
    expect(await screen.findByText("● No integration errors logged.")).toBeInTheDocument();
  });

  it("shows a failure message when the fetch fails", async () => {
    mockFetchJson({});
    renderWithProviders(<LinkStatusPanel />);
    expect(await screen.findByText("Couldn't load link status")).toBeInTheDocument();
    expect(screen.queryByText("● No integration errors logged.")).not.toBeInTheDocument();
  });

  it("PATCHes resolved on click", async () => {
    const fetchFn = mockFetchJson({ "/api/system-status/links": { errors } });
    renderWithProviders(<LinkStatusPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark resolved" }));

    await waitFor(() => {
      const patchCall = fetchFn.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PATCH");
      expect(patchCall?.[0]).toContain("/api/system-status/links/1");
      expect(JSON.parse((patchCall?.[1] as RequestInit).body as string)).toEqual({ resolved: true });
    });
    await waitFor(() => {
      const gets = fetchFn.mock.calls.filter((c) => !(c[1] as RequestInit | undefined)?.method);
      expect(gets).toHaveLength(2);
    });
  });
  it("shows a refused PATCH in the lower right instead of nothing", async () => {
    const list = mockFetchJson({ "/api/system-status/links": { errors } });
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PATCH"
        ? Promise.resolve(new Response(JSON.stringify({ error: "Not allowed" }), { status: 403 }))
        : list(input, init),
    ) as unknown as typeof fetch;
    renderWithProviders(<LinkStatusPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark resolved" }));

    await waitFor(() =>
      expect(notificationsStore.getState().notifications).toEqual([
        expect.objectContaining({ color: "red", message: "Not allowed", autoClose: false }),
      ]),
    );
    expect(screen.getByRole("button", { name: "Mark resolved" })).toBeInTheDocument();
  });

  it("shows fixed text, not the exception's, when the PATCH never answers", async () => {
    const list = mockFetchJson({ "/api/system-status/links": { errors } });
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PATCH" ? Promise.reject(new TypeError("fetch failed: ECONNRESET")) : list(input, init),
    ) as unknown as typeof fetch;
    renderWithProviders(<LinkStatusPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark resolved" }));

    await waitFor(() =>
      expect(notificationsStore.getState().notifications).toEqual([
        expect.objectContaining({ color: "red", message: "Couldn't reach the server. Check your connection and try again." }),
      ]),
    );
  });
});
