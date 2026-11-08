import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { FinanceQueueList } from "@checkin/expense/pages/financeQueue";

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const intakeRow = {
  expenseId: null,
  vendorName: "Bolt",
  date: "2026-10-02",
  amountCents: 900,
  currency: "USD",
  reasons: [{ code: "INTAKE_FAILED", text: "Receipt didn't become an expense", href: "/receipts/r-failed" }],
  waitingSince: "2026-10-02T09:00:00.000Z",
  failureReason: "reimbursee cannot be read",
};

describe("the finance queue's expenses tab", () => {
  it("shows why an incoming expense failed, beside its reason", async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify([intakeRow]), { status: 200 })) as unknown as typeof fetch;

    render(
      <MantineProvider>
        <FinanceQueueList tab="expenses" counts={null} reason={null} returnHref="/finance?queue=expenses" onReason={() => {}} />
      </MantineProvider>,
    );

    expect(await screen.findByText("Receipt didn't become an expense")).toBeTruthy();
    expect(screen.getByText("reimbursee cannot be read")).toBeTruthy();
  });
});
