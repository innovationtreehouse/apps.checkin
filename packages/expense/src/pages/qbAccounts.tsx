"use client";
import { useState } from "react";
import { ActionIcon, Button, Group, Table, Text, TextInput, Title } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { send, useLoad, useRoles } from "../components/api";
import LoadError from "../components/LoadError";
import ExpenseSubNav from "../components/ExpenseSubNav";

interface QbAccount {
  id: number;
  name: string;
  qbAccount: string;
}

/** /expense/qb-accounts — the QuickBooks accounts account-mapping rules and holds may name. */
export default function QbAccountsPage() {
  const { isFinance } = useRoles();
  const accounts = useLoad<QbAccount[]>("/qb-accounts");
  const [name, setName] = useState("");
  const [qbAccount, setQbAccount] = useState("");

  return (
    <>
      <ExpenseSubNav current="/expense/qb-accounts" />
      <Title order={3} mb="md">QuickBooks accounts</Title>
      {accounts.error && <LoadError what="QuickBooks accounts" message={accounts.error} onRetry={accounts.reload} />}
      <Table maw={640}>
        <Table.Tbody>
          {(accounts.data ?? []).map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td>{a.name}</Table.Td>
              <Table.Td>{a.qbAccount}</Table.Td>
              <Table.Td>
                {isFinance && (
                  <ActionIcon variant="subtle" color="red" aria-label="Delete account" onClick={async () => { if (await send(`/qb-accounts/${a.id}`, "DELETE", {}, "Account deleted")) accounts.reload(); }}>
                    <IconTrash size={16} />
                  </ActionIcon>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {accounts.data?.length === 0 && <Text c="dimmed" mt="sm">No accounts yet.</Text>}
      {isFinance && (
        <Group mt="md" align="end">
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <TextInput label="QuickBooks account" value={qbAccount} onChange={(e) => setQbAccount(e.currentTarget.value)} />
          <Button
            disabled={!name.trim() || !qbAccount.trim()}
            onClick={async () => { if (await send("/qb-accounts", "POST", { name, qbAccount }, "Account added")) { setName(""); setQbAccount(""); accounts.reload(); } }}
          >Add</Button>
        </Group>
      )}
    </>
  );
}
