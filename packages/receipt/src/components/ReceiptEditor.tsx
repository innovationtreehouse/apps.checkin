"use client";
import { formatCents } from "@checkin/money";
import { Button, Checkbox, Divider, Group, Paper, Stack, Table, Text, TextInput } from "@mantine/core";
import { MAX_LINE_ITEMS } from "../lib/schemas";
import {
  canAddLine,
  draftBalance,
  draftHeader,
  EMPTY_LINE,
  lineFromServer,
  toDollars,
  totalTyped,
  type Balance,
  type Draft,
  type DraftLine,
  type Header,
  type ServerReceipt,
} from "./receiptDraft";

interface Props {
  receipt: ServerReceipt;
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** Show that a tax or date change sends the receipt to finance review. */
  taxNote: boolean;
}

const shown = (cents: number | null) => (cents === null ? "—" : formatCents(cents));

function balanceText({ math, differenceCents, disagreements }: Balance): string {
  if (!math || differenceCents === null) return "Difference: —";
  if (math.balanced) return "Matches the receipt total";
  if (disagreements.length > 0) return disagreements.join("; ");
  return `Difference: ${formatCents(differenceCents)}`;
}

/** Every field of a receipt and its lines, editable, with the sum its total must equal. */
export default function ReceiptEditor({ receipt, draft, onChange, taxNote }: Props) {
  const header = draftHeader(receipt, draft);
  const kept = receipt.lineItems.filter((l) => !draft.removed.includes(l.id));
  const keptLines = kept.map((l) => {
    const line = { ...lineFromServer(l), ...draft.lines[l.id] };
    return { id: l.id, line, typed: totalTyped(draft.lines[l.id]?.total) };
  });
  const lineCount = kept.length + draft.added.length;

  const setHeader = (field: keyof Header, value: string) => onChange({ ...draft, header: { ...draft.header, [field]: value } });
  const setLine = (id: number, patch: Partial<DraftLine>) =>
    onChange({ ...draft, lines: { ...draft.lines, [id]: { ...draft.lines[id], ...patch } } });
  const setAdded = (key: number, patch: Partial<DraftLine>) =>
    onChange({ ...draft, added: draft.added.map((a) => (a.key === key ? { ...a, ...patch } : a)) });
  const removeLine = (id: number) => onChange({ ...draft, removed: [...draft.removed, id] });
  const removeAdded = (key: number) => onChange({ ...draft, added: draft.added.filter((a) => a.key !== key) });
  const addLine = () =>
    onChange({ ...draft, added: [...draft.added, { ...EMPTY_LINE, key: Math.max(0, ...draft.added.map((a) => a.key)) + 1 }] });

  const balance = draftBalance(receipt, draft);

  // A typed total shows as typed; otherwise the field shows the total the server would store.
  const row = (key: string, line: DraftLine, typed: boolean, total: number | null, set: (patch: Partial<DraftLine>) => void, remove: () => void, label: string) => (
    <Table.Tr key={key}>
      <Table.Td>
        <TextInput size="xs" aria-label={`${label} description`} value={line.description} onChange={(e) => set({ description: e.currentTarget.value })} />
      </Table.Td>
      <Table.Td>
        <TextInput size="xs" aria-label={`${label} part number`} value={line.partNumber} onChange={(e) => set({ partNumber: e.currentTarget.value })} />
      </Table.Td>
      <Table.Td>
        <TextInput size="xs" aria-label={`${label} manufacturer`} value={line.manufacturer} onChange={(e) => set({ manufacturer: e.currentTarget.value })} />
      </Table.Td>
      <Table.Td>
        <TextInput size="xs" inputMode="decimal" aria-label={`${label} quantity`} value={line.quantity} onChange={(e) => set({ quantity: e.currentTarget.value })} />
      </Table.Td>
      <Table.Td>
        <TextInput size="xs" inputMode="decimal" leftSection="$" aria-label={`${label} unit price`} value={line.unitPrice} onChange={(e) => set({ unitPrice: e.currentTarget.value })} />
      </Table.Td>
      <Table.Td>
        <TextInput
          size="xs"
          inputMode="decimal"
          leftSection="$"
          aria-label={`${label} total`}
          value={typed ? line.total : total === null ? "" : toDollars(total)}
          onChange={(e) => set({ total: e.currentTarget.value })}
        />
      </Table.Td>
      <Table.Td>
        <Checkbox size="xs" aria-label={`${label} backordered`} checked={line.isDelayed} onChange={(e) => set({ isDelayed: e.currentTarget.checked })} />
      </Table.Td>
      <Table.Td>
        {lineCount > 1 && (
          <Button size="compact-xs" variant="subtle" color="red" aria-label={`Remove ${label}`} onClick={remove}>Remove</Button>
        )}
      </Table.Td>
    </Table.Tr>
  );

  const amount = (label: string, field: keyof Header) => (
    <Group gap="xs" justify="flex-end" wrap="nowrap">
      <Text size="sm">{label}</Text>
      <TextInput size="xs" w={120} inputMode="decimal" leftSection="$" aria-label={label} value={header[field]} onChange={(e) => setHeader(field, e.currentTarget.value)} />
    </Group>
  );

  return (
    <Paper withBorder p="sm">
      <Stack gap="sm">
        <Text fw={500} size="sm">Correct the receipt</Text>
        <Group grow wrap="wrap">
          <TextInput label="Retailer" miw={200} value={header.retailer} onChange={(e) => setHeader("retailer", e.currentTarget.value)} />
          <TextInput label="Date" type="date" miw={160} value={header.receiptDate} onChange={(e) => setHeader("receiptDate", e.currentTarget.value)} />
        </Group>

        <Table.ScrollContainer minWidth={820}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Description</Table.Th>
                <Table.Th w={110}>Part #</Table.Th>
                <Table.Th w={130}>Manufacturer</Table.Th>
                <Table.Th w={80}>Qty</Table.Th>
                <Table.Th w={120}>Unit price</Table.Th>
                <Table.Th w={120}>Total</Table.Th>
                <Table.Th w={100}>Backordered</Table.Th>
                <Table.Th w={80} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {keptLines.map(({ id, line, typed }, i) => row(`line-${id}`, line, typed, balance.lineTotalsCents[i], (p) => setLine(id, p), () => removeLine(id), `Line ${i + 1}`))}
              {draft.added.map((a, i) =>
                row(`added-${a.key}`, a, totalTyped(a.total), balance.lineTotalsCents[keptLines.length + i], (p) => setAdded(a.key, p), () => removeAdded(a.key), `Line ${keptLines.length + i + 1}`),
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {canAddLine(receipt, draft) ? (
          <Button size="xs" variant="subtle" w="fit-content" onClick={addLine}>+ Add line</Button>
        ) : (
          <Text size="xs" c="dimmed">A receipt holds at most {MAX_LINE_ITEMS} lines; save any removals to make room.</Text>
        )}

        <Divider />
        <Stack gap={6} align="flex-end">
          <Text size="sm">Lines subtotal: <Text span ff="monospace">{shown(balance.subtotalCents)}</Text></Text>
          {amount("+ Shipping", "shipping")}
          {amount("+ Tax", "tax")}
          {amount("− Discount", "discount")}
          <Text size="sm" fw={600}>Calculated: <Text span ff="monospace">{shown(balance.calculatedCents)}</Text></Text>
          {amount("Receipt total", "receiptTotal")}
          <Text size="sm" fw={600} c={balance.math?.balanced ? "green" : "red"}>
            {balanceText(balance)}
          </Text>
          {taxNote && <Text size="xs" c="dimmed">Changing the tax or date sends this receipt to finance review.</Text>}
        </Stack>
      </Stack>
    </Paper>
  );
}
