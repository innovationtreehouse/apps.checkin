import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-helpers/rtl";
import EmergencyContactNotice from "@/components/ui/EmergencyContactNotice";
import EmergencyContactForm from "@/components/membership/EmergencyContactForm";

const NOTICE = "Must be someone outside of your family.";

describe("EmergencyContactNotice", () => {
  it("states the outside-the-family rule", () => {
    renderWithProviders(<EmergencyContactNotice />);
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  // The rule is enforced server-side (EmergencyContactError, code "is_member").
  // Applicants used to only meet it as a rejection, so every surface that collects
  // a contact has to state it up front — the shared form is two of those surfaces
  // (membership intake + first-time program intake) and must not lose it.
  it("ships with the shared emergency-contact form", () => {
    renderWithProviders(
      <EmergencyContactForm
        emName="" setEmName={() => {}}
        emPhone="" setEmPhone={() => {}}
        emEmail="" setEmEmail={() => {}}
        errors={{}}
        clearErr={() => {}}
      />,
    );
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByLabelText(/Emergency contact name/)).toBeInTheDocument();
  });
});
