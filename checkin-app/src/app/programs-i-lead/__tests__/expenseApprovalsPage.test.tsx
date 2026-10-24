import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import Page from "../expense-approvals/page";

const loaded: string[] = [];

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: () => null }));
jest.mock("@checkin/expense/components/api", () => ({
  PAGE_SIZE: 50,
  useLoad: (path: string) => {
    loaded.push(path);
    return { data: null, error: null, reload: () => {} };
  },
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
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ||
    (class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver);
});

describe("Programs I Lead › Expense approvals", () => {
  it("opens on the Waiting on you view, the expenses the approver pill counts", () => {
    render(<MantineProvider><Page /></MantineProvider>);
    expect(screen.getByRole("radio", { name: "Waiting on you" })).toBeChecked();
    expect(loaded).toContain("/expenses?view=awaiting_me&page=1&limit=50");
    expect(loaded).toContain("/expenses/count?view=awaiting_me");
  });
});
