// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
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

  it("shows an error state when the fetch fails", async () => {
    setSession({ id: 1, isSysadmin: true });
    mockFetchJson({});
    renderWithProviders(<EmergencyContactsPage />);

    expect(await screen.findByText(/Failed to load emergency contacts/)).toBeInTheDocument();
  });

  it("toasts a network-error notification when the fetch rejects", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    setSession({ id: 1, isSysadmin: true });
    global.fetch = jest.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    renderWithProviders(<EmergencyContactsPage />);

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "Network error loading contacts." }),
      ),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Failed to load"), expect.anything());
    spy.mockRestore();
  });
});
