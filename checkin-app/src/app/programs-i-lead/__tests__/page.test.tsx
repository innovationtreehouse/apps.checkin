// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { redirect } from "next/navigation";
import { resetRtl } from "@/test-helpers/rtl";
import ProgramsILeadIndex from "../page";

beforeEach(() => resetRtl());

describe("ProgramsILeadIndex", () => {
  it("redirects to /programs-i-lead/attendance", () => {
    // Sync redirect-only server component (returns void) — call it, don't render as JSX.
    ProgramsILeadIndex();
    expect(redirect).toHaveBeenCalledWith("/programs-i-lead/attendance");
  });
});
