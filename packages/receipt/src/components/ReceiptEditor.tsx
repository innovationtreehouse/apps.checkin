"use client";
import { formatCents } from "@checkin/money";
import { Button, Checkbox, Divider, Group, Paper, Stack, Table, Text, TextInput } from "@mantine/core";
import { MAX_LINE_ITEMS } from "../lib/schemas";
import {
  calculatedCents,
  canAddLine,
  differenceDollars,
  draftHeader,
  EMPTY_LINE,
  headerMath,
  lineCents,
  lineFromServer,
  roundingAllowed,
  type Draft,
  type DraftLine,
  type Header,
  type ServerReceipt,
} from "./receiptDraft";
import type { ReceiptMath } from "../lib/lineMath";

interface Props {
  receipt: ServerReceipt;
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** Show that a tax or date change sends the receipt to finance review. */
  taxNote: boolean;
}

const lineTotal = (line: DraftLine) => {
  const cents = lineCents(line);
  return cents === null ? "—" : formatCents(Math.round(cents));
};

function balanceText(math: ReceiptMath | null): string {
  if (!math) return "Difference: —";
  if (math.differenceCents === 0) return "Matches the receipt total";
  const difference = differenceDollars(math.differenceCents);
  return math.balanced
    ? `Matches within rounding: ${difference} off${roundingAllowed(math.allowedCents)}`
    : `Difference: ${difference}${roundingAllowed(math.allowedCents)}`;
}

/** Every field of a receipt and its lines, editable, with the sum its total must equal. */
export default function ReceiptEditor({ receipt, draft, onChange, taxNote }: Props) {
  const header = draftHeader(receipt, draft);
  const kept = receipt.lineItems.filter((l) => !draft.removed.includes(l.id));
  const keptLines = kept.map((l) => ({ id: l.id, line: { ...lineFromServer(l), ...draft.lines[l.id] } }));
  const lineCount = kept.length + draft.added.length;
  const allLines = [...keptLines.map((k) => k.line), ...draft.added];

  const setHeader = (field: keyof Header, value: string) => onChange({ ...draft, header: { ...draft.header, [field]: value } });
  const setLine = (id: number, patch: Partial<DraftLine>) =>
    onChange({ ...draft, lines: { ...draft.lines, [id]: { ...draft.lines[id], ...patch } } });
  const setAdded = (key: number, patch: Partial<DraftLine>) =>
    onChange({ ...draft, added: draft.added.map((a) => (a.key === key ? { ...a, ...patch } : a)) });
  const removeLine = (id: number) => onChange({ ...draft, removed: [...draft.removed, id] });
  const removeAdded = (key: number) => onChange({ ...draft, added: draft.added.filter((a) => a.key !== key) });
  const addLine = () =>
    onChange({ ...draft, added: [...draft.added, { ...EMPTY_LINE, key: Math.max(0, ...draft.added.map((a) => a.key)) + 1 }] });

  const subtotal = allLines.map(lineCents).reduce<number | null>((a, b) => (a === null || b === null ? null : a + b), 0);
  const calculated = calculatedCents(allLines, header);
  const math = headerMath(allLines, header);

  const row = (key: string, line: DraftLine, set: (patch: Partial<DraftLine>) => void, remove: () => void, label: string) => (
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
      <Table.Td ta="right">
        <Text size="sm" ff="monospace">{lineTotal(line)}</Text>
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
                <Table.Th w={100} ta="right">Total</Table.Th>
                <Table.Th w={100}>Backordered</Table.Th>
                <Table.Th w={80} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {keptLines.map(({ id, line }, i) => row(`line-${id}`, line, (p) => setLine(id, p), () => removeLine(id), `Line ${i + 1}`))}
              {draft.added.map((a, i) =>
                row(`added-${a.key}`, a, (p) => setAdded(a.key, p), () => removeAdded(a.key), `Line ${keptLines.length + i + 1}`),
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
          <Text size="sm">Lines subtotal: <Text span ff="monospace">{subtotal === null ? "—" : formatCents(Math.round(subtotal))}</Text></Text>
          {amount("+ Shipping", "shipping")}
          {amount("+ Tax", "tax")}
          {amount("− Discount", "discount")}
          <Text size="sm" fw={600}>Calculated: <Text span ff="monospace">{calculated === null ? "—" : formatCents(Math.round(calculated))}</Text></Text>
          {amount("Receipt total", "receiptTotal")}
          <Text size="sm" fw={600} c={math?.balanced ? "green" : "red"}>
            {balanceText(math)}
          </Text>
          {taxNote && <Text size="xs" c="dimmed">Changing the tax or date sends this receipt to finance review.</Text>}
        </Stack>
      </Stack>
    </Paper>
  );
}
