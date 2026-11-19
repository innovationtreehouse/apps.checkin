jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
import { ConversionChallengesClient } from "@checkin/global-catalog/components";
import { renderWithProviders, resetRtl } from "@/test-helpers/rtl";

const CHALLENGE = {
  id: 7,
  orgName: "Treehouse",
  currentFactor: 1,
  proposedFactor: 2,
  reason: "Sold in pairs",
  createdAt: "2026-10-01T00:00:00Z",
  itemReference: { partNumber: "P-1", descriptionNormalized: null, manufacturer: null, gtin13: "2000000000015", item: { name: "Bolt" } },
};

beforeEach(() => {
  resetRtl();
  global.fetch = jest.fn((_url: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(init?.method === "POST" ? {} : [CHALLENGE]), { status: 200 })),
  );
});
afterEach(() => act(() => notifications.clean()));

describe("a catalog rejection that worked", () => {
  it("reads as a success: green, polite, and goes away by itself", async () => {
    renderWithProviders(<ConversionChallengesClient />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(notificationsStore.getState().notifications).toHaveLength(1));
    const shown = notificationsStore.getState().notifications[0];
    expect(shown).toMatchObject({ message: "Challenge rejected", color: "green", role: "status" });
    expect(shown.autoClose).not.toBe(false);
  });
});
