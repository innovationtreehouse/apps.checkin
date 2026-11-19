import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-helpers/rtl";
import ProgramDetailsCard from "../ProgramDetailsCard";
import type { ProgramDetail } from "../useProgramEnrollment";

const program: ProgramDetail = {
  id: 1, name: "Robotics", startAt: "2099-09-01", endAt: "2099-12-01", leadMentorId: null, phase: "PLANNING",
  maxParticipants: null, enrollmentStatus: "OPEN", enrollmentClosedBy: null,
  orgMemberPriceCents: 4000, nonOrgMemberPriceCents: 5000, shopifyVariantId: null,
  minAge: null, maxAge: null, orgMemberOnly: false,
};

const renderCard = (p: ProgramDetail) => renderWithProviders(
  <ProgramDetailsCard program={p} ageRange={null} enrolledCount={0} isFull={false} myEnrolled={[]} seesPayment isClosed={false} hasEnded={false} onPayNow={() => {}} />,
);

describe("ProgramDetailsCard prices", () => {
  it("shows both prices on an open program", () => {
    renderCard(program);
    expect(screen.getByText("Non-Member Price:")).toBeInTheDocument();
  });

  it("hides a stored non-member price on a members-only program", () => {
    renderCard({ ...program, orgMemberOnly: true });
    expect(screen.queryByText("Non-Member Price:")).not.toBeInTheDocument();
    expect(screen.getByText("Treehouse Member Price:")).toBeInTheDocument();
  });

  it("calls a members-only program free when members pay nothing", () => {
    renderCard({ ...program, orgMemberOnly: true, orgMemberPriceCents: 0 });
    expect(screen.getByText("Cost:")).toBeInTheDocument();
  });
});
