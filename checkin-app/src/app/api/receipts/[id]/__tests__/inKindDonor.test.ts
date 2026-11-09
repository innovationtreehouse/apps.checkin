/**
 * @jest-environment node
 *
 * The receipt mounts hand the service checkin's own-household refusal: a typed-in donor from the
 * uploader's household is a 403 with a refusal audit row, one from outside it succeeds.
 */
import type { NextRequest as NextRequestType } from "next/server";
import { getServerSession } from "next-auth/next";
import { PUT } from "../in-kind/route";
import { POST } from "../../upload/route";
import { OWN_HOUSEHOLD_RECEIPT_DONOR_MESSAGE } from "@/lib/bulkDonation/donorSelfGuard";

type DonorCheck = (donor: { lastName: string }) => Promise<void>;
const mockRunCheck = async (input: { donor: { lastName: string } }, check: DonorCheck) => {
  await check(input.donor);
  return { id: "r-1", uploadedByUserId: 9, state: "uploaded", lineItems: [], financialReviewReasons: [] };
};

jest.mock("@checkin/receipt/services/receiptService", () => ({
  receiptService: {
    setInKind: jest.fn((_id: string, input: { donor: { lastName: string } }, check: DonorCheck) => mockRunCheck(input, check)),
    upload: jest.fn((_file: Buffer, _type: string, input: { donor: { lastName: string } }, check: DonorCheck) => mockRunCheck(input, check)),
  },
}));

// Multipart parsing doesn't survive jest's node sandbox, and it isn't what this suite checks.
const mockReadUploadForm = jest.fn<Promise<FormData>, [unknown]>();
jest.mock("@checkin/receipt/routes/_shared", () => ({
  ...jest.requireActual("@checkin/receipt/routes/_shared"),
  readUploadForm: (req: unknown) => mockReadUploadForm(req),
}));

const mockAuditCreate = jest.fn<Promise<object>, [unknown]>(async () => ({}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    person: {
      findUnique: jest.fn(async () => ({ id: 9, householdId: 90, name: "Alex Brandt" })),
      findMany: jest.fn(async () => [{ id: 9, name: "Alex Brandt" }, { id: 8, name: "Sam Okafor" }]),
    },
    auditLog: { create: (arg: unknown) => mockAuditCreate(arg) },
  },
}));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>("next/server");
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const body = (lastName: string) => ({ isInKind: true, donor: { firstName: "Pat", lastName } });
const params = { params: Promise.resolve({ id: "r-1" }) };

const put = (lastName: string) =>
  PUT(new NextRequest("http://localhost/api/receipts/r-1/in-kind", { method: "PUT", body: JSON.stringify(body(lastName)) }), params);

function upload(lastName: string) {
  const form = new FormData();
  form.set("file", new File(["x"], "r.txt", { type: "text/plain" }));
  form.set("data", JSON.stringify(body(lastName)));
  mockReadUploadForm.mockResolvedValue(form);
  return POST(new NextRequest("http://localhost/api/receipts/upload", { method: "POST" }), { params: Promise.resolve({}) });
}

beforeEach(() => {
  mockAuditCreate.mockClear();
  mockSession.mockResolvedValue({
    user: {
      id: 9,
      isSysadmin: false,
      isBoardMember: false,
      isKeyholder: false,
      isBackgroundCheckReviewer: false,
      isOperations: false,
      isInventoryManager: false,
      isFinance: false,
      ageBand: "adult",
      isActiveOrgMember: true,
    },
    expires: "2099-01-01",
  });
});

describe.each([
  ["upload", upload],
  ["in-kind", put],
])("%s", (_label, send) => {
  it("refuses a donor in the uploader's household and audits the refusal", async () => {
    const res = await send("Okafor");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(OWN_HOUSEHOLD_RECEIPT_DONOR_MESSAGE);
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 9,
        affectedEntityId: 8,
        tableName: "SelfGrantRefusal",
        newData: { reason: "own_household", table: "Receipt" },
      }),
    });
  });

  it("accepts a donor outside the uploader's household", async () => {
    expect((await send("Rivera")).status).toBe(200);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});
