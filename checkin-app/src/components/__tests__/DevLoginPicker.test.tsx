type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
import { renderWithProviders, mockFetchJson, resetRtl, setCheckinEnv } from "@/test-helpers/rtl";
import DevLoginPicker from "../DevLoginPicker";

const persona = {
  id: 3, email: "parent@example.com", name: "Pat Parent", isSysadmin: false, isBoardMember: false, isKeyholder: false,
  isBackgroundCheckReviewer: false, dateOfBirth: null, householdId: null, toolStatuses: [],
};

const failWith = (status: number, error: string) => {
  const fetchMock = jest.fn(async () => new Response(JSON.stringify({ error }), { status }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

beforeEach(() => {
  resetRtl();
  setCheckinEnv("local");
});
afterEach(() => act(() => notifications.clean()));

describe("DevLoginPicker", () => {
  it("lists the dev personas", async () => {
    mockFetchJson({ "/api/auth/dev-personas": { personas: [persona] } });
    renderWithProviders(<DevLoginPicker />);
    expect(await screen.findByText("Pat Parent")).toBeInTheDocument();
  });

  it("shows a failed persona load, not an empty picker", async () => {
    failWith(404, "Not available");
    renderWithProviders(<DevLoginPicker />);
    expect(await screen.findByText("Couldn't load dev personas")).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("hides itself when the route refuses a signed-out caller", async () => {
    const fetchMock = failWith(401, "Sign in first");
    renderWithProviders(<DevLoginPicker />);
    await waitFor(() => expect(screen.queryByText("Loading dev personas...")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
    expect(screen.queryByText("🛠 Dev Quick Login")).not.toBeInTheDocument();
  });

  it("reads nothing on prod", () => {
    setCheckinEnv("prod");
    const fetchMock = mockFetchJson({});
    renderWithProviders(<DevLoginPicker />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the route's words when minting a new registrant is refused", async () => {
    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ error: "Local instance only" }), { status: 403 })
        : new Response(JSON.stringify({ personas: [persona] })),
    ) as unknown as typeof fetch;
    renderWithProviders(<DevLoginPicker />);

    fireEvent.click(await screen.findByText(/New registrant/));
    await waitFor(() =>
      expect(notificationsStore.getState().notifications[0]).toMatchObject({ message: "Local instance only", color: "red" }),
    );
    expect(screen.getByText(/＋ New registrant/)).toBeInTheDocument();
  });
});
