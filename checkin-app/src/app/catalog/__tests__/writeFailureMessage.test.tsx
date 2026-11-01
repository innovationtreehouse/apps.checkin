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

function answerAcceptWith(accept: () => Promise<Response>) {
  global.fetch = jest.fn((_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST" ? accept() : Promise.resolve(new Response(JSON.stringify([CHALLENGE]), { status: 200 })),
  );
}

async function clickAccept() {
  renderWithProviders(<ConversionChallengesClient />);
  fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
  await waitFor(() => expect(notificationsStore.getState().notifications).toHaveLength(1));
  return notificationsStore.getState().notifications[0];
}

beforeEach(() => resetRtl());
afterEach(() => act(() => notifications.clean()));

describe("a failed catalog write", () => {
  it("shows the server's words and stays until dismissed", async () => {
    answerAcceptWith(() => Promise.resolve(new Response(JSON.stringify({ error: "Challenge already resolved" }), { status: 409 })));
    expect(await clickAccept()).toMatchObject({ message: "Challenge already resolved", color: "red", autoClose: false });
  });

  it("shows fixed text, not the exception's, when the failure is not the server's", async () => {
    answerAcceptWith(() => Promise.reject(new TypeError("fetch failed: ECONNRESET 10.0.0.5")));
    expect(await clickAccept()).toMatchObject({ message: "Something went wrong. Try again.", color: "red", autoClose: false });
  });
});
