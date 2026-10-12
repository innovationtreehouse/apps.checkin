"use client";
import { useState } from "react";
import { Button, Group, Modal, Stack, Table, TextInput, Title } from "@mantine/core";
import { act, api, useCanWrite, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface RuleRow {
  id: number;
  companyName: string;
  corporatePeerCampaign: string;
  donationMethod: string | null;
  donationType: string | null;
  donationAccount: string;
  matchAccount: string;
  feesAccount: string;
}
type Form = Omit<RuleRow, "id" | "donationMethod" | "donationType"> & { donationMethod: string; donationType: string };

const EMPTY: Form = { companyName: "*", corporatePeerCampaign: "*", donationMethod: "", donationType: "", donationAccount: "", matchAccount: "", feesAccount: "" };
const FIELDS: Array<[keyof Form, string]> = [
  ["companyName", "Company (* for any)"],
  ["corporatePeerCampaign", "Campaign (* for any)"],
  ["donationMethod", "Donation method (blank matches none)"],
  ["donationType", "Donation type (blank matches none)"],
  ["donationAccount", "Donation account"],
  ["matchAccount", "Match account"],
  ["feesAccount", "Fees account"],
];

/** /donations/account-map — the rules that pick each gift's ledger accounts; exactly one must match. */
export default function AccountMapPage() {
  const canWrite = useCanWrite();
  const rules = useLoad<RuleRow[]>("/account-map");
  const [editing, setEditing] = useState<{ id: number | null; form: Form } | null>(null);

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
      {rules.error && <LoadError what="account map" message={rules.error} onRetry={rules.reload} />}
      <Table striped>
        <Table.Thead>
          <Table.Tr>{FIELDS.map(([k, label]) => <Table.Th key={k}>{label.replace(/ \(.*\)/, "")}</Table.Th>)}<Table.Th /></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(rules.data ?? []).map((r) => (
            <Table.Tr key={r.id}>
              {FIELDS.map(([k]) => <Table.Td key={k}>{r[k] ?? "—"}</Table.Td>)}
              <Table.Td>
                {canWrite && (
                  <Group gap="xs" wrap="nowrap">
                    <Button size="xs" variant="light" onClick={() => setEditing({
                      id: r.id, form: { ...r, donationMethod: r.donationMethod ?? "", donationType: r.donationType ?? "" },
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
            {FIELDS.map(([k, label]) => (
              <TextInput key={k} label={label} value={editing.form[k]}
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, [k]: e.currentTarget.value } })} />
            ))}
            <Button onClick={save}>Save</Button>
          </Stack>
        )}
      </Modal>
    </>
  );
}
