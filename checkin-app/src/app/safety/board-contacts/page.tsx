"use client";

import { Card, Stack, Table, Text } from "@mantine/core";
import { LoadError } from "@checkin/component-ui";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useLoad } from "@/lib/api";
import { SAFETY_ROLES } from "@/lib/nav/sections/safety";
import { formatPhone } from "@/lib/phone";

import { PageLoader } from "@/components/ui/PageLoader";
type BoardMember = {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
};

export default function BoardContactInfoPage() {
  const { ready, loading: authLoading } = useRequireRole(SAFETY_ROLES);

  const { data, error, reload } = useLoad<{ members?: BoardMember[] }>(ready ? "/api/safety/board-contacts" : null);

  if (authLoading) return <PageLoader />;
  if (!ready) return null;
  if (error) return <LoadError what="board contacts" message={error} onRetry={reload} />;
  if (!data) return <PageLoader />;

  const members = data.members ?? [];

  return (
    <Stack>
      <Card withBorder radius="md" padding="lg">
        <Text c="dimmed">
          Directory of current board members and their contact details.
        </Text>
      </Card>

      <Card withBorder radius="md" padding="lg">
        {members.length > 0 ? (
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Phone</Table.Th>
                <Table.Th>Email</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {members.map((m) => (
                <Table.Tr key={m.id}>
                  <Table.Td>{m.name || `Member #${m.id}`}</Table.Td>
                  <Table.Td>{m.phone ? formatPhone(m.phone) : "Not Provided"}</Table.Td>
                  <Table.Td>{m.email || "Not Provided"}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : (
          <Text c="dimmed">No board members found.</Text>
        )}
      </Card>
    </Stack>
  );
}
