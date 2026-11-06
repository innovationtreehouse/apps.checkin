/**
 * Upload guards that need no database: the CSV allowlist, the size cap enforced before the body
 * is buffered, and a unique-key collision answered as a 400 instead of a 500.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const transaction = vi.fn();
vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  db: { $transaction: (fn: unknown) => transaction(fn) },
}));
vi.mock("../../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime")>()),
  getOrgId: async () => "org-1",
  getPrincipal: async () => ({ id: 1, name: "Finance" }),
  getOwnerDirectory: () => ({ list: async () => [] }),
}));

const parseSpy = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock("../../lib/csv-parser", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/csv-parser")>();
  return {
    ...real,
    parseBenevityCsv: (buffer: Buffer) => {
      if (parseSpy.fail) throw parseSpy.fail;
      return real.parseBenevityCsv(buffer);
    },
  };
});

import { upload } from "../../routes/uploads";
import { uploadedFileService } from "../../services/uploadedFileService";
import { ServiceError } from "@checkin/component-kit";
import type { BenevityRow } from "../../lib/csv-parser";

const MB = 1024 * 1024;

function formRequest(file: File): Request {
  const form = new FormData();
  form.set("file", file);
  return new Request("http://x/api/donations/uploaded-files", { method: "POST", body: form });
}

function callUpload(req: Request) {
  return upload({ req, params: {} } as Parameters<typeof upload>[0]);
}

async function failure(p: Promise<unknown>): Promise<{ status?: number; message: string }> {
  try {
    await p;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected the upload to fail");
}

async function status(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { status?: number }).status;
  }
}

describe("upload allowlist", () => {
  it("refuses a file that is not a .csv", async () => {
    expect(await status(callUpload(formRequest(new File(["a,b"], "gifts.xlsx", { type: "text/csv" }))))).toBe(415);
  });

  it("refuses a .csv whose declared type is not a CSV type", async () => {
    expect(await status(callUpload(formRequest(new File(["a,b"], "gifts.csv", { type: "image/png" }))))).toBe(415);
  });

  it("accepts a .csv labelled the way Excel on Windows labels it", async () => {
    transaction.mockResolvedValueOnce({ id: 7 });
    const res = await callUpload(formRequest(new File(["Transaction ID,Donation Amount,Match Amount,Cause Support Fee,Merchant Fee"], "gifts.csv", { type: "application/vnd.ms-excel" })));
    expect(res).toMatchObject({ UploadedFile: { id: 7, originalFilename: "gifts.csv" } });
  });
});

describe("upload size cap", () => {
  it("refuses an over-cap Content-Length before reading the body", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("body was read");
      },
    });
    const req = new Request("http://x", {
      method: "POST",
      body,
      headers: { "content-length": String(20 * MB), "content-type": "multipart/form-data; boundary=x" },
      duplex: "half",
    } as RequestInit);
    expect(await status(callUpload(req))).toBe(413);
  });

  it("stops reading an undeclared body once it passes the cap", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(MB);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 40) throw new Error("read past the cap");
        controller.enqueue(chunk);
      },
    });
    const req = new Request("http://x", {
      method: "POST",
      body,
      headers: { "content-type": "multipart/form-data; boundary=x" },
      duplex: "half",
    } as RequestInit);
    expect(await status(callUpload(req))).toBe(413);
    expect(pulled).toBeLessThan(15);
  });
});

describe("processUpload unique collisions", () => {
  const row = (transactionId: string) => ({ transactionId, donorComment: "" }) as BenevityRow;

  beforeEach(() => {
    transaction.mockReset();
  });

  it("answers a transaction repeated within one file with a 400 naming it", async () => {
    const p = uploadedFileService.processUpload("org-1", 1, "u", "f.csv", Buffer.from("x"), [row("T1"), row("T1")], null);
    await expect(p).rejects.toBeInstanceOf(ServiceError);
    await expect(p).rejects.toMatchObject({ status: 400, message: expect.stringContaining("T1") });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("answers a concurrent upload's P2002 with a 409", async () => {
    transaction.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const p = uploadedFileService.processUpload("org-1", 1, "u", "f.csv", Buffer.from("x"), [row("T1")], null);
    await expect(p).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already being uploaded/) });
  });

  it("passes any other database error through", async () => {
    transaction.mockRejectedValue(Object.assign(new Error("boom"), { code: "P1001" }));
    const p = uploadedFileService.processUpload("org-1", 1, "u", "f.csv", Buffer.from("x"), [row("T1")], null);
    await expect(p).rejects.toThrow("boom");
  });
});

describe("upload parse failures", () => {
  const csv = (text: string) => formRequest(new File([text], "gifts.csv", { type: "text/csv" }));

  afterEach(() => {
    parseSpy.fail = null;
    vi.restoreAllMocks();
  });

  it("names the missing Transaction ID header", async () => {
    const err = await failure(callUpload(csv("Txn Id,Donation Amount\nT1,5.00\n")));
    expect(err.status).toBe(400);
    expect(err.message).toContain('no header row with a "Transaction ID" column');
  });

  it("names the line and column of a malformed row without echoing the cell", async () => {
    const err = await failure(callUpload(csv('Transaction ID,Donor First Name\nT1,x"Pat Example"\n')));
    expect(err.status).toBe(400);
    expect(err.message).toContain("line 2, column 2");
    expect(err.message).not.toContain("Pat Example");
  });

  it("reports an unexpected parser exception as an app error with a reference, and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    parseSpy.fail = new TypeError("Cannot read properties of undefined (donor Pat Example)");
    const req = new Request("http://x/api/donations/uploaded-files", {
      method: "POST",
      body: (() => {
        const form = new FormData();
        form.set("file", new File(["Transaction ID\nT1\n"], "gifts.csv", { type: "text/csv" }));
        return form;
      })(),
      headers: { "x-correlation-id": "ref-123" },
    });
    const err = await failure(callUpload(req));
    expect(err.status).toBe(500);
    expect(err.message).toContain("ref-123");
    expect(err.message).toMatch(/not a problem with the file/i);
    expect(err.message).not.toContain("Pat Example");
    expect(err.message).not.toContain("TypeError");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ref-123"), parseSpy.fail);
  });
});
