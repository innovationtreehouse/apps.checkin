"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Alert, Badge, Button, Group, Image, Paper, Stack, Table, Text, Textarea, TextInput, Title } from "@mantine/core";
import { BASE, dollars, send, STATE_LABELS, useLoad, useRoles, type ReceiptListRow } from "../components/api";

interface Line {
  id: number;
  lineNumber: number;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  isDelayed: boolean;
}

interface Receipt extends ReceiptListRow {
  mimeType: string;
  taxCents: number | null;
  shippingCents: number | null;
  discountCents: number | null;
  reimbursementFor?: string | null;
  financialReviewReasons: string[];
  lineItems: Line[];
}

interface AuditRow {
  id: number;
  action: string;
  username: string | null;
  valueAfter: string | null;
  changedAt: string;
}

const EDITABLE = new Set(["validation_failed", "submitter_review"]);
const TERMINAL = new Set(["receipt_finalized", "discarded", "rejected"]);

/**
 * The file, as the route serves it: an image or PDF displays from the file route; text is
 * fetched and shown as escaped text, never rendered as a page.
 */
function ReceiptFile({ id, mimeType }: { id: string; mimeType: string }) {
  const src = `${BASE}/${id}/file`;
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (mimeType !== "text/plain") return;
    void fetch(src).then((r) => (r.ok ? r.text() : `Couldn't load the file (HTTP ${r.status})`)).then(setText);
  }, [src, mimeType]);
  if (mimeType === "application/pdf") return <iframe src={src} title="Receipt" style={{ width: "100%", height: 600, border: 0 }} />;
  if (mimeType === "text/plain") return <pre style={{ whiteSpace: "pre-wrap", maxHeight: 600, overflow: "auto" }}>{text ?? "Loading…"}</pre>;
  return <Image src={src} alt="Receipt" mah={600} fit="contain" />;
}

/** /receipts/[id] — one receipt: its file, details and lines, and the actions its state allows the caller. */
export default function ReceiptDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: session } = useSession();
  const { isFinance, isBoard } = useRoles();
  const receipt = useLoad<Receipt>(`/${id}`);
  const audit = useLoad<AuditRow[]>(isFinance || isBoard ? `/${id}/audit-logs` : null);
  const [note, setNote] = useState("");
  const [edit, setEdit] = useState<{ retailer?: string; receiptDate?: string; receiptTotal?: string }>({});

  const r = receipt.data;
  if (receipt.error) return <Alert color="red">{receipt.error}</Alert>;
  if (!r) return <Text>Loading…</Text>;

  const own = (session?.user as { id?: unknown } | undefined)?.id === r.uploadedByUserId;
  const isAdult = (session?.user as { ageBand?: string } | undefined)?.ageBand === "adult";
  const act = async (path: string, method: string, body: unknown, success: string) => {
    if (await send(`/${id}${path}`, method, body, success)) {
      setNote("");
      setEdit({});
      receipt.reload();
      audit.reload();
    }
  };
  const saveEdit = () =>
    act("", "PATCH", { ...edit, ...(edit.receiptTotal === undefined ? {} : { receiptTotal: Number(edit.receiptTotal) }) }, "Saved");

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>{r.retailer ?? "Receipt"}</Title>
        <Group gap="xs">
          {r.isInKind && <Badge>Donation</Badge>}
          <Badge variant="light">{STATE_LABELS[r.state] ?? r.state}</Badge>
        </Group>
      </Group>
      {r.validationNotes && <Alert color="yellow">{r.validationNotes}</Alert>}
      {r.financialReviewReasons.length > 0 && <Alert color="blue">Finance review: {r.financialReviewReasons.join(", ")}</Alert>}

      <Group align="flex-start" grow wrap="wrap">
        <Paper withBorder p="sm" miw={280}>
          <ReceiptFile id={r.id} mimeType={r.mimeType} />
        </Paper>
        <Stack miw={280}>
          <Text>Date: {r.receiptDate ?? "—"}</Text>
          <Text>Total: {dollars(r.receiptTotalCents)} (tax {dollars(r.taxCents)}, shipping {dollars(r.shippingCents)})</Text>
          {r.needsReimbursement && <Text>Reimbursement owed{r.reimbursementFor ? ` to ${r.reimbursementFor}` : ""}</Text>}
          <Table>
            <Table.Thead>
              <Table.Tr><Table.Th>Item</Table.Th><Table.Th>Qty</Table.Th><Table.Th>Total</Table.Th><Table.Th /></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {r.lineItems.map((l) => (
                <Table.Tr key={l.id}>
                  <Table.Td>{l.description}{l.isDelayed && <Badge ml="xs" size="xs" color="orange">Backordered</Badge>}</Table.Td>
                  <Table.Td>{l.quantity}</Table.Td>
                  <Table.Td>{dollars(l.totalPriceCents)}</Table.Td>
                  <Table.Td>
                    {EDITABLE.has(r.state) && r.lineItems.length > 1 && (
                      <Button size="compact-xs" variant="subtle" color="red" onClick={() => void act(`/line-items/${l.id}`, "DELETE", undefined, "Item removed")}>Remove</Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          {EDITABLE.has(r.state) && (own || isFinance) && (
            <Paper withBorder p="sm">
              <Stack gap="xs">
                <Text fw={500} size="sm">Correct the details</Text>
                <TextInput label="Retailer" value={edit.retailer ?? r.retailer ?? ""} onChange={(e) => setEdit({ ...edit, retailer: e.currentTarget.value })} />
                <TextInput label="Date" value={edit.receiptDate ?? r.receiptDate ?? ""} onChange={(e) => setEdit({ ...edit, receiptDate: e.currentTarget.value })} />
                <TextInput label="Total ($)" value={edit.receiptTotal ?? ((r.receiptTotalCents ?? 0) / 100).toFixed(2)} onChange={(e) => setEdit({ ...edit, receiptTotal: e.currentTarget.value })} />
                <Button size="xs" w="fit-content" disabled={Object.keys(edit).length === 0} onClick={() => void saveEdit()}>Save</Button>
              </Stack>
            </Paper>
          )}

          <Group gap="xs">
            {own && r.state === "submitter_review" && (
              <>
                <Button size="xs" onClick={() => void act("/submitter-confirm", "POST", {}, "Confirmed")}>Confirm</Button>
                {isAdult && !r.isInKind && (
                  <Button size="xs" variant="light" onClick={() => void act("/reimbursement", "PUT", { needsReimbursement: !r.needsReimbursement }, "Updated")}>
                    {r.needsReimbursement ? "I didn't pay for this" : "I paid for this myself"}
                  </Button>
                )}
              </>
            )}
            {(own || isFinance) && r.state === "ocr_failed" && (
              <Button size="xs" variant="light" onClick={() => void act("/retry-ocr", "POST", {}, "Read again")}>Read it again</Button>
            )}
            {(own || isFinance) && r.state === "validation_failed" && (
              <Button size="xs" variant="light" onClick={() => void act("/resubmit", "POST", {}, "Resubmitted")}>Resubmit</Button>
            )}
            {(own || isFinance) && !TERMINAL.has(r.state) && (
              <Button size="xs" variant="subtle" color="red" onClick={() => void act("/discard", "POST", {}, "Discarded")}>Discard</Button>
            )}
          </Group>

          {isFinance && (
            <Paper withBorder p="sm">
              <Stack gap="xs">
                <Text fw={500} size="sm">Finance</Text>
                {r.state === "financial_review" && !own && (
                  <>
                    <Textarea label="Note (required when the reason is tax)" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
                    <Group gap="xs">
                      <Button size="xs" color="green" onClick={() => void act("/approve", "POST", { note: note || null }, "Approved")}>Approve</Button>
                      <Button size="xs" color="red" variant="light" onClick={() => void act("/reject", "POST", { reason: note || null }, "Rejected")}>Reject</Button>
                    </Group>
                  </>
                )}
                {r.state === "financial_review" && own && <Text size="sm" c="dimmed">Someone else in finance decides on your own receipt.</Text>}
                {r.state === "duplicate_flagged" && (
                  <Button size="xs" w="fit-content" onClick={() => void act("/clear-duplicate", "POST", {}, "Cleared")}>Not a duplicate</Button>
                )}
                {r.state === "flow_error" && (
                  <Button size="xs" w="fit-content" onClick={() => void act("/restart-flow", "POST", {}, "Restarted")}>Restart</Button>
                )}
                {r.state === "receipt_finalized" && !r.pushedAt && (
                  <Button size="xs" w="fit-content" variant="light" onClick={() => void act("/push-to-inventory", "POST", {}, "Sent")}>Send downstream</Button>
                )}
              </Stack>
            </Paper>
          )}
        </Stack>
      </Group>

      {audit.data && (
        <Paper withBorder p="sm">
          <Text fw={500} size="sm" mb="xs">History</Text>
          {audit.data.map((a) => (
            <Text key={a.id} size="xs">
              {new Date(a.changedAt).toLocaleString()} · {a.username ?? "system"} · {a.action}{a.valueAfter ? ` (${a.valueAfter})` : ""}
            </Text>
          ))}
        </Paper>
      )}
    </Stack>
  );
}
