import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ViewerProvider } from "@checkin/component-ui";
import ReceiptDetailPage from "@checkin/receipt/pages/detail";

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "r1" }),
  useSearchParams: () => new URLSearchParams("queue=duplicate_flagged"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 2 } } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
jest.mock("@checkin/receipt/components/ReceiptFile", () => ({ __esModule: true, default: () => <figure /> }));
jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  useRoles: () => ({ isFinance: true, isBoard: false }),
}));

const receipt = (id: string, receiptNumber: string, state: string, uploadedByUserId: number) => ({
  id, uploadedAt: "2026-10-02T00:00:00Z", uploadedByUserId, fileHash: `${id}-hash`, mimeType: "application/pdf",
  retailer: "Acme", receiptDate: "2026-10-01", receiptNumber, orderNumber: null, currency: "USD",
  receiptTotalCents: 1000, taxCents: 80, shippingCents: 0, discountCents: 0, state,
  needsReimbursement: false, isInKind: false, duplicateSuspectReceiptId: null, financialReviewReasons: [], lineItems: [],
});
const group = (...ids: string[]) => ({ members: ids.map((id) => ({ id, state: "duplicate_flagged", label: id })), dismissed: [] });
const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

it("once a dismissed match leaves, the next column offers no decision until its own values load", async () => {
  let members = group("r1", "rA", "rB");
  let releaseB: (r: unknown) => void = () => {};
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      members = group("r1", "rB");
      return ok({});
    }
    if (url.endsWith("/duplicate-group")) return ok(members);
    if (url.endsWith("/audit-logs")) return ok([]);
    if (url.endsWith("/r1")) return ok(receipt("r1", "R-ONE", "duplicate_flagged", 1));
    if (url.endsWith("/rA")) return ok(receipt("rA", "R-AAA", "submitter_review", 3));
    if (url.endsWith("/rB")) return new Promise((resolve) => { releaseB = resolve; });
    throw new Error(`Unexpected fetch ${url}`);
  }) as unknown as typeof fetch;

  render(
    <MantineProvider>
      <ViewerProvider viewer={{ id: 2, ageBand: "adult", isFinance: true, isBoardMember: false, isOperations: false, isInventoryManager: false }}>
        <ReceiptDetailPage queueBase="/finance/review" />
      </ViewerProvider>
    </MantineProvider>,
  );

  expect(await screen.findByText("R-AAA")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Different purchases" })).not.toBeInTheDocument();
  expect(screen.getByText("Loading…")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Not this one: match 1" }));
  await waitFor(() => expect(screen.queryByText("R-AAA")).not.toBeInTheDocument());

  expect(screen.getByText("Loading…")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Not this one/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Different purchases" })).not.toBeInTheDocument();

  await act(async () => { releaseB(ok(receipt("rB", "R-BBB", "submitter_review", 3))); });
  expect(await screen.findByText("R-BBB")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Not this one: match 1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Different purchases" })).toBeInTheDocument();
});
