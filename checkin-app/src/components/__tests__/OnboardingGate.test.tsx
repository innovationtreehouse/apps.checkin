// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import OnboardingGate from "../OnboardingGate";

const CHILD = "child-marker";
const renderGate = () =>
  renderWithProviders(
    <OnboardingGate>
      <div>{CHILD}</div>
    </OnboardingGate>,
  );

beforeEach(() => {
  resetRtl();
  sessionStorage.clear();
});

describe("OnboardingGate", () => {
  it("lets a signed-in, fully-onboarded user through with no modal", async () => {
    setSession({ id: 1 });
    mockFetchJson({ "/api/profile/onboarding-status": { needsPhone: false, needsEmergencyContact: false } });
    renderGate();

    expect(screen.getByText(CHILD)).toBeInTheDocument();
    // Give the status fetch a tick to resolve, then confirm the modal never opens.
    await waitFor(() => expect(screen.queryByText("Action Required")).not.toBeInTheDocument());
  });

  it("shows only the household question while it is open, naming only the household", async () => {
    setSession({ id: 1, householdJoinPending: true });
    const fetchSpy = mockFetchJson({ "/api/profile/household-question": { householdName: "Rivera Household" } });
    renderGate();

    expect(await screen.findByText(/Rivera Household/)).toBeInTheDocument();
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/profile/onboarding-status", expect.anything());
  });

  it("renders children immediately (no fetch) when unauthenticated", () => {
    setSession(null);
    const fetchSpy = mockFetchJson({});
    renderGate();

    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks with the onboarding modal when the profile needs a phone number", async () => {
    setSession({ id: 1 });
    mockFetchJson({ "/api/profile/onboarding-status": { needsPhone: true, needsEmergencyContact: false } });
    renderGate();

    expect(await screen.findByText("Action Required")).toBeInTheDocument();
    expect(screen.getByLabelText(/Your Phone Number/i)).toBeInTheDocument();
    expect(screen.queryByText("Household Emergency Contact")).not.toBeInTheDocument();
  });

  it("submits a valid phone and POSTs onboarding data", async () => {
    setSession({ id: 1 });
    const fetchSpy = mockFetchJson({
      "/api/profile/onboarding-status": { needsPhone: true, needsEmergencyContact: false },
      "/api/profile/onboarding": { ok: true },
    });
    renderGate();

    await screen.findByText("Action Required");
    fireEvent.change(screen.getByLabelText(/Your Phone Number/i), { target: { value: "5551234567" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & Continue/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/profile/onboarding",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("shows a validation error instead of submitting an invalid phone", async () => {
    setSession({ id: 1 });
    const fetchSpy = mockFetchJson({
      "/api/profile/onboarding-status": { needsPhone: true, needsEmergencyContact: false },
    });
    renderGate();

    await screen.findByText("Action Required");
    fireEvent.change(screen.getByLabelText(/Your Phone Number/i), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & Continue/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid 10-digit US phone number.");
    // Only the initial status fetch happened; the invalid submit never posted.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("'Ask me next time' dismisses the modal and remembers the skip in sessionStorage", async () => {
    setSession({ id: 1 });
    mockFetchJson({ "/api/profile/onboarding-status": { needsPhone: true, needsEmergencyContact: false } });
    renderGate();

    await screen.findByText("Action Required");
    fireEvent.click(screen.getByRole("button", { name: /Ask me next time/i }));

    // Mantine's Modal unmounts its content after an exit transition (not instant in jsdom).
    await waitFor(() => expect(screen.queryByText("Action Required")).not.toBeInTheDocument());
    expect(sessionStorage.getItem("onboarding_skipped")).toBe("true");
  });
});
