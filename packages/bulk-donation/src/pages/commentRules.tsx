"use client";
import { Button, Table, Text, Title } from "@mantine/core";
import { act, api, ownerName, useCanWrite, useLoad, useOwners, when } from "../components/api";
import LoadError from "../components/LoadError";

interface RuleRow { id: number; comment: string; ownerId: number; createdAt: string }

/** /donations/comment-rules — donor comments that assign an owner automatically. */
export default function CommentRulesPage() {
  const canWrite = useCanWrite();
  const rules = useLoad<RuleRow[]>("/comment-rules");
  const owners = useOwners();

  return (
    <>
      <Title order={3} mb="md">Comment rules</Title>
      <Text size="sm" c="dimmed" mb="md">Created from the unassigned queue; an exact comment match assigns the owner at upload.</Text>
      {rules.error && <LoadError what="comment rules" message={rules.error} onRetry={rules.reload} />}
      <Table striped>
        <Table.Thead>
          <Table.Tr><Table.Th>Comment</Table.Th><Table.Th>Owner</Table.Th><Table.Th>Created</Table.Th><Table.Th /></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(rules.data ?? []).map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>{r.comment}</Table.Td>
              <Table.Td>{ownerName(owners.data, r.ownerId)}</Table.Td>
              <Table.Td>{when(r.createdAt)}</Table.Td>
              <Table.Td>
                {canWrite && (
                  <Button size="xs" variant="light" color="red"
                    onClick={() => act(() => api(`/comment-rules/${r.id}`, { method: "DELETE" }), "Rule deleted", rules.reload)}>
                    Delete
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
