/**
 * Receipt pipeline (S1 → X5): a receipt uploaded and read by the local OCR mock, confirmed by its
 * uploader, reaches workflow-mapping in the same request (S1), where the manager resolves its
 * line; it proceeds and expense books it under the receipt's id. Once received, the receipt side
 * refuses restarts and edits, and a re-send is answered as a replay. Real HTTP against the
 * running dev server.
 */
import { api, BASE, differentPurchases, loginAs, type Session } from "./helpers";

const SUBMITTER = "inventory.manager@example.com";
const FINANCE = "finance@example.com";

interface Receipt { id: string; state: string }
type Received = { id: number; receiptId: string; state: string; validationNotes?: string | null };
type ExpenseDetail = { Expense: { id: string; vendorName: string | null } };
type Detail = { ReceivedReceipt: Received; ReceivedReceiptLineStatus: Array<{ id: number; recognitionStatus: string }> };

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function upload(s: Session, text: string) {
  const form = new FormData();
  form.append("file", new Blob([text], { type: "text/plain" }), "receipt.txt");
  const req = new Request(BASE, { method: "POST", body: form });
  return api<Receipt>(s, "/api/receipts/upload", {
    method: "POST",
    body: await req.arrayBuffer(),
    headers: { "content-type": req.headers.get("content-type") ?? "" },
  });
}

const post = <T = unknown>(s: Session, path: string, body: unknown = {}) =>
  api<T>(s, path, { method: "POST", body: JSON.stringify(body) });

async function received(s: Session, receiptId: string): Promise<Received[]> {
  const rows = (await api<Received[]>(s, "/api/workflow-mapping/receipts")).json;
  return rows.filter((r) => r.receiptId === receiptId);
}

describe("receipt pipeline — receipt to workflow mapping", () => {
  it("delivers a confirmed receipt, proceeds it, and freezes it on the receipt side", async () => {
    const submitter = await loginAs(SUBMITTER);
    const finance = await loginAs(FINANCE);

    const auto = await upload(submitter, `pipeline receipt ${stamp}`);
    expect(auto.status).toBe(200);
    // The OCR mock reads every file as the same receipt, so an earlier mock upload in this run
    // flags this one as a duplicate; finance records them as different purchases.
    const state = auto.json.state === "duplicate_flagged"
      ? (await differentPurchases<Receipt>(finance, auto.json.id)).json.state
      : auto.json.state;
    expect(state).toBe("submitter_review");
    expect((await received(submitter, auto.json.id))).toHaveLength(0);

    expect((await post<Receipt>(submitter, `/api/receipts/${auto.json.id}/submitter-confirm`)).json.state).toBe("receipt_finalized");
    const audit = await api<{ action: string }[]>(finance, `/api/receipts/${auto.json.id}/audit-logs`);
    expect(audit.json.map((a) => a.action)).toContain("pushed");

    // Workflow mapping has it, with the OCR mock's unrecognized line waiting for review.
    const [row] = await received(submitter, auto.json.id);
    expect(row).toMatchObject({ state: "pending_review" });
    const detail = (await api<Detail>(submitter, `/api/workflow-mapping/receipts/${row.id}`)).json;
    expect(detail.ReceivedReceiptLineStatus).toEqual([expect.objectContaining({ recognitionStatus: "unrecognized" })]);

    // Resolving the last line proceeds it, and expense books it under the receipt's id.
    const line = detail.ReceivedReceiptLineStatus[0];
    expect((await post(submitter, `/api/workflow-mapping/receipts/${row.id}/lines/${line.id}/non-inventory`)).status).toBe(200);
    const proceeded = (await api<Detail>(submitter, `/api/workflow-mapping/receipts/${row.id}`)).json.ReceivedReceipt;
    expect(proceeded.state).toBe("resolved");
    const expense = await api<ExpenseDetail>(finance, `/api/expense/expenses/${auto.json.id}`);
    expect(expense.status).toBe(200);
    expect(expense.json.Expense).toMatchObject({ id: auto.json.id, vendorName: "Fixture Hardware" });

    // Received is final on the receipt side: no restart, no edit.
    const restart = await post(finance, `/api/receipts/${auto.json.id}/restart-flow`);
    expect(restart.status).toBe(409);
    expect(JSON.stringify(restart.json)).toMatch(/already sent to part mapping/);
    const edit = await api(submitter, `/api/receipts/${auto.json.id}`, { method: "PATCH", body: JSON.stringify({ retailer: "Changed" }) });
    expect(edit.status).toBe(409);

    // A manual re-send is a replay: still one received receipt, state unchanged.
    expect((await post(finance, `/api/receipts/${auto.json.id}/push-to-inventory`)).json).toEqual({ pushed: true });
    expect(await received(submitter, auto.json.id)).toEqual([expect.objectContaining({ id: row.id, state: "resolved" })]);
  });
});
