"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge, Button, Card, Center, Checkbox, Group, Loader, Modal, Select, Stack, Switch, Table, Text, TextInput, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
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

const UNREACHABLE = "Couldn't reach the server. Check your connection and try again.";

/** Sends a write; returns null on success, else a message saying why it failed. */
async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return UNREACHABLE;
  }
  return res.ok ? null : failureMessage(res);
}

type Loaded<T> = { ok: true; data: T } | { ok: false; error: string };

/** Reads a list; never throws, so a failed read can always be shown. */
async function get<T>(url: string): Promise<Loaded<T>> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  if (!res.ok) return { ok: false, error: await failureMessage(res) };
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, error: `The server sent an unreadable reply (${res.status}).` };
  }
}

async function failureMessage(res: Response): Promise<string> {
  const data: unknown = await res.json().catch(() => null);
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
    return `${data.error} (${res.status})`;
  }
  // No JSON error body: the reply came from in front of the app, not from its routes.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return `The server is unavailable (${res.status}). Try again in a minute.`;
  }
  return `The server returned an unexpected error (${res.status}).`;
}

function showError(title: string, message: string) {
  notifications.show({ color: "red", title, message, autoClose: false });
}

export default function BudgetsPage() {
  const { user, loading: authLoading, ready } = useRequireRole(["isFinance", "isBoardMember"]);
  const isFinance = !!user?.isFinance;
  const isBoard = !!user?.isBoardMember;

  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [programs, setPrograms] = useState<ProgramOption[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);

  const [newName, setNewName] = useState("");
  const [newProgramId, setNewProgramId] = useState<string | null>(null);
  const [newClassId, setNewClassId] = useState("");

  const [editing, setEditing] = useState<Bucket | null>(null);
  const [editName, setEditName] = useState("");
  const [editClassId, setEditClassId] = useState("");

  const [treasurerBucket, setTreasurerBucket] = useState<Bucket | null>(null);

  const load = useCallback(() => Promise.all([
    get<Bucket[]>(`/api/budget-owners${showArchived ? "?includeArchived=1" : ""}`),
    get<ProgramOption[]>("/api/budget-owners/program-options"),
  ]).then(([b, p]) => {
    if (b.ok) setBuckets(b.data); else showError("Buckets not loaded", b.error);
    if (p.ok) setPrograms(p.data); else showError("Programs not loaded", p.error);
    setLoading(false);
  }), [showArchived]);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  const run = async (url: string, method: string, body: unknown, done: string, failed: string) => {
    const error = await send(url, method, body);
    if (error) { showError(failed, error); return false; }
    notifications.show({ message: done });
    setLoading(true);
    await load();
    return true;
  };

  const create = async () => {
    const ok = await run("/api/budget-owners", "POST", {
      name: newName,
      programId: newProgramId ? Number(newProgramId) : null,
      quickBooksClassId: newClassId || null,
    }, "Bucket created.", "Bucket not created");
    if (ok) { setNewName(""); setNewProgramId(null); setNewClassId(""); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const ok = await run(`/api/budget-owners/${editing.id}`, "PATCH", {
      name: editName,
      quickBooksClassId: editClassId || null,
    }, "Bucket saved.", "Bucket not saved");
    if (ok) setEditing(null);
  };

  const archive = (bucket: Bucket) => {
    if (!window.confirm(`Archive "${bucket.name}"? It stays on record but leaves the active list.`)) return;
    void run(`/api/budget-owners/${bucket.id}/archive`, "POST", undefined, "Bucket archived.", "Bucket not archived");
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
              <TextInput label="QuickBooks Class id" description="Expenses in this bucket post to QuickBooks only once it is set" error={classIdError(newClassId)} value={newClassId} onChange={(e) => setNewClassId(e.currentTarget.value)} w={200} />
              <Button onClick={create} disabled={!newName.trim() || classIdError(newClassId) !== null}>Create</Button>
            </Group>
          </Card>
        )}

        <Checkbox
          label="Show archived"
          checked={showArchived}
          onChange={(e) => { setLoading(true); setShowArchived(e.currentTarget.checked); }}
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
          <TextInput label="QuickBooks Class id" error={classIdError(editClassId)} value={editClassId} onChange={(e) => setEditClassId(e.currentTarget.value)} />
          <Button onClick={saveEdit} disabled={!editName.trim() || classIdError(editClassId) !== null}>Save</Button>
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

/** The server's Class id rule: empty, or a numeric QuickBooks id. */
function classIdError(value: string): string | null {
  const id = value.trim();
  return id && !/^\d+$/.test(id) ? "Digits only: the Class's QuickBooks id" : null;
}

function TreasurersModal({ programId, programName, canEdit, onClose }: {
  programId: number;
  programName: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<TreasurerRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    void get<TreasurerRow[]>(`/api/programs/${programId}/treasurers`).then((result) => {
      if (!live) return;
      if (result.ok) { setRows(result.data); setLoadFailed(false); return; }
      showError("Treasurers not loaded", result.error);
      setLoadFailed(true);
    });
    return () => { live = false; };
  }, [programId, version]);

  const toggle = async (row: TreasurerRow, on: boolean) => {
    const failure = await send(`/api/programs/${row.programId}/treasurers/${row.personId}`, on ? "PUT" : "DELETE");
    if (failure) showError("Treasurer not updated", failure);
    setVersion((v) => v + 1);
  };

  return (
    <Modal opened onClose={onClose} title={`Treasurers — ${programName}`}>
      <Stack>
        <Text size="sm" c="dimmed">
          Treasurers come from the Board-approved program budget; only the Board sets them. Nobody may
          set themself or anyone in their own household.
        </Text>
        {rows === null && loadFailed ? (
          <Text c="dimmed">Treasurers couldn&apos;t be loaded.</Text>
        ) : rows === null ? (
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
