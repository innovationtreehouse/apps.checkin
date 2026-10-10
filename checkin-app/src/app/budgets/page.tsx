"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge, Button, Card, Center, Checkbox, Group, Loader, Modal, Select, Stack, Switch, Table, Text, TextInput, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { AlertBanner } from "@/components/admin/AlertBanner";
import { PageLoader } from "@/components/ui/PageLoader";
import { PageContainer } from "@/components/ui/PageContainer";
import { useRequireRole } from "@/hooks/useRequireRole";

interface Bucket {
  id: number;
  name: string;
  programId: number | null;
  archivedAt: string | null;
  quickBooksClassId: string | null;
  program: { id: number; name: string } | null;
}

interface ProgramOption {
  id: number;
  name: string;
}

interface TreasurerRow {
  programId: number;
  personId: number;
  isTreasurer: boolean;
  person: { id: number; name: string };
}

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return typeof data.error === "string" ? data.error : "Request failed.";
}

export default function BudgetsPage() {
  const { user, loading: authLoading, ready } = useRequireRole(["isFinance", "isBoardMember"]);
  const isFinance = !!user?.isFinance;
  const isBoard = !!user?.isBoardMember;

  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [programs, setPrograms] = useState<ProgramOption[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const [newName, setNewName] = useState("");
  const [newProgramId, setNewProgramId] = useState<string | null>(null);
  const [newClassId, setNewClassId] = useState("");

  const [editing, setEditing] = useState<Bucket | null>(null);
  const [editName, setEditName] = useState("");
  const [editClassId, setEditClassId] = useState("");

  const [treasurerBucket, setTreasurerBucket] = useState<Bucket | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b, p] = await Promise.all([
        fetch(`/api/budget-owners${showArchived ? "?includeArchived=1" : ""}`),
        fetch("/api/budget-owners/program-options"),
      ]);
      if (b.ok) setBuckets(await b.json());
      if (p.ok) setPrograms(await p.json());
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  const run = async (url: string, method: string, body: unknown, done: string) => {
    setMessage("");
    const error = await send(url, method, body);
    if (error) { setMessage(error); return false; }
    notifications.show({ message: done });
    await load();
    return true;
  };

  const create = async () => {
    const ok = await run("/api/budget-owners", "POST", {
      name: newName,
      programId: newProgramId ? Number(newProgramId) : null,
      quickBooksClassId: newClassId || null,
    }, "Bucket created.");
    if (ok) { setNewName(""); setNewProgramId(null); setNewClassId(""); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const ok = await run(`/api/budget-owners/${editing.id}`, "PATCH", {
      name: editName,
      quickBooksClassId: editClassId || null,
    }, "Bucket saved.");
    if (ok) setEditing(null);
  };

  const archive = (bucket: Bucket) => {
    if (!window.confirm(`Archive "${bucket.name}"? It stays on record but leaves the active list.`)) return;
    void run(`/api/budget-owners/${bucket.id}/archive`, "POST", undefined, "Bucket archived.");
  };

  if (authLoading) return <PageLoader />;
  if (!ready) return null;

  return (
    <PageContainer>
      <Stack>
        <Title order={2}>Budgets</Title>
        <Text c="dimmed">
          Budget-owner buckets. A program bucket is approved by the program&apos;s leader and its
          treasurers; an org-level bucket has no approvers.
        </Text>
        <AlertBanner message={message} tone="error" />

        {isFinance && (
          <Card withBorder radius="md" padding="lg">
            <Title order={4} mb="sm">New bucket</Title>
            <Group align="flex-end" wrap="wrap">
              <TextInput label="Name" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} w={240} />
              <Select
                label="Program"
                placeholder="Org-level"
                clearable
                searchable
                data={programs.map((p) => ({ value: String(p.id), label: p.name }))}
                value={newProgramId}
                onChange={setNewProgramId}
                w={260}
              />
              <TextInput label="QuickBooks Class id" value={newClassId} onChange={(e) => setNewClassId(e.currentTarget.value)} w={200} />
              <Button onClick={create} disabled={!newName.trim()}>Create</Button>
            </Group>
          </Card>
        )}

        <Checkbox
          label="Show archived"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.currentTarget.checked)}
        />

        {loading ? (
          <Center py="xl"><Loader /></Center>
        ) : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Program</Table.Th>
                <Table.Th>QuickBooks Class</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {buckets.map((b) => (
                <Table.Tr key={b.id}>
                  <Table.Td>{b.name}</Table.Td>
                  <Table.Td>{b.program?.name ?? <Text c="dimmed" size="sm">Org-level</Text>}</Table.Td>
                  <Table.Td>{b.quickBooksClassId ?? <Text c="dimmed" size="sm">Unmapped</Text>}</Table.Td>
                  <Table.Td>
                    {b.archivedAt ? <Badge color="gray">Archived</Badge> : <Badge color="green">Active</Badge>}
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" justify="flex-end">
                      {b.programId !== null && (
                        <Button size="xs" variant="light" onClick={() => setTreasurerBucket(b)}>Treasurers</Button>
                      )}
                      {isFinance && (
                        <Button
                          size="xs"
                          variant="light"
                          onClick={() => { setEditing(b); setEditName(b.name); setEditClassId(b.quickBooksClassId ?? ""); }}
                        >
                          Edit
                        </Button>
                      )}
                      {isFinance && !b.archivedAt && (
                        <Button size="xs" variant="light" color="red" onClick={() => archive(b)}>Archive</Button>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
              {buckets.length === 0 && (
                <Table.Tr><Table.Td colSpan={5}><Text c="dimmed">No buckets.</Text></Table.Td></Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        )}
      </Stack>

      <Modal opened={editing !== null} onClose={() => setEditing(null)} title="Edit bucket">
        <Stack>
          <TextInput label="Name" value={editName} onChange={(e) => setEditName(e.currentTarget.value)} />
          <TextInput label="QuickBooks Class id" value={editClassId} onChange={(e) => setEditClassId(e.currentTarget.value)} />
          <Button onClick={saveEdit} disabled={!editName.trim()}>Save</Button>
        </Stack>
      </Modal>

      {treasurerBucket?.programId != null && (
        <TreasurersModal
          key={treasurerBucket.id}
          programId={treasurerBucket.programId}
          programName={treasurerBucket.program?.name ?? ""}
          canEdit={isBoard}
          onClose={() => setTreasurerBucket(null)}
        />
      )}
    </PageContainer>
  );
}

function TreasurersModal({ programId, programName, canEdit, onClose }: {
  programId: number;
  programName: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<TreasurerRow[] | null>(null);
  const [error, setError] = useState("");

  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`/api/programs/${programId}/treasurers`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: TreasurerRow[]) => { if (live) setRows(data); });
    return () => { live = false; };
  }, [programId, version]);

  const toggle = async (row: TreasurerRow, on: boolean) => {
    setError("");
    const failure = await send(`/api/programs/${row.programId}/treasurers/${row.personId}`, on ? "PUT" : "DELETE");
    if (failure) setError(failure);
    setVersion((v) => v + 1);
  };

  return (
    <Modal opened onClose={onClose} title={`Treasurers — ${programName}`}>
      <Stack>
        <Text size="sm" c="dimmed">
          Treasurers come from the Board-approved program budget; only the Board sets them. Nobody may
          set themself or anyone in their own household.
        </Text>
        <AlertBanner message={error} tone="error" />
        {rows === null ? (
          <Center><Loader size="sm" /></Center>
        ) : rows.length === 0 ? (
          <Text c="dimmed">This program has no volunteers.</Text>
        ) : (
          rows.map((row) => (
            <Switch
              key={row.personId}
              label={row.person.name}
              checked={row.isTreasurer}
              disabled={!canEdit}
              onChange={(e) => toggle(row, e.currentTarget.checked)}
            />
          ))
        )}
      </Stack>
    </Modal>
  );
}
