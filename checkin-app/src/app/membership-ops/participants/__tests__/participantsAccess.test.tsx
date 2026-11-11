jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));

import { waitFor } from "@testing-library/react";
import { mockFetchJson, renderWithProviders, resetRtl, router, setSession } from "@/test-helpers/rtl";
import AdminParticipantsIndex from "../page";

beforeEach(() => resetRtl());

describe("AdminParticipantsIndex access", () => {
  it.each([
    ["reviewer-only", { isBackgroundCheckReviewer: true }],
    ["reviewer and keyholder", { isBackgroundCheckReviewer: true, isKeyholder: true }],
  ])("refuses a %s person without searching", async (_who, roles) => {
    setSession({ id: 1, ...roles });
    const fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("no network in tests"));
    renderWithProviders(<AdminParticipantsIndex />);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it.each([
    ["sysadmin", { isSysadmin: true }],
    ["board member", { isBoardMember: true }],
    ["operations", { isOperations: true }],
    ["reviewer who is also on the board", { isBackgroundCheckReviewer: true, isBoardMember: true }],
    ["reviewer who is also in operations", { isBackgroundCheckReviewer: true, isOperations: true }],
  ])("admits a %s", async (_who, roles) => {
    setSession({ id: 1, ...roles });
    mockFetchJson({ "/api/people/search": { people: [] } });
    renderWithProviders(<AdminParticipantsIndex />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(router.push).not.toHaveBeenCalled();
  });
});
