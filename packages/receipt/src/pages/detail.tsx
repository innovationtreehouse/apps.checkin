"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Alert, Anchor, Badge, Button, Group, Mark, Paper, Stack, Table, Text, Textarea, TextInput, Title } from "@mantine/core";
import ReceiptFile from "../components/ReceiptFile";
import { BASE, dollars, send, STATE_LABELS, useLoad, useRoles, type ReceiptListRow } from "../components/api";
import { returnQueue, reviewHref } from "../components/reviewQueue";

const REVIEW_REASON_LABELS: Record<string, string> = {
  tax: "tax was charged",
  old_date: "the receipt is older than the age limit",
  future_date: "the receipt is dated in the future",
  submitter_correction: "the submitter changed the tax or date",
};

/** Marks a value that is a reason the receipt is in finance review. */
function Flagged({ on, children }: { on: boolean; children: React.ReactNode }) {
  return on ? <Mark color="red">{children}</Mark> : <>{children}</>;
}

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
 * /receipts/[id] and /receipts/review/[id] — one receipt: its file, details and lines, and the
 * actions its state allows the caller. Opened from a review queue, a decision returns to that queue.
 */
export default function ReceiptDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queueParam = useSearchParams().get("queue");
  const fromReview = usePathname().startsWith("/receipts/review/");
  const { data: session } = useSession();
  const { isFinance, isBoard } = useRoles();
  const receipt = useLoad<Receipt>(`/${id}`);
  const audit = useLoad<AuditRow[]>(isFinance || isBoard ? `/${id}/audit-logs` : null);
  const [note, setNote] = useState("");
  const [edit, setEdit] = useState<{ retailer?: string; receiptDate?: string; tax?: string; receiptTotal?: string }>({});

  const r = receipt.data;
  if (receipt.error) return <Alert color="red">{receipt.error}</Alert>;
  if (!r) return <Text>Loading…</Text>;

  const back = fromReview
    ? { href: reviewHref(returnQueue(queueParam, r.state)), label: "Receipts review" }
    : { href: "/receipts", label: "My receipts" };

  const reasons = r.financialReviewReasons;
  const dateFlagged = reasons.includes("old_date") || reasons.includes("future_date");
  const taxFlagged = reasons.includes("tax");
  const own = (session?.user as { id?: unknown } | undefined)?.id === r.uploadedByUserId;
  const isAdult = (session?.user as { ageBand?: string } | undefined)?.ageBand === "adult";
  // `decides` marks an action that moves the receipt out of the queue it was opened from.
  const act = async (path: string, method: string, body: unknown, success: string, decides = false) => {
    if (await send(`/${id}${path}`, method, body, success)) {
      if (decides && fromReview) {
        router.push(back.href);
        return;
      }
      setNote("");
      setEdit({});
      receipt.reload();
      audit.reload();
    }
  };
  const saveEdit = () =>
    act(
      "",
      "PATCH",
      {
        ...edit,
        ...(edit.tax === undefined ? {} : { tax: Number(edit.tax) }),
        ...(edit.receiptTotal === undefined ? {} : { receiptTotal: Number(edit.receiptTotal) }),
      },
      "Saved",
    );

  return (
    <Stack>
      <Anchor component={Link} href={back.href} size="sm">← {back.label}</Anchor>
      <Group justify="space-between">
        <Title order={3}>{r.retailer ?? "Receipt"}</Title>
        <Group gap="xs">
          {r.isInKind && <Badge>Donation</Badge>}
          <Badge variant="light">{STATE_LABELS[r.state] ?? r.state}</Badge>
        </Group>
      </Group>
      {r.validationNotes && <Alert color="yellow">{r.validationNotes}</Alert>}
      {r.financialReviewReasons.length > 0 && (
        <Alert color="blue">Finance review: {r.financialReviewReasons.map((reason) => REVIEW_REASON_LABELS[reason] ?? reason).join("; ")}</Alert>
      )}

      <Group align="flex-start" grow wrap="wrap">
        <Paper withBorder p="sm" miw={280}>
          <ReceiptFile src={`${BASE}/${r.id}/file`} mimeType={r.mimeType} />
        </Paper>
        <Stack miw={280}>
          <Text>Date: <Flagged on={dateFlagged}>{r.receiptDate ?? "—"}</Flagged></Text>
          <Text>
            Total: {dollars(r.receiptTotalCents)} (<Flagged on={taxFlagged}>tax {dollars(r.taxCents)}</Flagged>, shipping {dollars(r.shippingCents)})
          </Text>
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
                <TextInput label="Tax ($)" value={edit.tax ?? ((r.taxCents ?? 0) / 100).toFixed(2)} onChange={(e) => setEdit({ ...edit, tax: e.currentTarget.value })} />
                {own && <Text size="xs" c="dimmed">Changing the tax or date sends this receipt to finance review.</Text>}
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
              <Button size="xs" variant="light" onClick={() => void act("/retry-ocr", "POST", {}, "Read again", true)}>Read it again</Button>
            )}
            {(own || isFinance) && r.state === "validation_failed" && (
              <Button size="xs" variant="light" onClick={() => void act("/resubmit", "POST", {}, "Resubmitted", true)}>Resubmit</Button>
            )}
            {(own || isFinance) && !TERMINAL.has(r.state) && (
              <Button size="xs" variant="subtle" color="red" onClick={() => void act("/discard", "POST", {}, "Discarded", true)}>Discard</Button>
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
                      <Button size="xs" color="green" onClick={() => void act("/approve", "POST", { note: note || null }, "Approved", true)}>Approve</Button>
                      <Button size="xs" color="red" variant="light" onClick={() => void act("/reject", "POST", { reason: note || null }, "Rejected", true)}>Reject</Button>
                    </Group>
                  </>
                )}
                {r.state === "financial_review" && own && <Text size="sm" c="dimmed">Someone else in finance decides on your own receipt.</Text>}
                {r.state === "duplicate_flagged" && (
                  <Button size="xs" w="fit-content" onClick={() => void act("/clear-duplicate", "POST", {}, "Cleared", true)}>Not a duplicate</Button>
                )}
                {r.state === "flow_error" && (
                  <Button size="xs" w="fit-content" onClick={() => void act("/restart-flow", "POST", {}, "Restarted", true)}>Restart</Button>
                )}
                {r.state === "discarded" && (
                  <Group align="end">
                    <TextInput label="Why this file is never a receipt" value={note} onChange={(e) => setNote(e.currentTarget.value)} style={{ flex: 1 }} />
                    <Button size="xs" variant="light" color="red" disabled={!note.trim()} onClick={() => void act("/ignore-file", "POST", { reason: note }, "This file is ignored in mail from now on")}>
                      Ignore this file from now on
                    </Button>
                  </Group>
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
