import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SignAllButton, { treasurerLines } from "@checkin/expense/components/SignAllButton";

let mockLines: unknown = null;
let mockError: string | null = null;
const mockReload = jest.fn();
const mockSend = jest.fn<Promise<boolean>, [string, string, unknown, string]>();

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: () => ({ data: mockLines, error: mockError, reload: () => mockReload() }),
  send: (...args: [string, string, unknown, string]) => mockSend(...args),
}));

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue(true);
  mockLines = null;
  mockError = null;
  mockReload.mockClear();
});

const line = (lineItemId: number, actions: Array<{ act: string; seat?: string; primary?: boolean }>) => ({ lineItemId, actions: actions.map((a) => ({ primary: false, ...a })) });
const TREASURER = { act: "sign", seat: "TREASURER", primary: true };

function draw(onSigned = jest.fn()) {
  render(<MantineProvider><SignAllButton expenseId="e1" onSigned={onSigned} /></MantineProvider>);
  return onSigned;
}

describe("Sign all N as Treasurer", () => {
  it("names how many lines wait on the viewer's Treasurer signature, and signs them in one request", async () => {
    mockLines = [line(1, [TREASURER]), line(2, [{ act: "approve", primary: true }]), line(3, [{ act: "raise-exception" }, TREASURER])];
    const onSigned = draw();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign all 2 as Treasurer" })); });
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/sign-lines", "POST", { lineItemIds: [1, 3] }, "Signed 2 as Treasurer");
    expect(onSigned).toHaveBeenCalled();
  });

  it("reads the lines again when the server refuses", async () => {
    mockLines = [line(1, [TREASURER])];
    mockSend.mockResolvedValue(false);
    const onSigned = draw();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign all 1 as Treasurer" })); });
    expect(onSigned).not.toHaveBeenCalled();
    expect(mockReload).toHaveBeenCalled();
  });

  it("draws no button while nothing is left to sign, or before the lines load", () => {
    mockLines = [line(1, [{ act: "sign", seat: "BOARD" }])];
    draw();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says in red when the lines can't be read", () => {
    mockError = "HTTP 500";
    draw();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Couldn't read the lines to sign: HTTP 500")).toBeInTheDocument();
  });
});

describe("treasurerLines", () => {
  it("keeps only lines whose main act is the Treasurer signature", () => {
    expect(treasurerLines([line(1, []), line(2, [{ act: "sign", seat: "BOARD", primary: true }]), line(3, [TREASURER]), line(4, [{ act: "sign", seat: "TREASURER" }])])).toEqual([3]);
  });
});
