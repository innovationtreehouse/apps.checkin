import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { LifecycleDriftPanel } from "../LifecycleDriftPanel";

beforeEach(() => resetRtl());

const ROUTE = "/api/system-status/lifecycle";
const violation = { model: "ProgramParticipant", key: "program 3 / person 9", status: "PENDING", invariant: "I1" };

describe("LifecycleDriftPanel", () => {
  it("lists each off-diagram row with the scanned count", async () => {
    mockFetchJson({ [ROUTE]: { violations: [violation], scanned: 40 } });
    renderWithProviders(<LifecycleDriftPanel />);

    expect(await screen.findByText(/1 off-diagram of 40 scanned/)).toBeInTheDocument();
    expect(screen.getByText("I1")).toBeInTheDocument();
    expect(screen.getByText("program 3 / person 9")).toBeInTheDocument();
    expect(screen.getByText("status PENDING")).toBeInTheDocument();
  });

  it("reads clean when no row is off-diagram", async () => {
    mockFetchJson({ [ROUTE]: { violations: [], scanned: 40 } });
    renderWithProviders(<LifecycleDriftPanel />);

    expect(await screen.findByText(/No off-diagram rows/)).toBeInTheDocument();
    expect(screen.getByText(/Scanned 40 enrollment/)).toBeInTheDocument();
  });

  it("shows a load error, not a false all-clear", async () => {
    mockFetchJson({});
    renderWithProviders(<LifecycleDriftPanel />);

    expect(await screen.findByText("Couldn't load lifecycle status")).toBeInTheDocument();
    expect(screen.queryByText(/No off-diagram rows/)).not.toBeInTheDocument();
  });

  it("Retry clears the error and shows the reloaded data", async () => {
    mockFetchJson({});
    renderWithProviders(<LifecycleDriftPanel />);
    await screen.findByText("Couldn't load lifecycle status");

    mockFetchJson({ [ROUTE]: { violations: [], scanned: 40 } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText(/No off-diagram rows/)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load lifecycle status")).not.toBeInTheDocument();
  });
});
