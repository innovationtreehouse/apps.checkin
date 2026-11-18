type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { screen, waitFor } from "@testing-library/react";
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
});
