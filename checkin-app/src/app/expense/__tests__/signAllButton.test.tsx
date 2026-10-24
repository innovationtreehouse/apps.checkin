import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SignAllButton, { treasurerLines } from "@checkin/expense/components/SignAllButton";

const mockSend = jest.fn<Promise<boolean>, [string, string, unknown, string]>();
const mockApi = jest.fn<Promise<unknown>, [string]>();
const mockShow = jest.fn();

jest.mock("@checkin/expense/components/api", () => ({
  api: (path: string) => mockApi(path),
  send: (...args: [string, string, unknown, string]) => mockSend(...args),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : "Error"),
}));
jest.mock("@mantine/notifications", () => ({ notifications: { show: (...args: unknown[]) => mockShow(...args) } }));

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue(true);
  mockApi.mockReset();
  mockShow.mockReset();
});

const line = (lineItemId: number, actions: Array<{ act: string; seat?: string }>) => ({ lineItemId, actions });
const TREASURER = { act: "sign", seat: "TREASURER" };

async function click(onSigned = jest.fn()) {
  render(<MantineProvider><SignAllButton expenseId="e1" count={2} onSigned={onSigned} /></MantineProvider>);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign all 2 as Treasurer" })); });
  return onSigned;
}

describe("Sign all N as Treasurer", () => {
  it("signs every line the server offers the viewer a Treasurer signature on, in one request", async () => {
    mockApi.mockResolvedValue([line(1, [TREASURER]), line(2, [{ act: "approve" }]), line(3, [{ act: "raise-exception" }, TREASURER])]);
    const onSigned = await click();
    expect(mockApi).toHaveBeenCalledWith("/expenses/e1/signoffs");
    expect(mockSend).toHaveBeenCalledWith("/expenses/e1/sign-lines", "POST", { lineItemIds: [1, 3] }, "Signed 2 as Treasurer");
    expect(onSigned).toHaveBeenCalled();
  });

  it("leaves the list as it is when the server refuses", async () => {
    mockApi.mockResolvedValue([line(1, [TREASURER])]);
    mockSend.mockResolvedValue(false);
    const onSigned = await click();
    expect(onSigned).not.toHaveBeenCalled();
  });

  it("sends nothing and says so in a red chip that stays when nothing is left to sign", async () => {
    mockApi.mockResolvedValue([line(1, [{ act: "sign", seat: "BOARD" }])]);
    await click();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({ color: "red", autoClose: false }));
  });

  it("shows a red chip that stays when the lines can't be read", async () => {
    mockApi.mockRejectedValue(new Error("HTTP 500"));
    await click();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockShow).toHaveBeenCalledWith({ message: "Couldn't read the lines to sign: HTTP 500", color: "red", autoClose: false });
  });
});

describe("treasurerLines", () => {
  it("keeps only lines with a Treasurer signature", () => {
    expect(treasurerLines([line(1, []), line(2, [{ act: "sign", seat: "BOARD" }]), line(3, [TREASURER])])).toEqual([3]);
  });
});
