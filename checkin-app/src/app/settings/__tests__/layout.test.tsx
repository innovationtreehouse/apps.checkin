import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SettingsLayout from "../layout";

const push = jest.fn();
let mockSession: { data: unknown; status: string };
let mockPathname = "/settings/membership";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => mockPathname,
}));
jest.mock("next-auth/react", () => ({
  useSession: () => mockSession,
}));

const CHILD = "child-marker";
const renderLayout = (session: { data: unknown; status: string }) => {
  mockSession = session;
  return render(
    <MantineProvider>
      <SettingsLayout>
        <div>{CHILD}</div>
      </SettingsLayout>
    </MantineProvider>,
  );
};

beforeEach(() => {
  push.mockClear();
  mockPathname = "/settings/membership";
});

describe("SettingsLayout role gate", () => {
  it("admits a sysadmin (chrome-less passthrough)", () => {
    renderLayout({ data: { user: { id: 1, isSysadmin: true } }, status: "authenticated" });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("admits a board member", () => {
    renderLayout({ data: { user: { id: 2, isBoardMember: true } }, status: "authenticated" });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows a loader while the session resolves", () => {
    renderLayout({ data: null, status: "loading" });
    expect(screen.getByText("Verifying access...")).toBeInTheDocument();
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
  });

  it("redirects an authenticated user with neither role", () => {
    renderLayout({ data: { user: { id: 3 } }, status: "authenticated" });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("redirects unauthenticated callers", () => {
    renderLayout({ data: null, status: "unauthenticated" });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });
});

describe("SettingsLayout on Finance", () => {
  beforeEach(() => {
    mockPathname = "/settings/finance";
  });

  it.each([
    ["FINANCE", { id: 4, isFinance: true }],
    ["a board member", { id: 2, isBoardMember: true }],
  ])("admits %s", (_who, user) => {
    renderLayout({ data: { user }, status: "authenticated" });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it.each([
    ["a sysadmin", { id: 1, isSysadmin: true }],
    ["operations", { id: 5, isOperations: true }],
  ])("redirects %s", (_who, user) => {
    renderLayout({ data: { user }, status: "authenticated" });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("keeps FINANCE off the other settings pages", () => {
    mockPathname = "/settings/membership";
    renderLayout({ data: { user: { id: 4, isFinance: true } }, status: "authenticated" });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });
});
