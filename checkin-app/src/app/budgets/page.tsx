"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge, Button, Card, Center, Checkbox, Group, Loader, Modal, Select, Stack, Switch, Table, Text, TextInput, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { PageLoader } from "@/components/ui/PageLoader";
import { useRequireRole } from "@/hooks/useRequireRole";

interface Bucket {
  id: number;
  name: string;
  programId: number | null;
  archivedAt: string | null;
  quickBooksClassId: string | null;
  program: { id: number; name: string } | null;
}

interface ClassOption {
  id: string;
  name: string;
  active: boolean;
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

// One chip per action, keyed by its title: a new failure replaces it and a success clears it.
function showError(title: string, message: string) {
  notifications.hide(title);
  notifications.show({ id: title, color: "red", title, message, autoClose: false });
}

function clearError(title: string) {
  notifications.hide(title);
}

export default function BudgetsPage() {
  const { user, loading: authLoading, ready } = useRequireRole(["isFinance", "isBoardMember"]);
  const isFinance = !!user?.isFinance;
  const isBoard = !!user?.isBoardMember;

  const [allBuckets, setAllBuckets] = useState<Bucket[]>([]);
  const [programs, setPrograms] = useState<ProgramOption[]>([]);
  const [classes, setClasses] = useState<ClassOption[] | null>(null);
  const [classesFailed, setClassesFailed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);

  const [newName, setNewName] = useState("");
  const [newProgramId, setNewProgramId] = useState<string | null>(null);
  const [newClassId, setNewClassId] = useState<string | null>(null);

  const [editing, setEditing] = useState<Bucket | null>(null);
  const [editName, setEditName] = useState("");
  const [editClassId, setEditClassId] = useState<string | null>(null);

  const [treasurerBucket, setTreasurerBucket] = useState<Bucket | null>(null);

  // Archived buckets are always loaded: their Classes stay taken, so the picker must not offer them.
  const load = useCallback(() => Promise.all([
    get<Bucket[]>("/api/budget-owners?includeArchived=1"),
    get<ProgramOption[]>("/api/budget-owners/program-options"),
    get<ClassOption[]>("/api/budget-owners/quickbooks-classes"),
  ]).then(([b, p, c]) => {
    if (b.ok) { setAllBuckets(b.data); clearError("Buckets not loaded"); } else showError("Buckets not loaded", b.error);
    if (p.ok) { setPrograms(p.data); clearError("Programs not loaded"); } else showError("Programs not loaded", p.error);
    setClassesFailed(!c.ok);
    if (c.ok) { setClasses(c.data); clearError("QuickBooks Classes unavailable"); } else showError("QuickBooks Classes unavailable", c.error);
    setLoading(false);
  }), []);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  const run = async (url: string, method: string, body: unknown, done: string, failed: string) => {
    clearError(failed);
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
      quickBooksClassId: newClassId,
    }, "Bucket created.", "Bucket not created");
    if (ok) { setNewName(""); setNewProgramId(null); setNewClassId(null); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const ok = await run(`/api/budget-owners/${editing.id}`, "PATCH", {
      name: editName,
      quickBooksClassId: editClassId,
    }, "Bucket saved.", "Bucket not saved");
    if (ok) setEditing(null);
  };

  const archive = (bucket: Bucket) => {
    if (!window.confirm(`Archive "${bucket.name}"? It stays on record but leaves the active list.`)) return;
    void run(`/api/budget-owners/${bucket.id}/archive`, "POST", undefined, "Bucket archived.", "Bucket not archived");
  };

  const buckets = showArchived ? allBuckets : allBuckets.filter((b) => !b.archivedAt);
  const classNames = new Map((classes ?? []).map((c) => [c.id, c.active ? c.name : `${c.name} (inactive)`]));
  const takenBy = new Map(allBuckets.filter((b) => b.quickBooksClassId).map((b) => [b.quickBooksClassId, b.id]));
  const className = (id: string) => classNames.get(id) ?? `QuickBooks id ${id}`;
  // Active Classes no other bucket holds, plus `keep` (the bucket's saved Class and the current pick)
  // even when inactive or missing from the list, so the picker never drops a Class it is showing.
  const classChoices = (bucketId: number | null, keep: (string | null)[]) => {
    const kept = new Set(keep.filter((id): id is string => id !== null));
    const options = (classes ?? [])
      .filter((c) => kept.has(c.id) || (c.active && (takenBy.get(c.id) ?? bucketId) === bucketId))
      .map((c) => ({ value: c.id, label: classNames.get(c.id) ?? c.name }));
    for (const id of kept) if (!options.some((o) => o.value === id)) options.push({ value: id, label: className(id) });
    return options;
  };
  const classPlaceholder = (empty: string) => (classes ? empty : classesFailed ? "Classes unavailable" : "Loading…");

  if (authLoading) return <PageLoader />;
  if (!ready) return null;

  return (
    <>
      <Stack>
        <Title order={2}>Budgets</Title>
        <Text c="dimmed">
          A bucket is a budget that spending, income and gifts are booked to. Its lines post to QuickBooks under
          the bucket&apos;s QuickBooks Class, so a bucket without one holds its lines until finance sets it here. A
          bucket is not a QuickBooks account: the account says what the money was spent on, and Account mapping
          picks it. A program bucket is approved by the program&apos;s leader and its treasurers; an org-level
          bucket has no approvers.
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
              <Select
                label="QuickBooks Class"
                description="Expenses in this bucket post to QuickBooks only once it is set"
                placeholder={classPlaceholder("None yet")}
                clearable
                searchable
                data={classChoices(null, [newClassId])}
                value={newClassId}
                onChange={setNewClassId}
                w={280}
              />
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
                  <Table.Td>{b.quickBooksClassId ? className(b.quickBooksClassId) : <Text c="dimmed" size="sm">Unmapped</Text>}</Table.Td>
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
                          onClick={() => { setEditing(b); setEditName(b.name); setEditClassId(b.quickBooksClassId); }}
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
          <Select
            label="QuickBooks Class"
            placeholder={classPlaceholder("None")}
            clearable
            searchable
            data={editing ? classChoices(editing.id, [editing.quickBooksClassId, editClassId]) : []}
            value={editClassId}
            onChange={setEditClassId}
          />
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
    </>
  );
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
      if (result.ok) { setRows(result.data); setLoadFailed(false); clearError("Treasurers not loaded"); return; }
      showError("Treasurers not loaded", result.error);
      setLoadFailed(true);
    });
    return () => { live = false; };
  }, [programId, version]);

  const toggle = async (row: TreasurerRow, on: boolean) => {
    clearError("Treasurer not updated");
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
