"use client";
import { useState } from "react";
import { useViewer } from "@checkin/component-ui";
import { Alert, Anchor, Badge, Button, Checkbox, Group, NumberInput, Paper, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { act, api, useLoad, when } from "../components/api";
import { formatCents } from "@checkin/money";
import { LoadError } from "@checkin/component-ui";
import { IN_KIND_STATE as STATE, type InKindSource, type WaitingOn } from "../components/inKindState";

interface QueueLine {
  id: number;
  gtin13: string | null;
  description: string | null;
  quantity: number;
  valueCents: number | null;
  suggestedValueCents: number | null;
}

interface QueueItem {
  id: number;
  source: InKindSource;
  receiptId: string | null;
  receiptDate: string | null;
  donationDate: string | null;
  moneyReceivedAt: string | null;
  budgetOwnerId: number | null;
  budgetOwnerName: string | null;
  totalValueCents: number | null;
  outcome: string | null;
  /** Null once the gift waits on nothing and stays only for its QuickBooks note. */
  state: WaitingOn | null;
  waitingOn: WaitingOn[];
  revenueBooking: string | null;
  expenseBooking: string | null;
  qbState: string | null;
  qbNote: string | null;
  warnDonorSurnameMatch: boolean;
  warnDonorIsRecorder: boolean;
  warnLargeValue: boolean;
  warnDonorReplaced: boolean;
  callerConflicted: boolean;
  allFinanceConflicted: boolean;
  lines: QueueLine[];
}

interface Bucket {
  id: number;
  name: string;
  archivedAt?: string | null;
  quickBooksClassId?: string | null;
}

const WARNINGS: { key: "warnDonorSurnameMatch" | "warnDonorIsRecorder" | "warnLargeValue" | "warnDonorReplaced"; text: string }[] = [
  { key: "warnDonorSurnameMatch", text: "The donor's surname matches someone in your household." },
  { key: "warnDonorIsRecorder", text: "The donor's surname matches the uploader's or recorder's household." },
  { key: "warnLargeValue", text: "The value is at or over the large-spend amount." },
  { key: "warnDonorReplaced", text: "The donor was replaced after the gift was recorded." },
];

function useRoles(): { isFinance: boolean; isBoard: boolean } {
  const viewer = useViewer();
  return { isFinance: viewer?.isFinance === true, isBoard: viewer?.isBoardMember === true };
}

/** The accept screen for one gift: warnings, values for a gift without a receipt, bucket, and the three outcomes. */
function DecidePanel({ item, buckets, onDone }: { item: QueueItem; buckets: Bucket[]; onDone: () => void }) {
  const accepted = item.outcome === "ACCEPTED";
  const [bucketId, setBucketId] = useState<string | null>(item.budgetOwnerId === null ? null : String(item.budgetOwnerId));
  const [values, setValues] = useState<Record<number, number | "">>(
    Object.fromEntries(item.lines.map((l) => [l.id, l.valueCents === null && l.suggestedValueCents === null ? "" : (l.valueCents ?? l.suggestedValueCents ?? 0) / 100])),
  );
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const needsValues = item.source === "manual" && !accepted;
  // The large-value warning's threshold, as the server reads it; until it loads, the server's flag stands.
  const settings = useLoad<{ capitalLineItemThresholdCents: number }>(needsValues ? "/api/expense/org-settings" : null);
  const valueCents = (lineId: number) => Math.round(Number(values[lineId] || 0) * 100);
  const allValued = item.lines.every((l) => valueCents(l.id) > 0);
  const threshold = settings.data?.capitalLineItemThresholdCents;
  const warnLargeValue =
    needsValues && threshold !== undefined ? item.lines.reduce((sum, l) => sum + valueCents(l.id), 0) >= threshold : item.warnLargeValue;
  const bucketOptions = buckets.map((b) => ({ value: String(b.id), label: b.name }));
  if (item.budgetOwnerId !== null && !buckets.some((b) => b.id === item.budgetOwnerId)) {
    bucketOptions.unshift({ value: String(item.budgetOwnerId), label: item.budgetOwnerName ?? "Current bucket" });
  }

  async function send(outcome: "accept" | "refuse" | "return") {
    const body = {
      outcome,
      confirmOutsideDonorHousehold: true,
      ...(outcome === "accept" ? { bucketId: Number(bucketId) } : {}),
      ...(outcome === "accept" && needsValues ? { lineValues: item.lines.map((l) => ({ lineId: l.id, valueCents: valueCents(l.id) })) } : {}),
    };
    setBusy(true);
    const label = accepted ? "Bucket changed" : outcome === "accept" ? "Gift accepted" : outcome === "refuse" ? "Gift refused" : "Gift marked returned";
    await act(() => api(`/in-kind/${item.source}/${item.id}/decision`, { method: "POST", body: JSON.stringify(body) }), label, onDone);
    setBusy(false);
  }

  const shown = WARNINGS.filter((w) => (w.key === "warnLargeValue" ? warnLargeValue : item[w.key]));
  return (
    <Paper withBorder p="md" radius="md">
      <Stack>
        {shown.length > 0 && (
          <Alert color="yellow" title="Check before deciding">
            {shown.map((w) => <Text key={w.key} size="sm">{w.text}</Text>)}
          </Alert>
        )}
        <Table>
          <Table.Thead>
            <Table.Tr><Table.Th>Item</Table.Th><Table.Th>Quantity</Table.Th><Table.Th>{needsValues ? "Value ($)" : "Value"}</Table.Th>{needsValues && <Table.Th>Suggested</Table.Th>}</Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {item.lines.map((l) => (
              <Table.Tr key={l.id}>
                <Table.Td>{l.description ?? l.gtin13 ?? "—"}</Table.Td>
                <Table.Td>{l.quantity}</Table.Td>
                <Table.Td>
                  {needsValues ? (
                    <NumberInput aria-label={`Value of line ${l.id}`} min={0} decimalScale={2} value={values[l.id]} onChange={(v) => setValues({ ...values, [l.id]: v === "" ? "" : Number(v) || 0 })} w={140} />
                  ) : (
                    formatCents(l.valueCents)
                  )}
                </Table.Td>
                {needsValues && <Table.Td>{l.suggestedValueCents === null ? "—" : formatCents(l.suggestedValueCents)}</Table.Td>}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Select
          label="Budget bucket"
          placeholder="Pick a bucket"
          data={bucketOptions}
          value={bucketId}
          onChange={setBucketId}
          searchable
          w={320}
        />
        <Checkbox
          label="I am not the donor and do not share a household with them."
          checked={attested}
          onChange={(e) => setAttested(e.currentTarget.checked)}
        />
        <Group>
          <Button onClick={() => send("accept")} disabled={!attested || !bucketId || (needsValues && !allValued)} loading={busy}>{accepted ? "Change bucket" : "Accept"}</Button>
          {!accepted && (
            <>
              <Button variant="light" color="red" onClick={() => send("refuse")} disabled={!attested} loading={busy}>Refuse</Button>
              <Button variant="light" color="gray" onClick={() => send("return")} disabled={!attested} loading={busy}>Return</Button>
            </>
          )}
        </Group>
        <Text size="xs" c="dimmed">The value is for the books only. Refused or returned goods are handled outside the app.</Text>
      </Stack>
    </Paper>
  );
}

/** The QuickBooks states the drain hands to finance to book, skip or match. */
const QB_HELD = ["UNBOOKED", "NEEDS_FINANCE", "POST_FAILED"];

const isHeld = (q: QueueItem) => q.qbState !== null && QB_HELD.includes(q.qbState);

/**
 * Finance's QuickBooks actions on one gift: book it, skip it with a reason, or match entries
 * booked by hand by id, while the drain holds it for finance; and clear its note once answered.
 */
function QbPanel({ item, onDone }: { item: QueueItem; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [clearReason, setClearReason] = useState("");
  const [journalEntryId, setJournalEntryId] = useState("");
  const [depositId, setDepositId] = useState("");
  const [purchaseId, setPurchaseId] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(body: Record<string, string>, label: string) {
    setBusy(true);
    await act(() => api(`/in-kind/${item.source}/${item.id}/qb-resolve`, { method: "POST", body: JSON.stringify(body) }), label, onDone);
    setBusy(false);
  }

  return (
    <Paper withBorder p="md" radius="md">
      <Stack>
        {item.qbNote && (
          <Group align="end">
            <TextInput label="How it was answered" placeholder="Voided the entry in QuickBooks, …" value={clearReason} onChange={(e) => setClearReason(e.currentTarget.value)} w={320} />
            <Button variant="light" color="gray" onClick={() => send({ action: "clear", reason: clearReason }, "Note cleared")} disabled={!clearReason.trim()} loading={busy}>
              Clear note
            </Button>
          </Group>
        )}
        {isHeld(item) && (
          <>
            <Group align="end">
              <Button onClick={() => send({ action: "book" }, "Booked in QuickBooks")} loading={busy}>Book</Button>
              <Text size="xs" c="dimmed">The app creates the journal entry, unless it finds one already booked.</Text>
            </Group>
            <Group align="end">
              <TextInput label="Reason" placeholder="Booked by hand, out of scope, …" value={reason} onChange={(e) => setReason(e.currentTarget.value)} w={320} />
              <Button variant="light" color="gray" onClick={() => send({ action: "skip", reason }, "Skipped")} disabled={!reason.trim()} loading={busy}>Skip</Button>
            </Group>
            <Group align="end">
              <TextInput label="Journal entry id" value={journalEntryId} onChange={(e) => setJournalEntryId(e.currentTarget.value)} w={160} />
              <Button variant="light" onClick={() => send({ action: "match", journalEntryId: journalEntryId.trim() }, "Matched")} disabled={!journalEntryId.trim()} loading={busy}>Match</Button>
            </Group>
            <Group align="end">
              <TextInput label="Deposit id" value={depositId} onChange={(e) => setDepositId(e.currentTarget.value)} w={160} />
              <TextInput label="Purchase id" value={purchaseId} onChange={(e) => setPurchaseId(e.currentTarget.value)} w={160} />
              <Button
                variant="light"
                onClick={() => send({ action: "match", depositId: depositId.trim(), purchaseId: purchaseId.trim() }, "Matched")}
                disabled={!depositId.trim() || !purchaseId.trim()}
                loading={busy}
              >
                Match pair
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Paper>
  );
}

/** /donations/in-kind — every in-kind gift with something left to do, and finance's accept step. */
export default function InKindQueuePage() {
  const queue = useLoad<QueueItem[]>("/in-kind/queue");
  const owners = useLoad<Bucket[]>("/api/budget-owners");
  const { isFinance, isBoard } = useRoles();
  const [open, setOpen] = useState<string | null>(null);
  const [qbOpen, setQbOpen] = useState<string | null>(null);
  const buckets = (owners.data ?? []).filter((b) => !b.archivedAt && b.quickBooksClassId !== null);

  const mayDecide = (q: QueueItem) => !q.callerConflicted && (isFinance || (isBoard && q.allFinanceConflicted));
  const decidable = (q: QueueItem) => q.state === "decision" || (q.outcome === "ACCEPTED" && q.revenueBooking === null && q.expenseBooking === null && (q.state === "bucket" || q.state === "capital" || q.state === "booking"));
  const settleKind = (q: QueueItem) => (q.state === "withdrawal" ? "withdrawal" : q.state === "replay" ? "replay" : null);

  return (
    <>
      <Title order={3} mb="md">In-kind queue</Title>
      <Text size="sm" c="dimmed" mb="md">
        Every gift of goods is accepted, refused or returned by a finance holder outside the household of whoever uploaded or recorded it;
        a Board member decides when every finance holder is conflicted. A withdrawal after money is settled here once any booked
        side is reversed by hand in QuickBooks; settling clears the donor.
      </Text>
      {queue.error && <LoadError what="the in-kind queue" message={queue.error} onRetry={queue.reload} />}
      {queue.data?.length === 0 && <Text c="dimmed">Nothing in the queue.</Text>}
      {!!queue.data?.length && (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Status</Table.Th><Table.Th>Source</Table.Th><Table.Th>Date</Table.Th>
              <Table.Th>Value</Table.Th><Table.Th>Bucket</Table.Th><Table.Th>Bookings</Table.Th><Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {queue.data.map((q) => {
              const key = `${q.source}:${q.id}`;
              const kind = settleKind(q);
              return [
                <Table.Tr key={key}>
                  <Table.Td>
                    {q.state ? <Badge color={STATE[q.state].color}>{STATE[q.state].label}</Badge> : <Badge color="yellow">QuickBooks note</Badge>}
                  </Table.Td>
                  <Table.Td><Anchor href={`/donations/in-kind/${q.source}/${q.id}`}>{q.source === "receipt" ? `Receipt ${q.receiptId}` : "No receipt"}</Anchor></Table.Td>
                  <Table.Td>{q.receiptDate ?? q.donationDate ?? when(q.moneyReceivedAt)}</Table.Td>
                  <Table.Td>{q.totalValueCents === null ? "—" : formatCents(q.totalValueCents)}</Table.Td>
                  <Table.Td>{q.budgetOwnerName ?? "—"}</Table.Td>
                  <Table.Td>
                    {q.revenueBooking || q.expenseBooking ? `Revenue ${q.revenueBooking ?? "—"}, expense ${q.expenseBooking ?? "—"}` : q.qbState ?? "—"}
                    {q.qbNote && <Text size="xs" c="dimmed">{q.qbNote}</Text>}
                  </Table.Td>
                  <Table.Td>
                    {decidable(q) && mayDecide(q) && (
                      <Button size="xs" variant="light" onClick={() => setOpen(open === key ? null : key)}>{q.outcome ? "Change bucket" : "Decide"}</Button>
                    )}
                    {decidable(q) && q.callerConflicted && <Text size="xs" c="dimmed">You are conflicted on this gift</Text>}
                    {kind && isFinance && (
                      <Button size="xs" variant="light" color="red" onClick={() => act(() => api(`/in-kind/receipt/${q.id}/settle`, { method: "POST", body: JSON.stringify({ kind }) }), "Settled", queue.reload)}>
                        {kind === "withdrawal" ? "Settle withdrawal" : "Keep first values"}
                      </Button>
                    )}
                    {isFinance && (isHeld(q) || q.qbNote) && (
                      <Button size="xs" variant="light" onClick={() => setQbOpen(qbOpen === key ? null : key)}>QuickBooks</Button>
                    )}
                  </Table.Td>
                </Table.Tr>,
                open === key && (
                  <Table.Tr key={`${key}:panel`}>
                    <Table.Td colSpan={7}>
                      <DecidePanel item={q} buckets={buckets} onDone={() => { setOpen(null); queue.reload(); }} />
                    </Table.Td>
                  </Table.Tr>
                ),
                qbOpen === key && (
                  <Table.Tr key={`${key}:qb`}>
                    <Table.Td colSpan={7}>
                      <QbPanel item={q} onDone={() => { setQbOpen(null); queue.reload(); }} />
                    </Table.Td>
                  </Table.Tr>
                ),
              ];
            })}
          </Table.Tbody>
        </Table>
      )}
    </>
  );
}
