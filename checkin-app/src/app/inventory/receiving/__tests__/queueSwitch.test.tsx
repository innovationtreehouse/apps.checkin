import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import "@/test-helpers/rtl";
import ReceivingPage from "@checkin/workflow-mapping/pages/receiving";

let mockSearch = new URLSearchParams("queue=mapping");
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: 1, isInventoryManager: true } } }) }));

const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

it("offers no Retry on the previous queue's rows while Apply failed loads", async () => {
  global.fetch = jest.fn(async (url: string) => {
    if (url.endsWith("/counts")) return ok({ pending_review: 1, apply_failed: 0, applying: 0 });
    if (url.includes("state=apply_failed")) return new Promise(() => {});
    return ok([{ id: 7, state: "pending_review", vendorName: "Mapping Hardware", receiptTotalCents: 1000, currency: "USD", lineItemCount: 1, validationNotes: null, createdAt: "2026-10-01T00:00:00Z" }]);
  }) as unknown as typeof fetch;

  const { rerender } = render(<MantineProvider><ReceivingPage /></MantineProvider>);
  expect(await screen.findByText("Mapping Hardware")).toBeInTheDocument();

  mockSearch = new URLSearchParams("queue=failed");
  rerender(<MantineProvider><ReceivingPage /></MantineProvider>);

  expect(screen.queryByText("Mapping Hardware")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  expect(screen.getByText("Loading…")).toBeInTheDocument();
});
