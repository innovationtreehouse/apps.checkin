import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import ReceiptDetailPage from "@checkin/receipt/pages/detail";

const mockApi = jest.fn();
const mockReceipt = {
  id: "r1", uploadedAt: "2026-10-01T00:00:00Z", uploadedByUserId: 1, retailer: "Acme", receiptDate: "2026-10-01",
  receiptTotalCents: 1000, taxCents: 0, shippingCents: 0, discountCents: 0, mimeType: "image/png", rotation: 0,
  state: "submitter_review", needsReimbursement: false, isInKind: false, financialReviewReasons: [], lineItems: [],
};

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "r1" }),
  usePathname: () => "/receipts/r1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 1, ageBand: "adult" } } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
jest.mock("@checkin/receipt/components/ReceiptEditor", () => ({ __esModule: true, default: () => <div /> }));
jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  api: (...args: unknown[]) => mockApi(...args),
  useLoad: (path: string | null) => ({
    data: path === "/r1" ? mockReceipt : path === null ? null : path.endsWith("/duplicate-group") ? { members: [], dismissed: [] } : [],
    error: null,
    reload: jest.fn(),
  }),
  useRoles: () => ({ isFinance: false, isBoard: false }),
  send: jest.fn(),
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
});

beforeEach(() => {
  mockApi.mockReset();
  jest.mocked(notifications.show).mockReset();
});

const shown = () => render(<MantineProvider><ReceiptDetailPage /></MantineProvider>);
const turn = () => screen.getByRole("img", { name: "Receipt" }).style.transform;
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};
const saved = (rotation: number) => ["/r1/rotation", { method: "PUT", body: JSON.stringify({ rotation }) }];

it("cycles through 90, 180, 270 and back to 0, saving each turn", async () => {
  mockApi.mockResolvedValue({});
  shown();
  for (const rotation of [90, 180, 270]) {
    await click("Rotate right");
    expect(turn()).toBe(`rotate(${rotation}deg)`);
    expect(mockApi).toHaveBeenLastCalledWith(...saved(rotation));
  }
  await click("Rotate right");
  expect(turn()).toBe("");
  expect(mockApi).toHaveBeenLastCalledWith(...saved(0));
  await click("Rotate left");
  expect(turn()).toBe("rotate(270deg)");
  expect(mockApi).toHaveBeenLastCalledWith(...saved(270));
});

it("reverts the turn and shows a red notification when the save fails", async () => {
  mockApi.mockRejectedValue(new Error("nope"));
  shown();
  await click("Rotate right");
  expect(turn()).toBe("");
  expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't save the rotation", color: "red" }));
});
