// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: jest.fn(() => null) }));

import { screen, fireEvent } from "@testing-library/react";
import {
  renderWithProviders,
  setSession,
  setPathname,
  setSearchParams,
  router,
  resetRtl,
} from "@/test-helpers/rtl";
import { signIn, signOut } from "next-auth/react";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import AppFrame from "../AppFrame";

const mockedUseTodoCounts = useTodoCounts as jest.Mock;

beforeEach(() => {
  resetRtl();
  mockedUseTodoCounts.mockReturnValue(null);
});

const renderFrame = () => renderWithProviders(<AppFrame>{<div>PAGE CONTENT</div>}</AppFrame>);

describe("AppFrame", () => {
  it("renders core nav items for a signed-in non-admin, hides admin-only sections", async () => {
    setSession({ id: 1 });
    renderFrame();

    expect(await screen.findByText("PAGE CONTENT")).toBeInTheDocument();
    expect(screen.getByText("My Household")).toBeInTheDocument();
    expect(screen.getByText("My Activities")).toBeInTheDocument();
    expect(screen.getByText("Attendance")).toBeInTheDocument();
    expect(screen.getByText("Programs")).toBeInTheDocument();
    expect(screen.getByText("Communication")).toBeInTheDocument();
    expect(screen.getByText("Index")).toBeInTheDocument();

    // Role-gated sections stay hidden for a plain signed-in user.
    expect(screen.queryByText("Safety")).not.toBeInTheDocument();
    expect(screen.queryByText("Shop Ops")).not.toBeInTheDocument();
    expect(screen.queryByText("Facility Ops")).not.toBeInTheDocument();
    expect(screen.queryByText("Membership Ops")).not.toBeInTheDocument();
    expect(screen.queryByText("Program Ops")).not.toBeInTheDocument();

    expect(screen.getAllByRole("button", { name: /Sign Out/i }).length).toBeGreaterThan(0);
  });

  it("shows admin-only sections for a sysadmin", () => {
    setSession({ id: 1, isSysadmin: true });
    renderFrame();

    expect(screen.getByText("Safety")).toBeInTheDocument();
    expect(screen.getByText("Shop Ops")).toBeInTheDocument();
    expect(screen.getByText("Facility Ops")).toBeInTheDocument();
    expect(screen.getByText("Membership Ops")).toBeInTheDocument();
    expect(screen.getByText("Membership Audit")).toBeInTheDocument();
    expect(screen.getByText("Program Ops")).toBeInTheDocument();
    // Revenue Ops admits FINANCE or BOARD — a sysadmin does NOT see it (issue #1083).
    expect(screen.queryByText("Revenue Ops")).not.toBeInTheDocument();
    expect(screen.getByText("System Status")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("shows Revenue Ops (the renamed Finance Ops) to a board member", () => {
    setSession({ id: 1, isBoardMember: true });
    renderFrame();

    expect(screen.getByText("Revenue Ops")).toBeInTheDocument();
    expect(screen.queryByText("Finance Ops")).not.toBeInTheDocument();
    expect(screen.getByText("Revenue Ops").closest("a")).toHaveAttribute("href", "/finance-ops/payment-plan");
  });

  it("shows Shop Ops for a certifier without admin flags, and My Programs when leading a program", () => {
    setSession({ id: 2, toolStatuses: [{ level: "MAY_CERTIFY_OTHERS" }] });
    mockedUseTodoCounts.mockReturnValue({
      member: { household: [], programs: [], programsAwaitingFinance: 0 },
      building: 0,
      buildingHousehold: 0,
      activePrograms: 0,
      lead: { programs: [{ id: 9, pending: [] }] },
    });
    renderFrame();

    expect(screen.getByText("Shop Ops")).toBeInTheDocument();
    expect(screen.getByText("My Programs")).toBeInTheDocument();
    expect(screen.queryByText("Facility Ops")).not.toBeInTheDocument();
  });

  it("shows Membership Ops to a reviewer-only user, linking straight to the Review tab", () => {
    setSession({ id: 3, isBackgroundCheckReviewer: true });
    renderFrame();

    const link = screen.getByText("Membership Ops").closest("a");
    expect(link).toHaveAttribute("href", "/membership-ops/review");
    // Reviewer-only: the admin-gated siblings stay hidden.
    expect(screen.queryByText("Membership Audit")).not.toBeInTheDocument();
  });

  it("shows Facility Ops to an operations-only user (#1633's aggregate-tools grant)", () => {
    setSession({ id: 4, isOperations: true });
    renderFrame();

    expect(screen.getByText("Facility Ops")).toBeInTheDocument();
    // Operations-only: the board-only sections stay hidden — the entry appeared
    // because of the union, not because the gate got sloppy.
    expect(screen.queryByText("Membership Audit")).not.toBeInTheDocument();
  });

  it("badges the reviewer-only Membership Ops nav with the green can-act-on count", () => {
    setSession({ id: 3, isBackgroundCheckReviewer: true });
    mockedUseTodoCounts.mockReturnValue({
      member: { household: [], programs: [], programsAwaitingFinance: 0 },
      building: 0,
      buildingHousehold: 0,
      activePrograms: 0,
      review: { canActOn: 4, approvedAwaitingSecond: 0 },
    });
    renderFrame();

    // Badge keys off the section href (/membership-ops), not the per-role /review
    // destination — the green count must reach a reviewer-only user's nav item.
    // The green pill merges the board queue (0 here) and can-act-on (4) into one,
    // so its aria-label names both parts and the count is their sum.
    expect(screen.getByLabelText("0 pending membership reviews; 4 background checks you can review now")).toHaveTextContent("4");
  });

  it("highlights the active nav item based on pathname", () => {
    setSession({ id: 1 });
    setPathname("/attendance");
    renderFrame();

    const attendanceLink = screen.getByText("Attendance").closest("a");
    const programsLink = screen.getByText("Programs").closest("a");
    expect(attendanceLink).toHaveAttribute("data-active", "true");
    expect(programsLink).not.toHaveAttribute("data-active");
  });

  it("renders full-screen with no chrome in kiosk mode", () => {
    setSession({ id: 1 });
    setSearchParams("mode=kiosk");
    renderFrame();

    expect(screen.getByText("PAGE CONTENT")).toBeInTheDocument();
    expect(screen.queryByText("Attendance")).not.toBeInTheDocument();
    expect(screen.queryByText("Sign Out")).not.toBeInTheDocument();
  });

  it("hides the nav sidebar (but still shows sign-in) on the signed-out homepage", () => {
    setSession(null);
    setPathname("/");
    renderFrame();

    expect(screen.queryByText("Programs")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sign In To Dashboard/i })).toBeInTheDocument();
  });

  it("shows the nav (Programs visible to everyone) when signed out on a non-home path", () => {
    setSession(null);
    setPathname("/programs");
    renderFrame();

    expect(screen.getByText("Programs")).toBeInTheDocument();
    expect(screen.queryByText("My Household")).not.toBeInTheDocument();
  });

  it("sign-out button calls signOut with the home callback", async () => {
    setSession({ id: 1 });
    renderFrame();

    fireEvent.click(screen.getAllByRole("button", { name: /Sign Out/i })[0]);
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/" });
  });

  it("sign-in button calls signIn('google')", async () => {
    setSession(null);
    setPathname("/attendance");
    renderFrame();

    fireEvent.click(screen.getAllByRole("button", { name: /Sign In To Dashboard/i })[0]);
    expect(signIn).toHaveBeenCalledWith("google");
  });

  it("clicking a nav link does not block navigation (no unsaved changes)", () => {
    setSession({ id: 1 });
    renderFrame();

    const link = screen.getByText("Programs").closest("a")!;
    fireEvent.click(link);
    // No confirm/guard is registered, so clicking just leaves router untouched here
    // (Link handles real navigation in the browser) — this exercises guardNav's
    // pass-through branch without throwing.
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("AppFrame library release gate", () => {
  const countsWith = (releasedLibraries: string[]) => ({
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    activePrograms: 0,
    releasedLibraries,
  });

  it("hides the Inventory entry from a non-board catalog viewer while unreleased", () => {
    setSession({ id: 3, isKeyholder: true });
    mockedUseTodoCounts.mockReturnValue(countsWith([]));
    renderFrame();
    expect(screen.queryByText("Inventory")).not.toBeInTheDocument();
  });

  it("shows the Inventory entry to a non-board catalog viewer once released", () => {
    setSession({ id: 3, isKeyholder: true });
    mockedUseTodoCounts.mockReturnValue(countsWith(["catalog"]));
    renderFrame();
    expect(screen.getByText("Inventory")).toBeInTheDocument();
  });

  it("always shows the Inventory entry to a board member", () => {
    setSession({ id: 4, isBoardMember: true });
    mockedUseTodoCounts.mockReturnValue(countsWith([]));
    renderFrame();
    expect(screen.getByText("Inventory")).toBeInTheDocument();
  });
});
