"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Center, Stack, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useRequireRole } from "@/hooks/useRequireRole";
import { formatPhone } from "@/lib/phone";

import { PageLoader } from "@/components/ui/PageLoader";
type BoardMember = {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
};

export default function BoardContactInfoPage() {
  const { ready, loading: authLoading } = useRequireRole(['isSysadmin', 'isBoardMember', 'isKeyholder']);

  const [members, setMembers] = useState<BoardMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchMembers = useCallback(() => fetch('/api/safety/board-contacts')
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members || []);
      } else {
        setError("Failed to load board contacts. Ensure you have the proper authorizations.");
      }
    })
    .catch((e) => {
      console.error("Failed to load board contacts:", e);
      notifications.show({ color: "red", message: "Network error loading board contacts.", autoClose: false });
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => {
    if (ready) fetchMembers();
  }, [ready, fetchMembers]);

  if (authLoading || loading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  if (error) {
    return (
      <Center mih="60vh">
        <Title order={3} c="red">{error}</Title>
      </Center>
    );
  }

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
