"use client";
import { useState } from "react";
import { useParams } from "next/navigation";
import { notifications } from "@mantine/notifications";
import { Alert, Anchor, Badge, Button, Group, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { api, errorMessage, useCanWrite, useLoad, when } from "../components/api";
import { formatCents } from "@checkin/money";
import { LoadError } from "@checkin/component-ui";
import { IN_KIND_STATE, type InKindSource, type WaitingOn } from "../components/inKindState";

interface GiftLine {
  id: number;
  gtin13: string | null;
  description: string | null;
  quantity: number;
  valueCents: number | null;
  suggestedValueCents: number | null;
}

interface GiftEvent {
  id: number;
  eventType: string;
  actorUsername: string | null;
  occurredAt: string;
  payload: string | null;
}

interface Gift {
  id: number;
  source: InKindSource;
  receiptId: string | null;
  receiptTotalCents: number | null;
  receiptDate: string | null;
  donationDate: string | null;
  moneyReceivedAt: string | null;
  recordedAt: string | null;
  recordedByUsername: string | null;
  donorFirstName: string | null;
  donorLastName: string | null;
  donorCompanyName: string | null;
  donorReplacedAt: string | null;
  withdrawnAfterMoneyAt: string | null;
  withdrawalSettledAt: string | null;
  replayConflictAt: string | null;
  outcome: string | null;
  decidedAt: string | null;
  budgetOwnerName: string | null;
  bucketHeld: boolean;
  totalValueCents: number | null;
  state: WaitingOn | null;
  revenueBooking: string | null;
  expenseBooking: string | null;
  inventorySourceKey: string | null;
  inventoryLoadedAt: string | null;
  lines: GiftLine[];
  events: GiftEvent[];
}

const OUTCOME: Record<string, string> = { ACCEPTED: "Accepted", REFUSED: "Refused", RETURNED: "Returned" };

const EVENT: Record<string, string> = {
  IN_KIND_MONEY_RECEIVED: "Receipt values received",
  IN_KIND_DONOR_RECORDED: "Donor recorded",
  IN_KIND_REPLAY_CONFLICT: "Receipt resent with different values",
  IN_KIND_WITHDRAWN_AFTER_MONEY: "In-kind mark cleared after the money arrived",
  IN_KIND_WITHDRAWAL_SETTLED: "Withdrawal settled",
  IN_KIND_REPLAY_SETTLED: "Kept the first values",
  IN_KIND_DECIDED: "Decided",
  IN_KIND_BUCKET_CHANGED: "Bucket changed",
  MANUAL_IN_KIND_RECORDED: "Recorded without a receipt",
};

/** The one detail of an event's payload worth a reader's time: an outcome. */
function eventDetail(e: GiftEvent): string {
  if (e.eventType !== "IN_KIND_DECIDED" || !e.payload) return "";
  try {
    const outcome = (JSON.parse(e.payload) as { outcome?: unknown }).outcome;
    return typeof outcome === "string" ? ` (${OUTCOME[outcome] ?? outcome})` : "";
  } catch {
    return "";
  }
}

function donorName(g: Gift): string {
  const person = [g.donorFirstName, g.donorLastName].filter(Boolean).join(" ");
  return [person, g.donorCompanyName].filter(Boolean).join(", ") || "—";
}

/** Where the goods went: loaded under the gift's own source key, or received through its receipt. */
function InventoryPanel({ gift, onReload }: { gift: Gift; onReload: () => void }) {
  const canWrite = useCanWrite();
  const [busy, setBusy] = useState(false);

  if (gift.source === "receipt") {
    return (
      <Text size="sm">
        Goods from a receipt gift are received through <Anchor href={`/receipts/${gift.receiptId}`}>its receipt</Anchor>.
      </Text>
    );
  }

  async function retry() {
    setBusy(true);
    try {
      await api(`/in-kind/manual/${gift.id}/load-inventory`, { method: "POST" });
      notifications.show({ message: "Goods loaded into inventory", color: "green" });
      onReload();
    } catch (e) {
      notifications.show({ title: "Goods not loaded into inventory", message: errorMessage(e), color: "red", autoClose: false });
    } finally {
      setBusy(false);
    }
  }

  return gift.inventoryLoadedAt ? (
    <Text size="sm">Loaded {when(gift.inventoryLoadedAt)} as {gift.inventorySourceKey}: {gift.lines.length} line{gift.lines.length === 1 ? "" : "s"}, each at the quantity above.</Text>
  ) : (
    <Alert color="red" title="Goods not loaded into inventory">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm">The load for {gift.inventorySourceKey} failed or has not run.</Text>
        {canWrite && <Button size="xs" variant="light" color="red" loading={busy} onClick={() => void retry()}>Load again</Button>}
      </Group>
    </Alert>
  );
}

/** One in-kind gift: its donor, date and value, lines, file, state, where it went and its history. */
function InKindGiftPage({ source }: { source: InKindSource }) {
  const { id } = useParams<{ id: string }>();
  const gift = useLoad<Gift>(`/in-kind/${source}/${id}`);
  const back = <Anchor href="/donations/in-kind" size="sm">← In-kind queue</Anchor>;

  if (gift.error) return <Stack>{back}<LoadError what="this in-kind gift" message={gift.error} onRetry={gift.reload} /></Stack>;
  const g = gift.data;
  if (!g) return <Text>Loading…</Text>;
  const isManual = g.source === "manual";

  return (
    <Stack>
      {back}
      <Group justify="space-between">
        <Title order={3}>In-kind gift</Title>
        <Group gap="xs">
          {g.outcome && <Badge variant="light">{OUTCOME[g.outcome] ?? g.outcome}</Badge>}
          {g.state ? <Badge color={IN_KIND_STATE[g.state].color}>{IN_KIND_STATE[g.state].label}</Badge> : <Badge color="gray">Nothing left to do</Badge>}
        </Group>
      </Group>
      {g.withdrawnAfterMoneyAt && (
        <Alert color="red">
          The in-kind mark was cleared {when(g.withdrawnAfterMoneyAt)}, after the money arrived.
          {g.withdrawalSettledAt ? ` Settled ${when(g.withdrawalSettledAt)}; the donor was cleared.` : ""}
        </Alert>
      )}
      {g.replayConflictAt && <Alert color="red">The receipt was resent with different values {when(g.replayConflictAt)}.</Alert>}
      {g.donorReplacedAt && <Alert color="yellow">The donor was replaced {when(g.donorReplacedAt)}.</Alert>}

      <Group align="flex-start" grow wrap="wrap">
        <Stack gap={4} miw={280}>
          <Text>Donor: {donorName(g)}</Text>
          <Text>Date: {g.receiptDate ?? g.donationDate ?? "—"}</Text>
          <Text>Value: {g.totalValueCents === null ? "Not set yet" : formatCents(g.totalValueCents)}</Text>
          <Text>
            Source:{" "}
            {isManual ? (
              `Recorded without a receipt${g.recordedByUsername ? ` by ${g.recordedByUsername}` : ""}, ${when(g.recordedAt)}`
            ) : (
              <Anchor href={`/receipts/${g.receiptId}`}>Receipt {g.receiptId}</Anchor>
            )}
          </Text>
          <Text>File: {isManual ? "None; recorded without a receipt" : <Anchor href={`/receipts/${g.receiptId}`}>on the receipt</Anchor>}</Text>
        </Stack>
        <Stack gap={4} miw={280}>
          <Text>Decision: {g.outcome ? `${OUTCOME[g.outcome] ?? g.outcome}, ${when(g.decidedAt)}` : "Not decided yet"}</Text>
          <Text>Bucket: {g.budgetOwnerName ?? "—"}{g.bucketHeld ? " (archived or has no Class)" : ""}</Text>
          <Text>Bookings: revenue {g.revenueBooking ?? "—"}, expense {g.expenseBooking ?? "—"}</Text>
        </Stack>
      </Group>

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Item</Table.Th><Table.Th>GTIN</Table.Th><Table.Th>Quantity</Table.Th><Table.Th>Value</Table.Th>
            {isManual && <Table.Th>Suggested</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {g.lines.map((l) => (
            <Table.Tr key={l.id}>
              <Table.Td>{l.description ?? l.gtin13 ?? "—"}</Table.Td>
              <Table.Td>{l.gtin13 ?? "—"}</Table.Td>
              <Table.Td>{l.quantity}</Table.Td>
              <Table.Td>{l.valueCents === null ? "—" : formatCents(l.valueCents)}</Table.Td>
              {isManual && <Table.Td>{l.suggestedValueCents === null ? "—" : formatCents(l.suggestedValueCents)}</Table.Td>}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Paper withBorder p="sm">
        <Text fw={500} size="sm" mb="xs">Inventory</Text>
        <InventoryPanel gift={g} onReload={gift.reload} />
      </Paper>

      <Paper withBorder p="sm">
        <Text fw={500} size="sm" mb="xs">History</Text>
        {g.events.length === 0 && <Text size="xs" c="dimmed">No history recorded.</Text>}
        {g.events.map((e) => (
          <Text key={e.id} size="xs">
            {when(e.occurredAt)} · {e.actorUsername ?? "system"} · {EVENT[e.eventType] ?? e.eventType}{eventDetail(e)}
          </Text>
        ))}
      </Paper>
    </Stack>
  );
}

/** /donations/in-kind/receipt/[id] — an in-kind gift that arrived with a receipt. */
export function ReceiptGiftPage() {
  return <InKindGiftPage source="receipt" />;
}

/** /donations/in-kind/manual/[id] — an in-kind gift recorded without a receipt; its goods load as `donation:<id>`. */
export function ManualGiftPage() {
  return <InKindGiftPage source="manual" />;
}
