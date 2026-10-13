/**
 * Upload guards that need no database: the CSV allowlist, the size cap enforced before the body
 * is buffered, and a unique-key collision answered as a 400 instead of a 500.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { upload } from "../../routes/uploads";
import { uploadedFileService } from "../../services/uploadedFileService";
import { ServiceError } from "../../services/serviceError";
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
    const res = await callUpload(formRequest(new File(["Transaction ID"], "gifts.csv", { type: "application/vnd.ms-excel" })));
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
    await expect(p).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("T1") });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("answers a concurrent upload's P2002 with a 400", async () => {
    transaction.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const p = uploadedFileService.processUpload("org-1", 1, "u", "f.csv", Buffer.from("x"), [row("T1")], null);
    await expect(p).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/already being uploaded/) });
  });

  it("passes any other database error through", async () => {
    transaction.mockRejectedValue(Object.assign(new Error("boom"), { code: "P1001" }));
    const p = uploadedFileService.processUpload("org-1", 1, "u", "f.csv", Buffer.from("x"), [row("T1")], null);
    await expect(p).rejects.toThrow("boom");
  });
});
