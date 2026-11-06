"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge, Button, Card, Center, Checkbox, Group, Loader, Modal, Select, Stack, Table, Text, TextInput, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { errorMessage } from "@checkin/component-ui";
import { PageLoader } from "@/components/ui/PageLoader";
import { useRequireRole } from "@/hooks/useRequireRole";
import { api } from "@/lib/api";
import { FINANCE_ROLES } from "@/lib/nav/sections/finance";

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

/** Sends a write with a JSON body; a failure throws, for `errorMessage` to word. */
function write<T>(url: string, method: string, body?: unknown): Promise<T> {
  return api<T>(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const { user, loading: authLoading, ready } = useRequireRole(FINANCE_ROLES);
  const isFinance = !!user?.isFinance;
  const isBoard = !!user?.isBoardMember;

  const [allBuckets, setAllBuckets] = useState<Bucket[]>([]);
  const [classes, setClasses] = useState<ClassOption[] | null>(null);
  const [classesFailed, setClassesFailed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);

  const [newName, setNewName] = useState("");
  const [newOrgLevel, setNewOrgLevel] = useState(false);
  const [newClassId, setNewClassId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [editing, setEditing] = useState<Bucket | null>(null);
  const [editName, setEditName] = useState("");
  const [editClassId, setEditClassId] = useState<string | null>(null);
  const [editOrgLevel, setEditOrgLevel] = useState(false);

  const [approverBucket, setApproverBucket] = useState<Bucket | null>(null);

  // Archived buckets are always loaded: their Classes stay taken, so the picker must not offer them.
  const load = useCallback(() => Promise.allSettled([
    api<Bucket[]>("/api/budget-owners?includeArchived=1"),
    api<ClassOption[]>("/api/budget-owners/quickbooks-classes"),
  ]).then(([b, c]) => {
    if (b.status === "fulfilled") { setAllBuckets(b.value); clearError("Buckets not loaded"); } else showError("Buckets not loaded", errorMessage(b.reason));
    setClassesFailed(c.status === "rejected");
    if (c.status === "fulfilled") { setClasses(c.value); clearError("QuickBooks Classes unavailable"); } else showError("QuickBooks Classes unavailable", errorMessage(c.reason));
    setLoading(false);
  }), []);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  const run = async (url: string, method: string, body: unknown, done: string, failed: string) => {
    clearError(failed);
    try {
      await write(url, method, body);
    } catch (e) {
      showError(failed, errorMessage(e));
      return false;
    }
    notifications.show({ message: done });
    setLoading(true);
    await load();
    return true;
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const ok = await run("/api/budget-owners", "POST", {
        name: newName,
        isOrgLevel: newOrgLevel,
        quickBooksClassId: newClassId,
      }, "Bucket created.", "Bucket not created");
      if (ok) { setNewName(""); setNewOrgLevel(false); setNewClassId(null); }
    } finally {
      setCreating(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const ok = await run(`/api/budget-owners/${editing.id}`, "PATCH", {
      name: editName,
      quickBooksClassId: editClassId,
      isOrgLevel: editOrgLevel,
    }, "Bucket saved.", "Bucket not saved");
    if (ok) setEditing(null);
  };

  const archive = (bucket: Bucket) => {
    if (!window.confirm(`Archive "${bucket.name}"? It stays on record but leaves the active list.`)) return;
    void run(`/api/budget-owners/${bucket.id}/archive`, "POST", undefined, "Bucket archived.", "Bucket not archived");
  };

  const restore = (bucket: Bucket) => {
    void run(`/api/budget-owners/${bucket.id}`, "PATCH", { archived: false }, "Bucket restored.", "Bucket not restored");
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
          picks it. A bucket&apos;s owner and treasurers approve its lines, and the Board names them. An org-level
          bucket has neither, and a Board member approves its lines.
        </Text>

        {isFinance && (
          <Card withBorder radius="md" padding="lg">
            <Title order={4} mb="sm">New bucket</Title>
            <Group align="flex-end" wrap="wrap">
              <TextInput label="Name" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} w={240} />
              <Checkbox
                label="Org-level"
                description="No approvers"
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
              <Button onClick={create} disabled={creating || !newName.trim()} loading={creating}>Create</Button>
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
                          onClick={() => { setEditing(b); setEditName(b.name); setEditClassId(b.quickBooksClassId); setEditOrgLevel(b.isOrgLevel); }}
                        >
                          Edit
                        </Button>
                      )}
                      {isFinance && b.archivedAt && (
                        <Button size="xs" variant="light" onClick={() => restore(b)}>Restore</Button>
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
          <Checkbox
            label="Org-level"
            description="No approvers. The Board removes any owner and treasurers first, and a change back waits for Board signatures open expenses here still need."
            checked={editOrgLevel}
            onChange={(e) => setEditOrgLevel(e.currentTarget.checked)}
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [newTreasurer, setNewTreasurer] = useState<string | null>(null);
  const [ownerPick, setOwnerPick] = useState<string | null>(null);
  const [savingOwner, setSavingOwner] = useState(false);
  const [changing, setChanging] = useState(false);

  const applyApprovers = useCallback((data: Approver[]) => {
    setApprovers(data);
    const saved = data.find((a) => a.role === "OWNER");
    setOwnerPick(saved ? String(saved.personId) : null);
  }, []);

  useEffect(() => {
    let live = true;
    api<Approver[]>(`/api/budget-owners/${bucket.id}/approvers`).then(
      (data) => { if (live) { applyApprovers(data); setLoadFailed(false); clearError("Approvers not loaded"); } },
      (e: unknown) => { if (live) { showError("Approvers not loaded", errorMessage(e)); setLoadFailed(true); } },
    );
    if (canEdit) {
      api<PersonOption[]>("/api/budget-owners/approver-options").then(
        (data) => { if (live) { setPeople(data); clearError("People not loaded"); } },
        (e: unknown) => { if (live) showError("People not loaded", errorMessage(e)); },
      );
    }
    return () => { live = false; };
  }, [bucket.id, canEdit, applyApprovers]);

  const change = async (url: string, method: string, body?: unknown) => {
    setChanging(true);
    clearError("Approvers not changed");
    try {
      applyApprovers(await write<Approver[]>(url, method, body));
    } catch (e) {
      showError("Approvers not changed", errorMessage(e));
    } finally {
      setChanging(false);
    }
  };

  const saveOwner = async () => {
    setSavingOwner(true);
    await change(`/api/budget-owners/${bucket.id}/owner`, "PUT", { personId: ownerPick ? Number(ownerPick) : null });
    setSavingOwner(false);
  };

  const owner = approvers?.find((a) => a.role === "OWNER") ?? null;
  const savedOwner = owner ? String(owner.personId) : null;
  const treasurers = approvers?.filter((a) => a.role === "TREASURER") ?? [];
  const options = people.map((p) => ({ value: String(p.id), label: p.name }));

  return (
    <Modal opened onClose={onClose} title={`Approvers — ${bucket.name}`}>
      <Stack>
        <Text size="sm" c="dimmed">
          The owner and treasurers approve this bucket&apos;s lines. They come from the Board-approved budget; only
          the Board sets them. Nobody may set themself or anyone in their own household.
        </Text>
        {approvers === null && loadFailed ? (
          <Text c="dimmed">Approvers couldn&apos;t be loaded.</Text>
        ) : approvers === null ? (
          <Center><Loader size="sm" /></Center>
        ) : (
          <>
            {canEdit ? (
              <Group align="flex-end">
                <Select
                  label="Owner"
                  placeholder="No owner"
                  clearable
                  searchable
                  data={options}
                  clearButtonProps={{ "aria-label": "Clear owner" }}
                  value={ownerPick}
                  onChange={setOwnerPick}
                  disabled={changing}
                  style={{ flex: 1 }}
                />
                <Button disabled={changing || ownerPick === savedOwner} loading={savingOwner} onClick={() => void saveOwner()}>
                  Save
                </Button>
              </Group>
            ) : (
              <Text size="sm">Owner: {owner?.name ?? <Text span c="dimmed">none</Text>}</Text>
            )}
            <Title order={6}>Treasurers</Title>
            {treasurers.length === 0 && <Text size="sm" c="dimmed">No treasurers.</Text>}
            {treasurers.map((t) => (
              <Group key={t.personId} justify="space-between">
                <Text size="sm">{t.name}</Text>
                {canEdit && (
                  <Button size="xs" variant="subtle" color="red" disabled={changing} onClick={() => void change(`/api/budget-owners/${bucket.id}/treasurers/${t.personId}`, "DELETE")}>
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
                  disabled={changing || !newTreasurer}
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
