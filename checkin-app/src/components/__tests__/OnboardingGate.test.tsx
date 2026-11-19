// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import OnboardingGate, { needsAgeStep } from "../OnboardingGate";

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
    const fetchSpy = mockFetchJson({ "/api/profile/household-question": { household: { name: "Rivera Household" } } });
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

  it("flags an invalid phone on its field and does not submit", async () => {
    setSession({ id: 1 });
    const fetchSpy = mockFetchJson({
      "/api/profile/onboarding-status": { needsPhone: true, needsEmergencyContact: false },
    });
    renderGate();

    await screen.findByText("Action Required");
    const field = screen.getByLabelText(/Your Phone Number/i);
    fireEvent.change(field, { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & Continue/i }));

    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveFocus();
    expect(screen.getByText("Enter a valid 10-digit US phone number.")).toBeInTheDocument();
    // Only the initial status fetch happened; the invalid submit never posted.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("flags a bad emergency contact email on its field and does not submit", async () => {
    setSession({ id: 1 });
    const fetchSpy = mockFetchJson({
      "/api/profile/onboarding-status": { needsPhone: false, needsEmergencyContact: true },
    });
    renderGate();

    await screen.findByText("Action Required");
    fireEvent.change(screen.getByLabelText(/Contact Name/i), { target: { value: "Jane Doe" } });
    fireEvent.change(screen.getByLabelText(/Contact Phone/i), { target: { value: "5559876543" } });
    const email = screen.getByLabelText(/Contact Email/i);
    fireEvent.change(email, { target: { value: "jane@example" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & Continue/i }));

    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveFocus();
    expect(screen.getByLabelText(/Contact Phone/i)).not.toHaveAttribute("aria-invalid", "true");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("puts a server refusal on the input it names and clears it on change", async () => {
    setSession({ id: 1 });
    const reply = (status: number, body: unknown) =>
      ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) }) as Response;
    global.fetch = jest.fn(async (input: RequestInfo | URL) =>
      String(input).includes("onboarding-status")
        ? reply(200, { needsPhone: false, needsEmergencyContact: true })
        : reply(400, { error: "A server phone message.", fields: ["emergencyContactPhone"] }),
    ) as unknown as typeof fetch;
    renderGate();

    await screen.findByText("Action Required");
    fireEvent.change(screen.getByLabelText(/Contact Name/i), { target: { value: "Jane Doe" } });
    const phone = screen.getByLabelText(/Contact Phone/i);
    fireEvent.change(phone, { target: { value: "5559876543" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & Continue/i }));

    expect(await screen.findByText("A server phone message.")).toBeInTheDocument();
    expect(phone).toHaveAttribute("aria-invalid", "true");
    expect(phone).toHaveFocus();
    expect(screen.getByLabelText(/Contact Name/i)).not.toHaveAttribute("aria-invalid", "true");

    fireEvent.change(phone, { target: { value: "5559876544" } });
    expect(phone).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("A server phone message.")).not.toBeInTheDocument();
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

  describe("age step", () => {
    it("shows only the age step while the session owes its first age", () => {
      setSession({ id: 1, ageStepPending: true });
      mockFetchJson({ "/api/profile/onboarding-status": { needsPhone: false, needsEmergencyContact: false } });
      renderGate();

      expect(screen.getByText("Your date of birth")).toBeInTheDocument();
      expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Sign out/i })).toBeInTheDocument();
    });

    it("refuses an empty answer without calling the server", () => {
      setSession({ id: 1, ageStepPending: true });
      const fetchSpy = mockFetchJson({ "/api/profile/onboarding-status": { needsPhone: false, needsEmergencyContact: false } });
      renderGate();

      fireEvent.click(screen.getByRole("button", { name: /Save & continue/i }));
      expect(screen.getByText(/Enter your date of birth/)).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalledWith("/api/profile", expect.anything());
    });

    it("saves an over-25 declaration through the profile endpoint", async () => {
      setSession({ id: 1, ageStepPending: true });
      const fetchSpy = mockFetchJson({
        "/api/profile/onboarding-status": { needsPhone: false, needsEmergencyContact: false },
        "/api/profile": { profile: {} },
      });
      renderGate();

      fireEvent.click(screen.getByLabelText("I am over 25"));
      fireEvent.click(screen.getByRole("button", { name: /Save & continue/i }));

      await waitFor(() =>
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/profile",
          expect.objectContaining({ method: "PATCH", body: JSON.stringify({ dob: null, over25: true }) }),
        ),
      );
    });

    it("applies only to someone who created a new household and has no age yet", () => {
      expect(needsAgeStep({ ageStepPending: true })).toBe(true);
      expect(needsAgeStep({ ageStepPending: false })).toBe(false);
      expect(needsAgeStep({})).toBe(false);
      expect(needsAgeStep({ ageStepPending: true, denied: true })).toBe(false);
      expect(needsAgeStep({ ageStepPending: true, householdJoinPending: true })).toBe(false);
      expect(needsAgeStep(undefined)).toBe(false);
    });
  });
});
