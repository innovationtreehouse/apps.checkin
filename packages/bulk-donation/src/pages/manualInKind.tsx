"use client";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { notifications } from "@mantine/notifications";
import { ActionIcon, Badge, Button, Group, NumberInput, Paper, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { act, api, cents, errorMessage, paged, useLoad, when } from "../components/api";
import LoadError from "../components/LoadError";
import Pager from "../components/Pager";

interface LineRow { id: number; gtin13: string; description: string | null; quantity: number; valueCents: number | null; suggestedValueCents: number | null }
interface DonationRow {
  id: number;
  donationDate: string;
  recordedByUsername: string | null;
  recordedAt: string;
  inventoryLoadedAt: string | null;
  lines: LineRow[];
  /** Present only in the finance and board views. */
  donorFirstName?: string;
  donorLastName?: string;
  donorCompanyName?: string | null;
}
interface CatalogItem { gtin13: string; name: string }
interface FormLine { gtin13: string; name: string; description: string; quantity: number; suggestedDollars: number | null }

// en-CA formats as YYYY-MM-DD in the viewer's own time zone.
const today = () => new Date().toLocaleDateString("en-CA");

/**
 * Whether the session may record. Mirrors the write routes' gate (FINANCE,
 * OPERATIONS or INVENTORY_MANAGER; BOARD reads only), read through a narrow
 * cast because the library does not type the host's session user.
 */
function useCanRecord(): boolean {
  const { data } = useSession();
  const u = data?.user as { isFinance?: boolean; isOperations?: boolean; isInventoryManager?: boolean } | undefined;
  return !!u?.isFinance || !!u?.isOperations || !!u?.isInventoryManager;
}

/** Catalog items matching the typed text, from the catalog's own search route. */
function useCatalogSearch(q: string): CatalogItem[] {
  const [items, setItems] = useState<CatalogItem[]>([]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      api<CatalogItem[]>(`/api/catalog/items?q=${encodeURIComponent(term)}&limit=20`)
        .then((rows) => { if (live) setItems(rows); })
        .catch(() => { if (live) setItems([]); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return items;
}

/** /inventory/in-kind — goods given without a receipt: record each item and quantity, then load it into stock. Finance sets the value when accepting. */
export default function ManualInKindPage() {
  const canRecord = useCanRecord();
  const [page, setPage] = useState(1);
  const rows = useLoad<DonationRow[]>(paged("/in-kind/manual", page));

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [donationDate, setDonationDate] = useState(today());
  const [lines, setLines] = useState<FormLine[]>([]);
  const [search, setSearch] = useState("");
  const found = useCatalogSearch(search);
  const [saving, setSaving] = useState(false);

  const showDonor = (rows.data ?? []).some((r) => r.donorLastName !== undefined);
  const ready = firstName.trim() !== "" && lastName.trim() !== "" && lines.length > 0 && !!donationDate;

  function addItem(gtin13: string | null) {
    const item = found.find((i) => i.gtin13 === gtin13);
    if (item && !lines.some((l) => l.gtin13 === item.gtin13)) {
      setLines([...lines, { gtin13: item.gtin13, name: item.name, description: item.name, quantity: 1, suggestedDollars: null }]);
    }
    setSearch("");
  }

  function setLine(i: number, patch: Partial<FormLine>) {
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function record() {
    setSaving(true);
    try {
      const body = JSON.stringify({
        donor: { firstName: firstName.trim(), lastName: lastName.trim(), companyName: companyName.trim() || null },
        donationDate,
        lines: lines.map((l) => ({
          gtin13: l.gtin13,
          quantity: l.quantity,
          description: l.description.trim() || null,
          suggestedValueCents: l.suggestedDollars === null ? null : Math.round(l.suggestedDollars * 100),
        })),
      });
      const res = await api<{ inventoryLoaded: boolean }>("/in-kind/manual", { method: "POST", body });
      setFirstName(""); setLastName(""); setCompanyName(""); setDonationDate(today()); setLines([]);
      notifications.show(res.inventoryLoaded
        ? { message: "Gift recorded and loaded into inventory", color: "green" }
        : { message: "Gift recorded, but loading it into inventory failed. Use Retry load in the list.", color: "yellow" });
      rows.reload();
    } catch (e) {
      notifications.show({ message: errorMessage(e), color: "red" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Title order={3} mb="md">In-kind gifts without a receipt</Title>
      {canRecord && (
        <Paper withBorder p="md" radius="md" mb="md" maw={820}>
          <Stack>
            <Text size="sm" c="dimmed">
              Enter who gave the goods. You cannot record a gift from yourself or your own household. A value is optional:
              it is a suggestion, and finance sets the value when accepting the gift.
            </Text>
            <Group grow align="flex-end">
              <TextInput label="Donor first name" required value={firstName} onChange={(e) => setFirstName(e.currentTarget.value)} />
              <TextInput label="Donor last name" required value={lastName} onChange={(e) => setLastName(e.currentTarget.value)} />
              <TextInput label="Company (optional)" value={companyName} onChange={(e) => setCompanyName(e.currentTarget.value)} />
              <TextInput label="Date given" type="date" required value={donationDate} onChange={(e) => setDonationDate(e.currentTarget.value)} />
            </Group>
            <Select
              label="Add a catalog item"
              placeholder="Search by name or GTIN"
              searchable
              searchValue={search}
              onSearchChange={setSearch}
              data={found.map((i) => ({ value: i.gtin13, label: `${i.name} (${i.gtin13})` }))}
              value={null}
              onChange={addItem}
              filter={({ options }) => options}
              nothingFoundMessage={search.trim().length < 2 ? "Type at least two characters" : "No matching items"}
            />
            {lines.length > 0 && (
              <Table>
                <Table.Thead>
                  <Table.Tr><Table.Th>Item</Table.Th><Table.Th>Description</Table.Th><Table.Th>Quantity</Table.Th><Table.Th>Suggested total value ($)</Table.Th><Table.Th /></Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {lines.map((l, i) => (
                    <Table.Tr key={l.gtin13}>
                      <Table.Td>{l.name}</Table.Td>
                      <Table.Td>
                        <TextInput
                          aria-label={`Description of ${l.name}`}
                          description="Describe the goods, not the donor"
                          maxLength={500}
                          value={l.description}
                          onChange={(e) => setLine(i, { description: e.currentTarget.value })}
                        />
                      </Table.Td>
                      <Table.Td>
                        <NumberInput aria-label={`Quantity of ${l.name}`} min={1} allowDecimal={false} value={l.quantity} onChange={(v) => setLine(i, { quantity: Number(v) || 1 })} w={100} />
                      </Table.Td>
                      <Table.Td>
                        <NumberInput
                          aria-label={`Suggested total value of ${l.name}`}
                          min={0}
                          decimalScale={2}
                          value={l.suggestedDollars ?? ""}
                          onChange={(v) => setLine(i, { suggestedDollars: v === "" ? null : Number(v) || 0 })}
                          w={140}
                        />
                      </Table.Td>
                      <Table.Td>
                        <ActionIcon variant="subtle" color="red" aria-label={`Remove ${l.name}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</ActionIcon>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
            <Group>
              <Button onClick={record} disabled={!ready} loading={saving}>Record gift</Button>
            </Group>
          </Stack>
        </Paper>
      )}
      {rows.error && <LoadError what="in-kind gifts" message={rows.error} onRetry={rows.reload} />}
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Date given</Table.Th>
            {showDonor && <Table.Th>Donor</Table.Th>}
            <Table.Th>Items</Table.Th>
            <Table.Th>Value</Table.Th>
            <Table.Th>Recorded</Table.Th>
            <Table.Th>Inventory</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(rows.data ?? []).map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>{r.donationDate}</Table.Td>
              {showDonor && (
                <Table.Td>
                  {r.donorFirstName} {r.donorLastName}
                  {r.donorCompanyName ? ` (${r.donorCompanyName})` : ""}
                </Table.Td>
              )}
              <Table.Td>{r.lines.reduce((n, l) => n + l.quantity, 0)} across {r.lines.length} line{r.lines.length === 1 ? "" : "s"}</Table.Td>
              <Table.Td>
                {r.lines.every((l) => l.valueCents !== null)
                  ? cents(r.lines.reduce((n, l) => n + (l.valueCents ?? 0), 0))
                  : r.lines.some((l) => l.suggestedValueCents !== null)
                    ? `${cents(r.lines.reduce((n, l) => n + (l.suggestedValueCents ?? 0), 0))} suggested`
                    : "—"}
              </Table.Td>
              <Table.Td>{when(r.recordedAt)}{r.recordedByUsername ? ` by ${r.recordedByUsername}` : ""}</Table.Td>
              <Table.Td>
                {r.inventoryLoadedAt ? (
                  <Badge color="green" variant="light">Loaded</Badge>
                ) : canRecord ? (
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    onClick={() => act(() => api(`/in-kind/manual/${r.id}/load-inventory`, { method: "POST" }), "Loaded into inventory", rows.reload)}
                  >
                    Retry load
                  </Button>
                ) : (
                  <Badge color="red" variant="light">Not loaded</Badge>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Pager page={page} onChange={setPage} rows={rows.data} />
    </>
  );
}
