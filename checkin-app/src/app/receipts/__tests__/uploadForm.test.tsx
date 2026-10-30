import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import UploadPage from "@checkin/receipt/pages/upload";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
let mockUser: Record<string, unknown> = { id: 7, ageBand: "adult" };
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: mockUser } }) }));
jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  upload: jest.fn(),
  api: jest.fn(),
}));

const { upload: uploadMock, api: apiMock } = jest.requireMock<{
  upload: jest.Mock<Promise<{ id: string }>, [FormData]>;
  api: jest.Mock<Promise<unknown>, [string]>;
}>("@checkin/receipt/components/api");

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom has no scrollIntoView, which Mantine's combobox calls on open.
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 7, ageBand: "adult" };
});

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });

/** Opens the typed-details form with a file, and with the retailer, date and total filled unless `fillRequired` is false. */
function renderManual(fillRequired = true) {
  const { container } = render(<MantineProvider><UploadPage /></MantineProvider>);
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(["receipt"], "r.txt", { type: "text/plain" })] } });
  fireEvent.click(screen.getByText("I'll type the details"));
  if (fillRequired) {
    type("Retailer", "Acme");
    type("Date", "2026-10-01");
    type("Total", "10");
  }
}

async function submittedData(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  await waitFor(() => expect(uploadMock).toHaveBeenCalled());
  const form = uploadMock.mock.calls[0][0];
  return JSON.parse(String(form.get("data")));
}

describe("Manual receipt upload", () => {
  it("posts currency, discount, and each line's part #, manufacturer and backordered flag", async () => {
    uploadMock.mockResolvedValue({ id: "r1" });
    renderManual();
    type("Retailer", "Acme");
    type("Date", "2026-10-01");
    type("Currency", "cad");
    type("Total", "18");
    type("Discount", "2");
    type("Item 1 description", "Bolts");
    type("Item 1 unit price", "10");
    type("Item 1 part number", " B-100 ");
    type("Item 1 manufacturer", "Fastenal");
    fireEvent.click(screen.getByLabelText("Item 1 backordered"));
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    type("Item 2 description", "Nuts");
    type("Item 2 unit price", "10");

    const data = await submittedData();
    expect(data.details).toEqual({
      retailer: "Acme",
      receiptDate: "2026-10-01",
      currency: "CAD",
      receiptTotal: "18",
      tax: "0",
      shipping: "0",
      discount: "2",
      lineItems: [
        { description: "Bolts", partNumber: "B-100", manufacturer: "Fastenal", quantity: 1, unitPrice: 10, isDelayed: true },
        { description: "Nuts", partNumber: null, manufacturer: null, quantity: 1, unitPrice: 10, isDelayed: false },
      ],
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/receipts/r1"));
  });

  it("defaults the currency to USD and the discount to zero", async () => {
    uploadMock.mockResolvedValue({ id: "r2" });
    renderManual();
    type("Currency", "");
    const data = await submittedData();
    expect(data.details).toMatchObject({ currency: "USD", discount: "0" });
  });

  it("refuses a currency that is not a 3-letter code before posting", () => {
    renderManual();
    type("Currency", "$");
    expect(screen.getByText("Use a 3-letter currency code, like USD")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    type("Currency", "eur");
    expect(screen.queryByText("Use a 3-letter currency code, like USD")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
  });

  it("shows a refused upload as a red notice that stays until dismissed", async () => {
    uploadMock.mockRejectedValue(new Error("At least one line item is required"));
    renderManual();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: "At least one line item is required", color: "red", autoClose: false }),
      ),
    );
  });
});

describe("Required details", () => {
  it("refuses to upload without the retailer, date and total, naming each", () => {
    renderManual(false);
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(notifications.show).toHaveBeenCalledWith({
      title: "Receipt not uploaded",
      message: "Fill in the retailer, date and total.",
      color: "red",
      autoClose: false,
    });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("counts a retailer of only spaces as missing", () => {
    renderManual();
    type("Retailer", "   ");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Fill in the retailer.", autoClose: false }));
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("accepts a total of zero once it is typed", async () => {
    uploadMock.mockResolvedValue({ id: "r5" });
    renderManual();
    type("Total", "0");
    const data = await submittedData();
    expect(data.details).toMatchObject({ receiptTotal: "0" });
  });
});

describe("Naming who is reimbursed", () => {
  it("defaults to the uploader, sending no reimbursee id", async () => {
    uploadMock.mockResolvedValue({ id: "r3" });
    renderManual();
    fireEvent.click(screen.getByLabelText("Someone needs to be reimbursed"));
    expect(screen.getByRole("textbox", { name: /Reimburse/ })).toHaveValue("Me");
    const data = await submittedData();
    expect(data.needsReimbursement).toBe(true);
    expect(data).not.toHaveProperty("reimburseePersonId");
  });

  it("sends the Person id of someone picked from the search", async () => {
    uploadMock.mockResolvedValue({ id: "r4" });
    apiMock.mockResolvedValue([{ id: 7, name: "Me Myself" }, { id: 42, name: "Sam Lee" }]);
    renderManual();
    fireEvent.click(screen.getByLabelText("Someone needs to be reimbursed"));
    const picker = screen.getByRole("textbox", { name: /Reimburse/ });
    fireEvent.click(picker);
    fireEvent.change(picker, { target: { value: "sam" } });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/reimbursee-options?q=sam"));
    fireEvent.click(await screen.findByRole("option", { name: "Sam Lee" }));
    expect(screen.queryByRole("option", { name: "Me Myself" })).not.toBeInTheDocument();
    const data = await submittedData();
    expect(data).toMatchObject({ needsReimbursement: true, reimburseePersonId: 42 });
  });

  it("offers adding someone not on file only to finance, operations or the board", () => {
    renderManual();
    fireEvent.click(screen.getByLabelText("Someone needs to be reimbursed"));
    expect(screen.queryByLabelText("Not a member / not in the list")).not.toBeInTheDocument();
  });

  it("adds a non-member by name, declared an adult, instead of a picked person", async () => {
    mockUser = { id: 7, ageBand: "adult", isOperations: true };
    uploadMock.mockResolvedValue({ id: "r6" });
    renderManual();
    fireEvent.click(screen.getByLabelText("Someone needs to be reimbursed"));
    fireEvent.click(screen.getByLabelText("Not a member / not in the list"));
    expect(screen.queryByRole("textbox", { name: /^Reimburse/ })).not.toBeInTheDocument();
    type("Their full name", " Dana Field ");
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("They are an adult (18 or over)"));
    const data = await submittedData();
    expect(data).toMatchObject({ needsReimbursement: true, newReimbursee: { name: "Dana Field", isAdult: true } });
    expect(data).not.toHaveProperty("reimburseePersonId");
  });
});
