"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge, Button, Card, Center, Checkbox, Group, Loader, Modal, Select, Stack, Table, Text, TextInput, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { AlertBanner } from "@/components/admin/AlertBanner";
import { PageLoader } from "@/components/ui/PageLoader";
import { useRequireRole } from "@/hooks/useRequireRole";

interface Bucket {
  id: number;
  name: string;
  isOrgLevel: boolean;
  archivedAt: string | null;
  quickBooksClassId: string | null;
}

interface ClassOption {
  id: string;
  name: string;
  active: boolean;
}

interface Approver {
  budgetOwnerId: number;
  personId: number;
  name: string;
  role: "OWNER" | "TREASURER";
}

interface PersonOption {
  id: number;
  name: string;
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

  const [allBuckets, setAllBuckets] = useState<Bucket[]>([]);
  const [classes, setClasses] = useState<ClassOption[] | null>(null);
  const [classesFailed, setClassesFailed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const [newName, setNewName] = useState("");
  const [newOrgLevel, setNewOrgLevel] = useState(false);
  const [newClassId, setNewClassId] = useState<string | null>(null);

  const [editing, setEditing] = useState<Bucket | null>(null);
  const [editName, setEditName] = useState("");
  const [editClassId, setEditClassId] = useState<string | null>(null);

  const [approverBucket, setApproverBucket] = useState<Bucket | null>(null);

  // Archived buckets are always loaded: their Classes stay taken, so the picker must not offer them.
  const load = useCallback(() => Promise.all([
    fetch("/api/budget-owners?includeArchived=1"),
    fetch("/api/budget-owners/quickbooks-classes"),
  ])
    .then(async ([b, c]) => {
      if (b.ok) setAllBuckets(await b.json());
      setClassesFailed(!c.ok);
      if (c.ok) {
        setClasses(await c.json());
      } else {
        const data = await c.json().catch(() => ({}));
        const reason = typeof data.error === "string" ? data.error : "QuickBooks Classes could not be loaded.";
        notifications.show({ color: "red", autoClose: false, message: `QuickBooks Classes are unavailable: ${reason}` });
      }
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  const run = async (url: string, method: string, body: unknown, done: string) => {
    setMessage("");
    const error = await send(url, method, body);
    if (error) { setMessage(error); return false; }
    notifications.show({ message: done });
    setLoading(true);
    await load();
    return true;
  };

  const create = async () => {
    const ok = await run("/api/budget-owners", "POST", {
      name: newName,
      isOrgLevel: newOrgLevel,
      quickBooksClassId: newClassId,
    }, "Bucket created.");
    if (ok) { setNewName(""); setNewOrgLevel(false); setNewClassId(null); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const ok = await run(`/api/budget-owners/${editing.id}`, "PATCH", {
      name: editName,
      quickBooksClassId: editClassId,
    }, "Bucket saved.");
    if (ok) setEditing(null);
  };

  const archive = (bucket: Bucket) => {
    if (!window.confirm(`Archive "${bucket.name}"? It stays on record but leaves the active list.`)) return;
    void run(`/api/budget-owners/${bucket.id}/archive`, "POST", undefined, "Bucket archived.");
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
          picks it. A bucket&apos;s owner and treasurers approve its lines, and the Board names them. Finance
          assigning a line to an org-level bucket approves it.
        </Text>
        <AlertBanner message={message} tone="error" />

        {isFinance && (
          <Card withBorder radius="md" padding="lg">
            <Title order={4} mb="sm">New bucket</Title>
            <Group align="flex-end" wrap="wrap">
              <TextInput label="Name" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} w={240} />
              <Checkbox
                label="Org-level"
                description="No approvers; can't change later"
                checked={newOrgLevel}
                onChange={(e) => setNewOrgLevel(e.currentTarget.checked)}
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
                <Table.Th>Approval</Table.Th>
                <Table.Th>QuickBooks Class</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {buckets.map((b) => (
                <Table.Tr key={b.id}>
                  <Table.Td>{b.name}</Table.Td>
                  <Table.Td>{b.isOrgLevel ? <Text c="dimmed" size="sm">Org-level</Text> : "Owner and treasurers"}</Table.Td>
                  <Table.Td>{b.quickBooksClassId ? className(b.quickBooksClassId) : <Text c="dimmed" size="sm">Unmapped</Text>}</Table.Td>
                  <Table.Td>
                    {b.archivedAt ? <Badge color="gray">Archived</Badge> : <Badge color="green">Active</Badge>}
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" justify="flex-end">
                      {!b.isOrgLevel && (
                        <Button size="xs" variant="light" onClick={() => setApproverBucket(b)}>Approvers</Button>
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

      {approverBucket && (
        <ApproversModal
          key={approverBucket.id}
          bucket={approverBucket}
          canEdit={isBoard}
          onClose={() => setApproverBucket(null)}
        />
      )}
    </>
  );
}

function ApproversModal({ bucket, canEdit, onClose }: {
  bucket: Bucket;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [approvers, setApprovers] = useState<Approver[] | null>(null);
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [newTreasurer, setNewTreasurer] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/budget-owners/${bucket.id}/approvers`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Approver[]) => { if (live) setApprovers(data); });
    if (canEdit) {
      fetch("/api/budget-owners/approver-options")
        .then((res) => (res.ok ? res.json() : []))
        .then((data: PersonOption[]) => { if (live) setPeople(data); });
    }
    return () => { live = false; };
  }, [bucket.id, canEdit]);

  const change = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && Array.isArray(data)) {
      setApprovers(data);
      return;
    }
    const message = data && typeof data.error === "string" ? data.error : `The change failed (${res.status}).`;
    notifications.show({ color: "red", autoClose: false, message });
  };

  const owner = approvers?.find((a) => a.role === "OWNER") ?? null;
  const treasurers = approvers?.filter((a) => a.role === "TREASURER") ?? [];
  const options = people.map((p) => ({ value: String(p.id), label: p.name }));

  return (
    <Modal opened onClose={onClose} title={`Approvers — ${bucket.name}`}>
      <Stack>
        <Text size="sm" c="dimmed">
          The owner and treasurers approve this bucket&apos;s lines. They come from the Board-approved budget; only
          the Board sets them. Nobody may set themself or anyone in their own household.
        </Text>
        {approvers === null ? (
          <Center><Loader size="sm" /></Center>
        ) : (
          <>
            {canEdit ? (
              <Select
                label="Owner"
                placeholder="No owner"
                clearable
                searchable
                data={options}
                value={owner ? String(owner.personId) : null}
                onChange={(v) => void change(`/api/budget-owners/${bucket.id}/owner`, "PUT", { personId: v ? Number(v) : null })}
              />
            ) : (
              <Text size="sm">Owner: {owner?.name ?? <Text span c="dimmed">none</Text>}</Text>
            )}
            <Title order={6}>Treasurers</Title>
            {treasurers.length === 0 && <Text size="sm" c="dimmed">No treasurers.</Text>}
            {treasurers.map((t) => (
              <Group key={t.personId} justify="space-between">
                <Text size="sm">{t.name}</Text>
                {canEdit && (
                  <Button size="xs" variant="subtle" color="red" onClick={() => void change(`/api/budget-owners/${bucket.id}/treasurers/${t.personId}`, "DELETE")}>
                    Remove
                  </Button>
                )}
              </Group>
            ))}
            {canEdit && (
              <Group align="flex-end">
                <Select
                  label="Add treasurer"
                  searchable
                  data={options.filter((o) => !treasurers.some((t) => String(t.personId) === o.value))}
                  value={newTreasurer}
                  onChange={setNewTreasurer}
                  style={{ flex: 1 }}
                />
                <Button
                  disabled={!newTreasurer}
                  onClick={async () => {
                    await change(`/api/budget-owners/${bucket.id}/treasurers/${newTreasurer}`, "PUT");
                    setNewTreasurer(null);
                  }}
                >
                  Add
                </Button>
              </Group>
            )}
          </>
        )}
      </Stack>
    </Modal>
  );
}
