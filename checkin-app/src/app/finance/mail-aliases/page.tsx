"use client";

import { useState } from "react";
import { Badge, Button, Group, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { LoadError, errorMessage } from "@checkin/component-ui";
import { PageLoader } from "@/components/ui/PageLoader";
import { useRequireRole } from "@/hooks/useRequireRole";
import { api, useLoad } from "@/lib/api";
import { FINANCE_ROLES } from "@/lib/nav/sections/finance";

interface Alias {
  id: number;
  address: string;
  approvedAt: string | null;
  person: { name: string; email: string | null };
}

const API = "/api/finance/mail-aliases";

/** Sends the request; on failure shows why. Returns whether it worked. */
async function send(url: string, init?: RequestInit): Promise<boolean> {
  try {
    await api(url, init);
    return true;
  } catch (e) {
    notifications.show({ color: "red", title: "Mail aliases", message: errorMessage(e), autoClose: false });
    return false;
  }
}

export default function MailAliasesPage() {
  const { loading, ready } = useRequireRole(FINANCE_ROLES);
  const { data, error, reload } = useLoad<{ PersonMailAlias: Alias[] }>(ready ? API : null);
  const aliases = data?.PersonMailAlias ?? null;
  const [personEmail, setPersonEmail] = useState("");
  const [address, setAddress] = useState("");

  if (loading || !ready) return <PageLoader />;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const done = await send(API, { method: "POST", body: JSON.stringify({ personEmail, address }) });
    if (done) {
      setPersonEmail("");
      setAddress("");
    }
  };
  const act = (url: string, method: "POST" | "DELETE") => void send(url, { method });

  return (
    <Stack>
      <Title order={2}>Mail aliases</Title>
      <Text c="dimmed">
        Extra addresses a person&apos;s receipt mail may come from. A new alias counts once you approve it, after mail from it with a passing sender check has been assigned to that person.
      </Text>
      <form onSubmit={add}>
        <Group align="flex-end">
          <TextInput required type="email" label="Person's sign-in email" value={personEmail} onChange={(e) => setPersonEmail(e.currentTarget.value)} />
          <TextInput required type="email" label="Address to add" value={address} onChange={(e) => setAddress(e.currentTarget.value)} />
          <Button type="submit">Add</Button>
        </Group>
      </form>
      {error && <LoadError what="mail aliases" message={error} onRetry={reload} />}
      {!aliases && !error && <PageLoader minHeight="20vh" />}
      {aliases && !error && (
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Address</Table.Th>
            <Table.Th>Person</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {aliases.map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td>{a.address}</Table.Td>
              <Table.Td>
                {a.person.name} ({a.person.email ?? "no sign-in email"})
              </Table.Td>
              <Table.Td>{a.approvedAt ? <Badge color="green">Approved</Badge> : <Badge color="yellow">Waiting for first mail</Badge>}</Table.Td>
              <Table.Td>
                <Group gap="xs" justify="flex-end">
                  {!a.approvedAt && (
                    <Button size="xs" onClick={() => act(`${API}/${a.id}/approve`, "POST")}>
                      Approve
                    </Button>
                  )}
                  <Button size="xs" color="red" variant="light" onClick={() => act(`${API}/${a.id}`, "DELETE")}>
                    Remove
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      )}
      {aliases?.length === 0 && !error && <Text c="dimmed">No aliases yet.</Text>}
    </Stack>
  );
}
