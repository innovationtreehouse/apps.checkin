"use client";
import { useState } from "react";
import { Button, Group, Modal, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { act, api, paged, useCanWrite, useLoad } from "../components/api";
import { LoadError, Pager } from "@checkin/component-ui";
import { LINE_ACCOUNT_TYPES } from "@checkin/quickbooks/accountTypes";

interface RuleRow {
  id: number;
  companyName: string;
  corporatePeerCampaign: string;
  donationMethod: string | null;
  donationType: string | null;
  donationAccount: string;
  matchAccount: string;
  donationAccountId: string | null;
  matchAccountId: string | null;
}

/** A QuickBooks account as the books map lists it, live from QuickBooks. */
interface AccountOption { id: string; name: string; accountType: string; active: boolean }

const GIFT_TYPES: readonly string[] = LINE_ACCOUNT_TYPES.givingGift;

type MatchField = "companyName" | "corporatePeerCampaign" | "donationMethod" | "donationType";
type Form = Record<MatchField, string> & { donationAccountId: string | null; matchAccountId: string | null };

const EMPTY: Form = { companyName: "*", corporatePeerCampaign: "*", donationMethod: "", donationType: "", donationAccountId: null, matchAccountId: null };
const MATCH_FIELDS: Array<[MatchField, string]> = [
  ["companyName", "Company (* for any)"],
  ["corporatePeerCampaign", "Campaign (* for any)"],
  ["donationMethod", "Donation method (blank matches none)"],
  ["donationType", "Donation type (blank matches none)"],
];
const ACCOUNT_FIELDS: Array<["donationAccountId" | "matchAccountId", string]> = [
  ["donationAccountId", "Donation account"],
  ["matchAccountId", "Match account"],
];

/** Picker choices: active accounts of a type a gift books to, plus the saved one even when inactive, mistyped or gone from QuickBooks. */
function choices(options: AccountOption[] | null, saved: string | null) {
  const list = (options ?? []).filter((o) => (o.active && GIFT_TYPES.includes(o.accountType)) || o.id === saved).map((o) => ({ value: o.id, label: o.active ? o.name : `${o.name} (inactive)` }));
  if (saved && !list.some((o) => o.value === saved)) list.push({ value: saved, label: `QuickBooks id ${saved}` });
  return list;
}

/** What finance typed as account names before rules named QuickBooks accounts. */
function earlierNames(r: RuleRow): string {
  return [r.donationAccount, r.matchAccount].some(Boolean) ? `${r.donationAccount || "—"} / ${r.matchAccount || "—"}` : "—";
}

/**
 * /donations/account-map — the rules that pick each gift's QuickBooks accounts. Exactly one rule
 * must match a gift, and it needs an account for each amount the gift carries.
 */
export default function AccountMapPage() {
  const canWrite = useCanWrite();
  const [page, setPage] = useState(1);
  const rules = useLoad<RuleRow[]>(paged("/account-map", page), { keepPrevious: true });
  const accounts = useLoad<AccountOption[]>("/api/books-map/quickbooks-accounts");
  const [editing, setEditing] = useState<{ id: number | null; form: Form } | null>(null);
  const accountName = (id: string | null) => (id ? (choices(accounts.data, id).find((o) => o.value === id)?.label ?? id) : "Not set");

  async function save() {
    if (!editing) return;
    const body = JSON.stringify(editing.form);
    const ok = await act(
      () => editing.id === null
        ? api("/account-map", { method: "POST", body })
        : api(`/account-map/${editing.id}`, { method: "PUT", body }),
      "Rule saved", rules.reload,
    );
    if (ok) setEditing(null);
  }

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Account map</Title>
        {canWrite && <Button size="xs" onClick={() => setEditing({ id: null, form: EMPTY })}>Add rule</Button>}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        A gift whose rule has no account for its donation or match holds its disbursement until you pick one.
      </Text>
      {rules.error && <LoadError what="account map" message={rules.error} onRetry={rules.reload} />}
      {accounts.error && <LoadError what="QuickBooks accounts" message={accounts.error} onRetry={accounts.reload} />}
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            {MATCH_FIELDS.map(([k, label]) => <Table.Th key={k}>{label.replace(/ \(.*\)/, "")}</Table.Th>)}
            {ACCOUNT_FIELDS.map(([k, label]) => <Table.Th key={k}>{label}</Table.Th>)}
            <Table.Th>Earlier names (donation / match)</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(rules.data ?? []).map((r) => (
            <Table.Tr key={r.id}>
              {MATCH_FIELDS.map(([k]) => <Table.Td key={k}>{r[k] ?? "—"}</Table.Td>)}
              {ACCOUNT_FIELDS.map(([k]) => <Table.Td key={k}>{accountName(r[k])}</Table.Td>)}
              <Table.Td>{earlierNames(r)}</Table.Td>
              <Table.Td>
                {canWrite && (
                  <Group gap="xs" wrap="nowrap">
                    <Button size="xs" variant="light" onClick={() => setEditing({
                      id: r.id,
                      form: {
                        companyName: r.companyName,
                        corporatePeerCampaign: r.corporatePeerCampaign,
                        donationMethod: r.donationMethod ?? "",
                        donationType: r.donationType ?? "",
                        donationAccountId: r.donationAccountId,
                        matchAccountId: r.matchAccountId,
                      },
                    })}>Edit</Button>
                    <Button size="xs" variant="light" color="red"
                      onClick={() => act(() => api(`/account-map/${r.id}`, { method: "DELETE" }), "Rule deleted", rules.reload)}>Delete</Button>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal opened={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? "Edit rule" : "Add rule"}>
        {editing && (
          <Stack>
            {MATCH_FIELDS.map(([k, label]) => (
              <TextInput key={k} label={label} value={editing.form[k]}
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, [k]: e.currentTarget.value } })} />
            ))}
            {ACCOUNT_FIELDS.map(([k, label]) => (
              <Select key={k} label={label} placeholder="Not set" searchable clearable
                data={choices(accounts.data, editing.form[k])} value={editing.form[k]}
                onChange={(v) => setEditing({ ...editing, form: { ...editing.form, [k]: v } })} />
            ))}
            <Button onClick={save}>Save</Button>
          </Stack>
        )}
      </Modal>
      <Pager page={page} onChange={setPage} rows={rules.data} />
    </>
  );
}
