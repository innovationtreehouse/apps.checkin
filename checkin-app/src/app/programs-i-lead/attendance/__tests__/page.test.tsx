// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: () => mockCounts }));

import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderWithProviders, resetRtl } from "@/test-helpers/rtl";
import { pinTimezone } from "@/test-helpers/tz";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import ProgramsILeadHome from "../page";

const tally = { yes: 0, maybe: 0, no: 0 };
// 9:30 PM Aug 31 in Chicago, 11:30 AM Sep 1 in Tokyo.
const startAt = "2026-09-01T02:30:00.000Z";

let mockCounts: Partial<TodoCounts> = {};

beforeEach(() => {
  resetRtl();
  mockCounts = {
    lead: {
      programs: [
        {
          id: 1,
          name: "Robotics",
          totalEnrolled: 4,
          pending: [],
          upcoming: [{ eventId: 7, name: "Build night", startAt, participants: tally, volunteers: tally }],
        },
      ],
    },
  };
});

const inZone = (zone: string) =>
  function OrgZone({ children }: { children: ReactNode }) {
    return <TimezoneProvider value={zone}>{children}</TimezoneProvider>;
  };

describe("ProgramsILeadHome", () => {
  pinTimezone("America/Chicago");

  it("dates upcoming sessions in the org's zone, not the browser's", () => {
    renderWithProviders(<ProgramsILeadHome />, { wrapper: inZone("Asia/Tokyo") });
    expect(screen.getByText("Sep 1 — Build night")).toBeInTheDocument();
  });
});
