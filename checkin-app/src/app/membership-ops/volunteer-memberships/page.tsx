"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Badge, Button, Card, Chip, Group, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { AlertBanner } from "@/components/admin/AlertBanner";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import { useRequireRole } from "@/hooks/useRequireRole";
import { PageLoader } from "@/components/ui/PageLoader";
import { notifications } from "@mantine/notifications";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { formatDateOnly } from "@/lib/time";
import { useOrgTime } from "@/components/TimezoneProvider";
import type { VolunteerRow, VolunteerRowStatus } from "@/app/api/membership-ops/volunteer-memberships/route";

const STATUS_CHIPS: { value: VolunteerRowStatus; label: string; color: string }[] = [
  { value: "VOLUNTEER", label: "Volunteer member", color: "green" },
  { value: "IN_PROGRESS", label: "Signup in progress", color: "blue" },
  { value: "BLOCKED", label: "Application blocked", color: "orange" },
  { value: "DESIGNATED", label: "Pre-designated", color: "gray" },
  { value: "NEXT_RENEWAL", label: "Takes effect next renewal", color: "yellow" },
  { value: "REVOKED", label: "Revoked", color: "red" },
  { value: "INACTIVE", label: "No live application", color: "gray" },
];

const chipFor = (status: VolunteerRowStatus) => STATUS_CHIPS.find((c) => c.value === status);

// Sort order for the Status column: most-settled first, so the roster reads
// active volunteers → in-flight → not-yet-members.
const STATUS_RANK = Object.fromEntries(STATUS_CHIPS.map((c, i) => [c.value, i]));

// memberSince is a @db.Date calendar day, so it is UTC-pinned; a designation's
// createdAt is a true instant and takes the org's zone. See lib/time.ts.
const memberSinceText = (iso: string | null) => (iso ? formatDateOnly(iso) : "—");

export default function VolunteerMembershipsPage() {
  const { ready, loading: authLoading } = useRequireRole(['isSysadmin', 'isBoardMember']);
  // A designation's createdAt is an instant, so it renders in the org's display zone.
  const { formatDate } = useOrgTime();
  const [rows, setRows] = useState<VolunteerRow[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "warning" | "error" } | undefined>();
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [showInactive, setShowInactive] = useState(false);

  const flash = (text: string, tone: "warning" | "error" = "error") =>
    setMessage(text ? { text, tone } : undefined);

  const fetchRows = useCallback(() =>
    fetch("/api/membership-ops/volunteer-memberships")
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        setRows((await res.json()).rows || []);
        setLoadFailed(false);
      })
      .catch(() => {
        // Without this the failed load is indistinguishable from an empty roster.
        setRows([]);
        setLoadFailed(true);
      })
      .finally(() => setLoading(false)), []);

  const load = () => {
    setLoading(true);
    return fetchRows();
  };

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      // A household with no live application is off the default roster — unless a
      // designation hangs off it, since this row carries its only Remove action.
      if (!showInactive && r.status === "INACTIVE" && r.designations.length === 0) return false;
      if (statuses.length > 0 && !statuses.includes(r.status)) return false;
      if (!q) return true;
      return [r.householdName, r.email, ...r.leads, ...r.designations.map((d) => d.email)]
        .some((v) => v?.toLowerCase().includes(q));
    });
  }, [rows, search, statuses, showInactive]);

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) {
    return null;
  }

  const addDesignation = async () => {
    setEmailError(undefined);
    if (!newEmail.trim()) return;
    if (!isValidEmail(newEmail)) { setEmailError("A valid email is required."); return; }
    setSaving(true);
    flash("");
    try {
      const res = await fetch("/api/settings/membership/volunteer-designations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setNewEmail("");
        if (data.warning) { flash(data.warning, "warning"); } else { notifications.show({ message: "Designation added." }); }
        await load();
      } else flash(data.error || "Could not add.");
    } catch { notifications.show({ color: "red", message: "Network error.", autoClose: false }); }
    finally { setSaving(false); }
  };

  const removeDesignation = async (id: number) => {
    setSaving(true);
    flash("");
    try {
      const res = await fetch(`/api/settings/membership/volunteer-designations?id=${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        flash(data.error || "Could not remove that designation.");
        return;
      }
      notifications.show({ message: "Designation removed." });
      await load();
    } catch { notifications.show({ color: "red", message: "Network error.", autoClose: false }); }
    finally { setSaving(false); }
  };

  const columns: DataTableColumn<VolunteerRow>[] = [
    {
      header: "Household",
      sortBy: (r) => r.householdName,
      render: (r) =>
        r.householdName ?? <Text c="dimmed" fs="italic">Not signed up yet</Text>,
    },
    {
      header: "Lead(s)",
      sortBy: (r) => r.leads[0],
      render: (r) => (r.leads.length ? r.leads.join(", ") : "—"),
    },
    { header: "Email", sortBy: (r) => r.email, render: (r) => r.email ?? "—" },
    {
      header: "Status",
      sortBy: (r) => STATUS_RANK[r.status],
      render: (r) => {
        const chip = chipFor(r.status);
        return <Badge color={chip?.color} variant="light">{chip?.label ?? r.status}</Badge>;
      },
    },
    { header: "Member since", sortBy: (r) => r.memberSince, render: (r) => memberSinceText(r.memberSince) },
    {
      header: "Designated",
      sortBy: (r) => r.designations[0]?.createdAt,
      render: (r) =>
        r.designations.length === 0 ? "—" : (
          <Stack gap={2}>
            {r.designations.map((d) => (
              <Text key={d.id} size="sm">{formatDate(d.createdAt)}</Text>
            ))}
          </Stack>
        ),
    },
    {
      header: "",
      align: "right",
      // One Remove per designation, each naming its own email. A designation is an
      // EMAIL-level record but this row is HOUSEHOLD-level once the household
      // exists, so on those rows a bare "Remove" doesn't say what it removes.
      // Only a row that is still just an email can drop the address.
      render: (r) => (
        <Stack gap={4} align="flex-end">
          {r.designations.map((d) => (
            <Button
              key={d.id}
              variant="subtle"
              color="red"
              size="compact-sm"
              disabled={saving}
              aria-label={`Remove ${d.email}`}
              onClick={() => removeDesignation(d.id)}
            >
              {r.householdId != null ? `Remove ${d.email}` : "Remove"}
            </Button>
          ))}
        </Stack>
      ),
    },
  ];

  return (
    <Stack>
      <AlertBanner message={message?.text} tone={message?.tone} />
      {loadFailed && (
        <AlertBanner message="Could not load the volunteer roster. Refresh to try again." tone="error" />
      )}

      <Card withBorder radius="md" padding="lg">
        <Title order={3} mb="xs">Volunteers</Title>
        <Text c="dimmed" mb="md">
          Households on the volunteer membership fee, plus emails designated ahead of signup. If one
          of those emails applies for membership, that whole household is treated as a volunteer
          only family (lower membership fee).
        </Text>

        <Group gap="sm" wrap="wrap" mb="md" align="flex-end">
          <TextInput
            w={280}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Search household, lead, or email"
            aria-label="Search volunteers"
          />
          <Chip.Group multiple value={statuses} onChange={setStatuses}>
            <Group gap="xs">
              {/* Every status gets a chip, unconditionally. Gating INACTIVE on the
                  switch left the designation-carrying inactive row (which the row
                  filter keeps for its Remove) badged with no chip to filter on. */}
              {STATUS_CHIPS.map((c) => (
                <Chip key={c.value} value={c.value} color={c.color} size="sm" variant="outline">
                  {c.label}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          <Switch
            label="Show inactive"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.currentTarget.checked)}
          />
        </Group>

        <DataTable
          columns={columns}
          rows={visibleRows}
          getRowKey={(r) => r.key}
          loading={loading}
          minWidth={900}
          emptyMessage={
            loadFailed
              ? "Roster unavailable."
              : rows.length === 0
                ? "No volunteers or designations yet."
                : !showInactive && !statuses.length && !search.trim()
                    && rows.every((r) => r.status === "INACTIVE" && r.designations.length === 0)
                  ? "No active volunteers. Turn on Show inactive to see archived households."
                  : "No volunteers match this filter."
          }
        />
      </Card>

      <Card withBorder radius="md" padding="lg">
        <Title order={4} mb="xs">Designate a volunteer email</Title>
        <Group gap="sm" wrap="wrap" align="flex-end">
          <TextInput
            w={320}
            value={newEmail}
            onChange={(e) => { setNewEmail(e.currentTarget.value); setEmailError(undefined); }}
            error={emailError}
            placeholder="volunteer@example.com"
            aria-label="Volunteer email"
          />
          <Button disabled={saving} onClick={addDesignation}>Add</Button>
        </Group>
      </Card>
    </Stack>
  );
}
