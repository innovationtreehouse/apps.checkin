"use client";
import { useEffect, useState } from "react";
import { Button, Stack, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { formatItemId } from "../lib/gtin";
import { api, errorMessage } from "./api";
import LoadError from "./LoadError";
import type { ConversionChallengeRow } from "./viewTypes";

const PAGE_LIMIT = 200;

export default function ConversionChallengesClient() {
  const [challenges, setChallenges] = useState<ConversionChallengeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      setChallenges(await api<ConversionChallengeRow[]>(`/conversion-challenges?page=1&limit=${PAGE_LIMIT}`));
      setError(null);
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function handleAccept(id: number) {
    setActing(id);
    try {
      await api(`/conversion-challenges/${id}/accept`, { method: "POST" });
      notifications.show({ message: "Challenge accepted — conversion factor updated", color: "green" });
      await load();
    } catch (e) { notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" }); }
    finally { setActing(null); }
  }

  async function handleReject(id: number) {
    setActing(id);
    try {
      await api(`/conversion-challenges/${id}/reject`, { method: "POST" });
      notifications.show({ message: "Challenge rejected", color: "orange" });
      await load();
    } catch (e) { notifications.show({ message: e instanceof Error ? e.message : "Error", color: "red" }); }
    finally { setActing(null); }
  }

  function keyLabel(c: ConversionChallengeRow) {
    return c.itemReference.partNumber ?? c.itemReference.descriptionNormalized ?? "—";
  }

  return (
    <>
      <Title order={3} mb="xs">Conversion Factor Challenges</Title>
      <Text size="sm" c="dimmed" mb="md">Organization managers have flagged these learned conversion factors as incorrect. Accepting updates the factor and increments the version; rejecting leaves it unchanged.</Text>

      {error ? <LoadError what="conversion challenges" message={error} onRetry={load} /> : loading ? <Text c="dimmed">Loading…</Text> : challenges.length === 0 ? (
        <Text c="dimmed">No pending conversion factor challenges.</Text>
      ) : (
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Organization</Table.Th>
              <Table.Th>Item</Table.Th>
              <Table.Th>Manufacturer</Table.Th>
              <Table.Th>Key</Table.Th>
              <Table.Th>Current</Table.Th>
              <Table.Th>Proposed</Table.Th>
              <Table.Th>Reason</Table.Th>
              <Table.Th>Submitted</Table.Th>
              <Table.Th w={160}>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {challenges.map((c) => (
              <Table.Tr key={c.id}>
                <Table.Td>{c.orgName}</Table.Td>
                <Table.Td>
                  <Text size="sm">{c.itemReference.item.name}</Text>
                  <Text size="xs" c="dimmed" ff="monospace">{formatItemId(c.itemReference.gtin13)}</Text>
                </Table.Td>
                <Table.Td>{c.itemReference.manufacturer ?? <Text c="dimmed" size="sm">—</Text>}</Table.Td>
                <Table.Td><Text size="sm" ff={c.itemReference.partNumber ? "monospace" : undefined}>{keyLabel(c)}</Text></Table.Td>
                <Table.Td><Text size="sm">{c.currentFactor}x</Text></Table.Td>
                <Table.Td><Text size="sm" fw={600} c="blue">{c.proposedFactor}x</Text></Table.Td>
                <Table.Td maw={200}><Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{c.reason}</Text></Table.Td>
                <Table.Td>{new Date(c.createdAt).toLocaleDateString()}</Table.Td>
                <Table.Td>
                  <Stack gap={4}>
                    <Button size="xs" color="green" loading={acting === c.id} onClick={() => handleAccept(c.id)}>Accept</Button>
                    <Button size="xs" color="red" variant="light" loading={acting === c.id} onClick={() => handleReject(c.id)}>Reject</Button>
                  </Stack>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </>
  );
}
