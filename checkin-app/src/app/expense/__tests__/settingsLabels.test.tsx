import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SettingsPage from "@checkin/expense/pages/settings";

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: () => ({
    data: {
      capitalEquipmentUnitCents: 50_000,
      boardReviewTotalCents: 200_000,
      capitalTotalThresholdCents: 0,
      capitalLineItemThresholdCents: 0,
    },
    error: null,
    reload: () => {},
  }),
  send: jest.fn(),
}));

beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);
});

describe("Capital review labels on the expense settings page", () => {
  it("name what each threshold compares, with no 0 = off", () => {
    render(<MantineProvider><SettingsPage /></MantineProvider>);
    expect(screen.getByLabelText("Capital review: receipt total over")).toBeInTheDocument();
    expect(screen.getByLabelText("Capital review: unit price over")).toBeInTheDocument();
    expect(screen.queryByText(/0 = off/)).not.toBeInTheDocument();
  });
});
