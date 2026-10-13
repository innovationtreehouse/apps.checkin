"use client";
import { Badge, Button, Anchor, Table, Text, Title } from "@mantine/core";
import { send, useLoad } from "../components/api";
import LoadError from "../components/LoadError";
import ExpenseSubNav from "../components/ExpenseSubNav";

interface Flag {
  id: number;
  expenseId: string;
  kind: string;
  audience: string;
  detail: string | null;
  raisedAt: string;
}

/** /expense/flags — open flags for the caller's audience (FINANCE, Board); checking one off is audited. */
export default function FlagsPage() {
  const flags = useLoad<Flag[]>("/flags");
  return (
    <>
      <ExpenseSubNav current="/expense/flags" />
      <Title order={3} mb="md">Flags</Title>
      {flags.error && <LoadError what="flags" message={flags.error} onRetry={flags.reload} />}
      {flags.data?.length === 0 && <Text c="dimmed">No open flags.</Text>}
      <Table>
        <Table.Tbody>
          {(flags.data ?? []).map((f) => (
            <Table.Tr key={f.id}>
              <Table.Td><Badge variant="light" color={f.audience === "BOARD" ? "grape" : "blue"}>{f.kind}</Badge></Table.Td>
              <Table.Td><Anchor href={`/expense/expenses/${encodeURIComponent(f.expenseId)}`}>{f.expenseId}</Anchor></Table.Td>
              <Table.Td>{f.detail ?? ""}</Table.Td>
              <Table.Td>{new Date(f.raisedAt).toLocaleDateString()}</Table.Td>
              <Table.Td>
                <Button size="xs" variant="light" onClick={async () => { if (await send(`/flags/${f.id}/check-off`, "POST", {}, "Checked off")) flags.reload(); }}>
                  Check off
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
