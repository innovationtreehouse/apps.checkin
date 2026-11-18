// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@/lib/dev/actions", () => ({
  macroFamily: jest.fn(),
  macroProgram: jest.fn(),
  macroEvent: jest.fn(),
  macroCheckins: jest.fn(),
  resetDevInstance: jest.fn(),
  getRecentActivity: jest.fn(),
}));

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { getRecentActivity } from "@/lib/dev/actions";
import { renderWithProviders, resetRtl, setCheckinEnv, setSession } from "@/test-helpers/rtl";
import { jsonBody } from "@/test-helpers/jsonBody";
import DevDashboard from "../DevDashboard";

const activity = getRecentActivity as jest.Mock;

beforeEach(() => {
  resetRtl();
  setCheckinEnv("dev");
  setSession({ id: 1, name: "Dee Dev" });
  activity.mockReset().mockResolvedValue([]);
});

const openPanel = () => fireEvent.click(screen.getByRole("button", { name: "Open the dev panel" }));

describe("DevDashboard failed loads", () => {
  it("says the personas could not load instead of saying there are none, and Retry lists them", async () => {
    let fails = true;
    global.fetch = jest.fn(async () => (fails
      ? { ok: false, status: 403, ...jsonBody({ error: "Forbidden" }) }
      : { ok: true, status: 200, ...jsonBody({ personas: [{ id: 7, email: "parent.family2@example.com", name: "Pat Parent" }] }) }) as Response,
    ) as unknown as typeof fetch;
    renderWithProviders(<DevDashboard />);
    openPanel();

    expect(await screen.findByText("Couldn't load the test personas")).toBeInTheDocument();
    expect(screen.queryByText(/No personas yet/)).not.toBeInTheDocument();

    fails = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Pat Parent/)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load the test personas")).not.toBeInTheDocument();
  });

  it("says recent activity could not load, warns before a reset, and Retry shows it", async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, ...jsonBody({ personas: [] }) }) as Response) as unknown as typeof fetch;
    activity.mockRejectedValueOnce(new Error("boom"));
    renderWithProviders(<DevDashboard />);
    openPanel();

    expect(await screen.findByText("Couldn't load the recent activity")).toBeInTheDocument();
    expect(screen.queryByText("No recorded activity yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reset dev instance/ }));
    expect(screen.getByText(/Recent activity couldn't be checked/)).toBeInTheDocument();

    activity.mockResolvedValueOnce([{ action: "login", realActor: "sam@example.com", detail: null, createdAt: new Date().toISOString() }]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getAllByText(/sam@example.com signed in/).length).toBeGreaterThan(0));
    expect(screen.queryByText("Couldn't load the recent activity")).not.toBeInTheDocument();
  });
});
