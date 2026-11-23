"use client";
import { useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import { Alert, Anchor, Badge, Button, Group, NumberInput, Paper, Select, Stack, Switch, Table, Text, Title } from "@mantine/core";
import { act, api, errorMessage, isRefusal, loadError, ownerName, useCanWrite, useLoad, useOwners, when, type OwnerOption } from "../components/api";
import { formatGtinDisplay } from "@checkin/gtin";
import { formatCents } from "@checkin/money";
import { LoadError, showError, showSuccess } from "@checkin/component-ui";
import { IN_KIND_STATE, type InKindSource, type WaitingOn } from "../components/inKindState";

interface GiftLine {
  id: number;
  gtin13: string | null;
  description: string | null;
  quantity: number;
  valueCents: number | null;
  suggestedValueCents: number | null;
  isCapital: boolean | null;
  depreciationYears: number | null;
  capitalBucketId: number | null;
  registeredAt: string | null;
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
  replayConflictAt: string | null;
  outcome: string | null;
  decidedAt: string | null;
  budgetOwnerId: number | null;
  budgetOwnerName: string | null;
  bucketHeld: boolean;
  capitalReviewNeeded: boolean | null;
  totalValueCents: number | null;
  state: WaitingOn | null;
  waitingOn: WaitingOn[];
  revenueBooking: string | null;
  expenseBooking: string | null;
  qbFirstFailedAt?: string | null;
  qbLastError?: string | null;
  inventorySourceKey: string | null;
  inventoryLoadedAt: string | null;
  inventoryLoadFailureReason: string | null;
  lines: GiftLine[];
  events: GiftEvent[];
}

const OUTCOME: Record<string, string> = { ACCEPTED: "Accepted", REFUSED: "Refused", RETURNED: "Returned" };

const EVENT: Record<string, string> = {
  IN_KIND_MONEY_RECEIVED: "Receipt values received",
  IN_KIND_DONOR_RECORDED: "Donor recorded",
  IN_KIND_REPLAY_CONFLICT: "Receipt resent with different values",
  IN_KIND_REPLAY_SETTLED: "Kept the first values",
  IN_KIND_DECIDED: "Decided",
  IN_KIND_BUCKET_CHANGED: "Bucket changed",
  MANUAL_IN_KIND_RECORDED: "Recorded without a receipt",
  IN_KIND_CAPITAL_DESIGNATED: "Capital designation set",
  IN_KIND_CAPITAL_PERIOD_SET: "Depreciation period set",
  IN_KIND_CAPITAL_REGISTERED: "Assets registered",
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
  const [refusal, setRefusal] = useState<string | null>(null);

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
      showSuccess("Goods loaded into inventory");
      onReload();
    } catch (e) {
      if (isRefusal(e)) setRefusal(e.message);
      else showError(errorMessage(loadError(e)), { title: "Goods not loaded into inventory" });
    } finally {
      setBusy(false);
    }
  }

  return gift.inventoryLoadedAt ? (
    <Text size="sm">Loaded {when(gift.inventoryLoadedAt)} as {gift.inventorySourceKey}: {gift.lines.length} line{gift.lines.length === 1 ? "" : "s"}, each at the quantity above.</Text>
  ) : (
    <Alert color="red" title="Goods not loaded into inventory">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm">
          {refusal ??
            (gift.inventoryLoadFailureReason
              ? `The load for ${gift.inventorySourceKey} failed: ${gift.inventoryLoadFailureReason}`
              : `The load for ${gift.inventorySourceKey} failed or has not run.`)}
        </Text>
        {canWrite &&
          (refusal ? (
            <Button size="xs" variant="light" color="red" disabled>Can&apos;t be loaded: adjust stock by hand</Button>
          ) : (
            <Button size="xs" variant="light" color="red" loading={busy} onClick={() => void retry()}>Load again</Button>
          ))}
      </Group>
    </Alert>
  );
}

const lineName = (l: GiftLine) => l.description ?? (l.gtin13 ? formatGtinDisplay(l.gtin13) : "—");

function capitalCell(l: GiftLine, owners: readonly OwnerOption[] | null): string {
  if (l.isCapital === null) return "—";
  if (!l.isCapital) return "Not capital";
  const period = l.depreciationYears === null ? "period not set" : `${l.depreciationYears} years`;
  return `Capital, ${period}, ${ownerName(owners, l.capitalBucketId)}${l.registeredAt ? ", registered" : ""}`;
}

/**
 * Finance's capital review of an accepted gift over a capital threshold, in the purchase's two steps:
 * designate every line, then set each capital line's period and owner. The drain then registers it.
 */
function CapitalPanel({ gift, onDone }: { gift: Gift; onDone: () => void }) {
  const owners = useOwners();
  const canWrite = useCanWrite();
  const designating = gift.lines.some((l) => l.isCapital === null);
  const capital = gift.lines.filter((l) => l.isCapital);
  const [marks, setMarks] = useState<Record<number, boolean>>({});
  const [years, setYears] = useState<Record<number, number | "">>({});
  const [ownerOf, setOwnerOf] = useState<Record<number, string | null>>({});
  const [busy, setBusy] = useState(false);
  const defaultOwner = (l: GiftLine) => String(l.capitalBucketId ?? gift.budgetOwnerId ?? "");
  const ownerOptions = (owners.data ?? []).map((o) => ({ value: String(o.id), label: o.name }));
  const owner = (l: GiftLine) => ownerOf[l.id] ?? defaultOwner(l);

  async function submit(body: unknown, step: "capital-review" | "set-depreciation-cycle", ok: string) {
    setBusy(true);
    await act(() => api(`/in-kind/${gift.source}/${gift.id}/${step}`, { method: "POST", body: JSON.stringify(body) }), ok, onDone);
    setBusy(false);
  }

  if (!canWrite) return <Text size="sm">Waiting on finance&apos;s capital review.</Text>;
  let form: ReactNode;
  if (designating) {
    const body = { lineItems: gift.lines.map((l) => ({ lineItemId: l.id, isCapital: marks[l.id] ?? false, ...(marks[l.id] && owner(l) ? { capitalOwnerId: Number(owner(l)) } : {}) })) };
    form = (
      <>
        <Text size="sm">This gift meets a capital threshold. Mark each line that is a capital asset.</Text>
        {gift.lines.map((l) => (
          <Switch key={l.id} label={lineName(l)} checked={marks[l.id] ?? false} onChange={(e) => setMarks({ ...marks, [l.id]: e.currentTarget.checked })} />
        ))}
        <Group><Button loading={busy} onClick={() => void submit(body, "capital-review", "Capital designation saved")}>Save designation</Button></Group>
      </>
    );
  } else {
    const ready = capital.every((l) => typeof years[l.id] === "number" && owner(l));
    const body = { items: capital.map((l) => ({ lineItemId: l.id, depreciationYears: Number(years[l.id]), ownerId: Number(owner(l)) })) };
    form = (
      <>
        <Text size="sm">Set each capital line&apos;s depreciation period and owner. The assets get their numbers before the gift books.</Text>
        {capital.map((l) => (
          <Group key={l.id} align="flex-end">
            <Text size="sm" w={220}>{lineName(l)}</Text>
            <NumberInput label="Years" min={1} w={100} value={years[l.id] ?? ""} onChange={(v) => setYears({ ...years, [l.id]: typeof v === "number" ? v : "" })} />
            <Select label="Owner" data={ownerOptions} w={240} value={owner(l) || null} onChange={(v) => setOwnerOf({ ...ownerOf, [l.id]: v })} />
          </Group>
        ))}
        <Group><Button loading={busy} disabled={!ready} onClick={() => void submit(body, "set-depreciation-cycle", "Depreciation period saved")}>Save period</Button></Group>
      </>
    );
  }
  return <Stack gap="xs">{form}</Stack>;
}

/** One in-kind gift: its donor, date and value, lines, file, state, where it went and its history. */
function InKindGiftPage({ source }: { source: InKindSource }) {
  const { id } = useParams<{ id: string }>();
  const gift = useLoad<Gift>(`/in-kind/${source}/${id}`);
  const owners = useOwners();
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
          {g.qbFirstFailedAt && <Text size="sm" c="red">Last error: {g.qbLastError ?? "no error recorded"}</Text>}
        </Stack>
      </Group>

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Item</Table.Th><Table.Th>Part ID</Table.Th><Table.Th>Quantity</Table.Th><Table.Th>Value</Table.Th>
            {isManual && <Table.Th>Suggested</Table.Th>}
            {g.capitalReviewNeeded && <Table.Th>Capital</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {g.lines.map((l) => (
            <Table.Tr key={l.id}>
              <Table.Td>{lineName(l)}</Table.Td>
              <Table.Td>{l.gtin13 ? formatGtinDisplay(l.gtin13) : "—"}</Table.Td>
              <Table.Td>{l.quantity}</Table.Td>
              <Table.Td>{l.valueCents === null ? "—" : formatCents(l.valueCents)}</Table.Td>
              {isManual && <Table.Td>{l.suggestedValueCents === null ? "—" : formatCents(l.suggestedValueCents)}</Table.Td>}
              {g.capitalReviewNeeded && <Table.Td>{capitalCell(l, owners.data)}</Table.Td>}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      {g.waitingOn.includes("capital") && (
        <Paper withBorder p="sm">
          <Text fw={500} size="sm" mb="xs">Capital review</Text>
          <CapitalPanel gift={g} onDone={gift.reload} />
        </Paper>
      )}

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
