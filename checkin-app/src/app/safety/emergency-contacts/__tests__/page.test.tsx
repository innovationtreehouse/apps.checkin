// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import EmergencyContactsPage from "../page";

beforeEach(() => resetRtl());

const households = [
  {
    id: 1,
    name: "Keyholder House",
    emergencyContactName: null,
    emergencyContactPhone: null,
    emergencyContacts: [{ id: 11, name: "Gary Guardian", phone: "5551234567", email: "gary@example.com", relationship: "Uncle", invalid: false }],
    isPresent: true,
    householdMembers: [{ id: 101, name: "Kid Keyholder", isPresent: true }],
    leads: [{ id: 201, name: "Lea Lead", phone: "5559876543", email: "lea@example.com" }],
  },
  {
    id: 2,
    name: "Away House",
    emergencyContactName: null,
    emergencyContactPhone: null,
    emergencyContacts: [],
    isPresent: false,
    householdMembers: [],
    leads: [],
  },
];

describe("safety/emergency-contacts page", () => {
  it("loads and renders households, pinning present ones first", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/safety/emergency-contacts": { households, building: { reachable: true, lastSeenAt: null } } });
    renderWithProviders(<EmergencyContactsPage />);

    expect(await screen.findByText("Keyholder House")).toBeInTheDocument();
    expect(screen.getByText("Away House")).toBeInTheDocument();
    expect(screen.getByText("Present Now")).toBeInTheDocument();
    expect(screen.getByText("Kid Keyholder")).toBeInTheDocument();
    expect(screen.getByText("Lea Lead")).toBeInTheDocument();
    expect(screen.getByText("Gary Guardian (Uncle)")).toBeInTheDocument();
    expect(screen.getByText("No designated leads found.")).toBeInTheDocument();
    expect(screen.getByText("Not Configured")).toBeInTheDocument();
  });

  it("labels presence unconfirmed when the kiosk is unreachable", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/safety/emergency-contacts": { households, building: { reachable: false, lastSeenAt: null } } });
    renderWithProviders(<EmergencyContactsPage />);

    expect(await screen.findByText("Checked in (unconfirmed)")).toBeInTheDocument();
    expect(screen.queryByText("Present Now")).not.toBeInTheDocument();
  });

  it("filters households by search query", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/safety/emergency-contacts": { households } });
    renderWithProviders(<EmergencyContactsPage />);
    await screen.findByText("Keyholder House");

    fireEvent.change(screen.getByPlaceholderText("Search by Household Name, Parent Name, Member Name, or ID..."), {
      target: { value: "Away" },
    });

    expect(screen.getByText("Away House")).toBeInTheDocument();
    expect(screen.queryByText("Keyholder House")).not.toBeInTheDocument();
  });

  it("shows the failure, not an empty directory, when the load fails", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<EmergencyContactsPage />);

    expect(await screen.findByText("Couldn't load emergency contacts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("No households found matching your search.")).not.toBeInTheDocument();
  });

  it("pins present households first whatever order the route sends", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({ "/api/safety/emergency-contacts": { households: [...households].reverse() } });
    renderWithProviders(<EmergencyContactsPage />);

    const present = await screen.findByText("Keyholder House");
    const away = screen.getByText("Away House");
    expect(present.compareDocumentPosition(away) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
