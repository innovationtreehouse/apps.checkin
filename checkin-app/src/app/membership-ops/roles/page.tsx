"use client";

import { useEffect, useState } from "react";
import { Card, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { EntityPicker } from "@/components/admin/EntityPicker";
import { RoleBadge, roleLabel } from "@/components/ui/RoleBadge";
import { RolesEditModal, type RolesEditTarget } from "@/components/roles/RolesEditModal";
import { ROLE_FLAGS } from "@/lib/roles";
import { useRequireRole } from "@/hooks/useRequireRole";

type PersonRow = RolesEditTarget & { isYouth?: boolean };

/**
 * Holders-first role editor (roles-foundation rework §6.2) — the SOLE place role grants are
 * edited. One section per role, listing current holders as named pills; a person-picker adds a
 * new holder. Reuses GET /api/roles (already returns every person + the five derived flags) —
 * no new endpoint, no new query.
 */
export default function RolesPage() {
  const { user: me, loading, ready } = useRequireRole(['isSysadmin', 'isBoardMember']);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [fetching, setFetching] = useState(true);
  const [target, setTarget] = useState<PersonRow | null>(null);

  const fetchPeople = () => fetch('/api/roles')
    .then(async (res) => {
      const data = await res.json();
      if (data.people) setPeople(data.people);
    })
    .catch((err) => {
      console.error("Failed to load roles:", err);
    })
    .finally(() => {
      setFetching(false);
    });

  useEffect(() => {
    if (ready) fetchPeople();
  }, [ready]);

  const handleSaved = (updated: RolesEditTarget) => {
    setPeople((prev) => {
      const exists = prev.some((p) => p.id === updated.id);
      const merged = { ...updated } as PersonRow;
      return exists ? prev.map((p) => (p.id === updated.id ? { ...p, ...merged } : p)) : [...prev, merged];
    });
  };

  if (loading) return null;
  if (!ready) return null;

  return (
    <Stack maw={800} mx="auto">
      <div>
        <Text c="dimmed">Grant or revoke roles. Every change is logged with who granted it and when.</Text>
      </div>

      <Card withBorder radius="md" padding="lg" style={{ overflow: 'visible' }}>
        <EntityPicker<PersonRow>
          label="Add or edit a person's roles"
          placeholder="Search people by name, email, or ID..."
          selectedId={null}
          search={async (q) => {
            const res = await fetch(`/api/people/search?q=${encodeURIComponent(q)}`);
            if (!res.ok) return [];
            const data = await res.json();
            return (data.people || []) as PersonRow[];
          }}
          getOptionLabel={(p) => p.name || p.email || `Person #${p.id}`}
          getOptionDescription={(p) => p.email}
          onSelect={(p) => setTarget(p)}
          onClear={() => {}}
        />
      </Card>

      {fetching && people.length === 0 ? (
        <Text c="dimmed">Loading...</Text>
      ) : (
        ROLE_FLAGS.map((flag) => {
          const holders = people
            .filter((p) => p[flag])
            .sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));
          return (
            <Card key={flag} withBorder radius="md" padding="lg">
              <Group justify="space-between" mb="sm">
                <Text fw={700}>{roleLabel(flag)}</Text>
                <Text c="dimmed" size="sm">{holders.length} {holders.length === 1 ? 'holder' : 'holders'}</Text>
              </Group>
              {holders.length === 0 ? (
                <Text c="dimmed" size="sm">No one holds this role.</Text>
              ) : (
                <Group gap="xs" wrap="wrap">
                  {holders.map((p) => (
                    <UnstyledButton key={p.id} onClick={() => setTarget(p)}>
                      <RoleBadge role={flag} label={p.name || p.email || `Person #${p.id}`} size="lg" />
                    </UnstyledButton>
                  ))}
                </Group>
              )}
            </Card>
          );
        })
      )}

      <RolesEditModal
        target={target}
        me={me}
        onClose={() => setTarget(null)}
        onSaved={handleSaved}
      />
    </Stack>
  );
}
