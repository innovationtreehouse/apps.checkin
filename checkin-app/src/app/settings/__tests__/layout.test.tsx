import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-helpers/rtl";
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
let mockCounts: unknown = null;
jest.mock("@/hooks/useTodoCounts", () => ({
  useTodoCounts: () => mockCounts,
}));

const CHILD = "child-marker";
const renderLayout = (session: { data: unknown; status: string }) => {
  mockSession = session;
  return renderWithProviders(
    <SettingsLayout>
      <div>{CHILD}</div>
    </SettingsLayout>,
  );
};

beforeEach(() => {
  push.mockClear();
  mockPathname = "/settings/membership";
  mockCounts = null;
});

const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);

describe("SettingsLayout tab bar", () => {
  it("shows a board member every settings page they may open, Expenses and Receipt reading included", () => {
    renderLayout({ data: { user: { id: 2, isBoardMember: true } }, status: "authenticated" });
    expect(tabNames()).toEqual(["Membership Settings", "Email Settings", "Outreach", "Shopify Webhook", expect.stringContaining("Expenses"), "Receipt reading"]);
  });

  it("keeps Localization from a board member who is not sysadmin", () => {
    renderLayout({ data: { user: { id: 2, isBoardMember: true } }, status: "authenticated" });
    expect(tabNames()).not.toContain("Localization");
  });

  it("shows a sysadmin Localization and no Expenses", () => {
    renderLayout({ data: { user: { id: 1, isSysadmin: true } }, status: "authenticated" });
    expect(tabNames()).toContain("Localization");
    expect(tabNames().some((n) => n?.includes("Expenses"))).toBe(false);
  });

  it("renders on the expense settings page with Expenses active", () => {
    mockPathname = "/settings/finance";
    renderLayout({ data: { user: { id: 2, isBoardMember: true } }, status: "authenticated" });
    expect(screen.getByRole("tab", { name: /Expenses/ })).toHaveAttribute("aria-selected", "true");
  });

  it("pills Membership Settings when a required membership setting is unset", () => {
    mockCounts = { admin: { settingsMisconfig: 2 } };
    renderLayout({ data: { user: { id: 2, isBoardMember: true } }, status: "authenticated" });
    expect(screen.getByLabelText("2 required membership settings not configured")).toBeInTheDocument();
  });
});

describe("SettingsLayout role gate", () => {
  it("admits a sysadmin", () => {
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

describe("SettingsLayout on the bare /settings path", () => {
  beforeEach(() => {
    mockPathname = "/settings";
  });

  it.each([
    ["FINANCE", { id: 4, isFinance: true }],
    ["a sysadmin", { id: 1, isSysadmin: true }],
    ["a board member", { id: 2, isBoardMember: true }],
    ["operations", { id: 5, isOperations: true }],
  ])("admits %s so the index page can redirect them", (_who, user) => {
    renderLayout({ data: { user }, status: "authenticated" });
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("redirects a user with no settings role", () => {
    renderLayout({ data: { user: { id: 3 } }, status: "authenticated" });
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/");
  });

  it.each(["/settings/membership", "/settings/localization", "/settings/email", "/settings/outreach", "/settings/shopify-webhook"])(
    "still keeps FINANCE off %s",
    (path) => {
      mockPathname = path;
      renderLayout({ data: { user: { id: 4, isFinance: true } }, status: "authenticated" });
      expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
      expect(push).toHaveBeenCalledWith("/");
    },
  );
});
