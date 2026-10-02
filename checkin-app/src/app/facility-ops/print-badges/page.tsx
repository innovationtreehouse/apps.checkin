"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import QRCode from "qrcode";
import { pdf } from "@react-pdf/renderer";
import { Badge, Button, Checkbox, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useRequireRole } from "@/hooks/useRequireRole";
import { FACILITY_AGGREGATE_ROLES } from "@/lib/facilityNav";
import { PageLoader } from "@/components/ui/PageLoader";
import { DataTable, type DataTableColumn } from "@/components/admin/DataTable";
import BadgeDocument from "@/components/admin/BadgeDocument";
import StickerDocument from "@/components/admin/StickerDocument";
import { computeDisplayNames } from "@/components/admin/badgeNames";
import { goesBy } from "@/lib/person/name";

type ParticipantRow = {
  id: number;
  name: string | null;
  nickname: string | null;
  email: string | null;
  isMember?: boolean;
  isSysadmin?: boolean;
  isBoardMember?: boolean;
  isKeyholder?: boolean;
};

type SavedNickname = { id: number; nickname: string | null };

export default function PrintBadgesPage() {
  const { user, ready, loading: authLoading } = useRequireRole(FACILITY_AGGREGATE_ROLES);
  // Printing is board-or-operations, but a nickname is a write to the person's record
  // and rides the participant-edit gate. So operations prints badges and reads the
  // names; only board/sysadmin can change one.
  const canEditNickname = !!user?.isSysadmin || !!user?.isBoardMember;

  const [participants, setParticipants] = useState<ParticipantRow[]>([]);
  // Every ACTIVE member org-wide — the population printed names disambiguate against.
  // Separate from `participants`, which is whatever the search box last matched.
  // `year` is per person: only a household that settled this renewal cycle gets one.
  const [roster, setRoster] = useState<{ id: number; name: string; nickname: string | null; year: string | null }[] | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [hideInactive, setHideInactive] = useState(true);
  // Default off: a household stays ACTIVE past the boundary it paid for, so its badge
  // reads "Not renewed" until it settles the new cycle — the renewal prompt ops chases.
  // Filtering by year on by default would hide exactly those rows.
  const [filterByYear, setFilterByYear] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [availableYears, setAvailableYears] = useState<string[]>([]);
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  // What the admin has typed into a Nickname box, keyed by person. Held apart from
  // `participants` so a keystroke never waits on the save that follows it.
  const [nicknameDrafts, setNicknameDrafts] = useState<Record<number, string>>({});
  // Typed values still waiting out the debounce, and saves already sent. Printing and
  // leaving the page both flush the first and wait on (or outlive) the second.
  const pendingSaves = useRef<Record<number, { value: string; timer: ReturnType<typeof setTimeout> }>>({});
  const inflightSaves = useRef(new Set<Promise<SavedNickname | null>>());

  const fetchParticipants = useCallback(async () => {
    setLoading(true);
    try {
      const url = new URL('/api/people/search', window.location.origin);
      if (searchTerm) url.searchParams.set('q', searchTerm);

      const res = await fetch(url.toString());
      const data = await res.json();
      if (data.people) {
        setParticipants(data.people);
      }
    } catch (e) {
      console.error("Failed to search people for badges:", e);
    } finally {
      setLoading(false);
    }
  }, [searchTerm]);

  useEffect(() => {
    if (ready) {
      fetchParticipants();
    }
  }, [ready, fetchParticipants]);

  // Load available membership years on mount.
  useEffect(() => {
    if (!ready) return;
    const url = new URL('/api/people/search', window.location.origin);
    url.searchParams.set('roster', 'years');
    fetch(url.toString())
      .then(res => res.ok ? res.json() : Promise.reject(new Error(`years request failed: ${res.status}`)))
      .then(data => {
        setAvailableYears(data.years ?? []);
        if (!selectedYear && data.current) setSelectedYear(data.current);
      })
      .catch(e => console.error("Failed to load membership years:", e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Reload the roster when the selected year changes.
  useEffect(() => {
    if (!ready) return;
    setRoster(null);
    const url = new URL('/api/people/search', window.location.origin);
    url.searchParams.set('roster', 'active');
    if (selectedYear) url.searchParams.set('year', selectedYear);
    fetch(url.toString())
      .then(res => {
        if (!res.ok) throw new Error(`roster request failed: ${res.status}`);
        return res.json();
      })
      .then(data => setRoster(data.people ?? []))
      .catch(e => {
        console.error("Failed to load the active-member roster for badge names:", e);
        setRoster(null);
        notifications.show({ color: 'red', message: 'Could not load the active member roster, so badge names cannot be resolved. Reload to retry.', autoClose: false });
      });
  }, [ready, selectedYear]);

  // The draft is dropped once the record holds its value, so the box goes back to
  // reading the person record and a nickname changed elsewhere is not shadowed by
  // stale local text. A draft that no longer matches is newer typing with its own
  // save pending — leave it.
  const dropSavedDraft = useCallback((id: number, nickname: string | null) => {
    setNicknameDrafts(prev => {
      if (prev[id] === undefined || (prev[id].trim() || null) !== nickname) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // A saved nickname lands in `roster` as well as `participants`: the roster is what
  // disambiguation runs over, so this is what keeps the Printed Name column honest.
  const applyNickname = useCallback((id: number, nickname: string | null) => {
    setParticipants(prev => prev.map(p => (p.id === id ? { ...p, nickname } : p)));
    setRoster(prev => prev?.map(m => (m.id === id ? { ...m, nickname } : m)) ?? prev);
    dropSavedDraft(id, nickname);
  }, [dropSavedDraft]);

  // Read through a ref so a debounced save compares against the participants as of
  // when it fires, not as of the keystroke that scheduled it.
  const participantsRef = useRef(participants);
  participantsRef.current = participants;

  // A value that already matches the stored one is not an edit and writes nothing —
  // the debounce and blur paths both land here, and every accepted PUT writes an
  // audit row. Resolves to the value written, or null when nothing was.
  const saveNickname = useCallback(async (id: number, raw: string): Promise<SavedNickname | null> => {
    const nickname = raw.trim() || null;
    if (nickname === (participantsRef.current.find(p => p.id === id)?.nickname ?? null)) {
      dropSavedDraft(id, nickname);
      return null;
    }
    try {
      // keepalive lets the write finish when the tab closes right after typing.
      const res = await fetch(`/api/membership-ops/participants/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
        keepalive: true,
      });
      if (!res.ok) throw new Error(`nickname save failed: ${res.status}`);
      applyNickname(id, nickname);
      return { id, nickname };
    } catch (e) {
      console.error("Failed to save nickname:", e);
      notifications.show({ color: 'red', message: 'Could not save that nickname — it is not on the badge. Edit the box to retry.', autoClose: false });
      return null;
    }
  }, [applyNickname, dropSavedDraft]);

  // Leaving the box commits immediately rather than waiting out the debounce.
  const commitNickname = useCallback((id: number, value: string) => {
    clearTimeout(pendingSaves.current[id]?.timer);
    delete pendingSaves.current[id];
    const save = saveNickname(id, value);
    inflightSaves.current.add(save);
    save.finally(() => inflightSaves.current.delete(save));
    return save;
  }, [saveNickname]);

  const editNickname = (id: number, value: string) => {
    setNicknameDrafts(prev => ({ ...prev, [id]: value }));
    clearTimeout(pendingSaves.current[id]?.timer);
    pendingSaves.current[id] = { value, timer: setTimeout(() => commitNickname(id, value), 600) };
  };

  const flushPendingSaves = useCallback(() => {
    Object.entries(pendingSaves.current).forEach(([id, { value }]) => commitNickname(Number(id), value));
  }, [commitNickname]);

  // Closing the tab or navigating away sends whatever is still waiting out the debounce.
  useEffect(() => {
    window.addEventListener('pagehide', flushPendingSaves);
    return () => {
      window.removeEventListener('pagehide', flushPendingSaves);
      flushPendingSaves();
    };
  }, [flushPendingSaves]);

  // Sends every unsaved nickname and waits for all saves, so a print never runs ahead of
  // one. Returns the nicknames written, later writes winning.
  const settleNicknames = async () => {
    flushPendingSaves();
    const saved = await Promise.all([...inflightSaves.current]);
    return new Map(saved.flatMap(s => (s ? [[s.id, s.nickname] as const] : [])));
  };

  const printedNames = useMemo(() => computeDisplayNames(roster ?? []), [roster]);
  const printedYears = useMemo(() => new Map((roster ?? []).map(m => [m.id, m.year])), [roster]);

  // Off-roster people get the bare name they go by — no disambiguation, which would run
  // against the search results and change a printed name whenever the query changes. A
  // bare name can collide, but it is stable across searches.
  const offRosterName = (p: ParticipantRow) => goesBy(p) || `User #${p.id}`;

  // The badge name and this column read the same maps, so the column is proof of what
  // will print.
  const printedName = (p: ParticipantRow, names = printedNames) =>
    names.get(p.id) ?? (roster ? offRosterName(p) : `User #${p.id}`);

  const toggleSelection = (id: number) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedIds(newSet);
  };

  // Every count, every checkbox and the PDF itself read `visible`/`selectedVisible`,
  // never `participants`/`selectedIds` — a hidden person can't leak into a print run.
  // The year filter waits for the roster: printedYears is empty until it lands, and
  // filtering against an empty map would blank the list mid-load.
  // Sysadmin logins hide with the inactive: they exist for remote system management,
  // not for wearing a badge on the floor, so a badge never prints for one by default.
  const visible = participants.filter(p =>
    (!hideInactive || (p.isMember && !p.isSysadmin)) &&
    (!filterByYear || roster === null || !selectedYear || printedYears.get(p.id) === selectedYear)
  );
  // Counts the two filters own separately, so each label names only its own hidden rows.
  const inactiveHidden = hideInactive ? participants.filter(p => !p.isMember || p.isSysadmin).length : 0;
  const hidden = participants.length - visible.length;
  const selectedVisible = visible.filter(p => selectedIds.has(p.id));

  const toggleAll = () => {
    if (selectedVisible.length === visible.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visible.map(p => p.id)));
    }
  };

  const generate = async (kind: 'badge' | 'sticker') => {
    if (selectedVisible.length === 0) return;
    setIsGenerating(true);

    try {
      // This render's roster predates any save settled here, so fold those in.
      const saved = await settleNicknames();
      const withSaved = <T extends { id: number; nickname: string | null }>(p: T): T =>
        saved.has(p.id) ? { ...p, nickname: saved.get(p.id) ?? null } : p;
      const names = saved.size ? computeDisplayNames((roster ?? []).map(withSaved)) : printedNames;

      // Add QR code data URIs
      const badgesWithQr = await Promise.all(
        selectedVisible.map(withSaved).map(async (p) => {
          const qrDataUri = await QRCode.toDataURL(p.id.toString(), {
            width: 200,
            margin: 1,
            color: { dark: '#000000', light: '#FFFFFF' }
          });
          // `displayName` is the badge's; `name` is retained solely for StickerDocument,
          // which prints the full name raw and is not changing.
          return {
            id: p.id,
            name: p.name ?? '',
            displayName: printedName(p, names),
            year: printedYears.get(p.id) ?? null,
            qrDataUri,
          };
        })
      );

      const doc = kind === 'badge'
        ? <BadgeDocument badges={badgesWithQr} />
        : <StickerDocument badges={badgesWithQr} />;
      const blob = await pdf(doc).toBlob();

      // Trigger download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${kind === 'badge' ? 'badges' : 'stickers'}-${Date.now()}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(`Failed to generate ${kind} PDF`, e);
      notifications.show({ color: 'red', message: `Failed to generate ${kind} PDF. Please try again.`, autoClose: false });
    } finally {
      setIsGenerating(false);
    }
  };

  if (authLoading) return <PageLoader />;
  if (!ready) return null;

  const columns: DataTableColumn<ParticipantRow>[] = [
    {
      header: (
        <Checkbox
          radius={2}
          checked={visible.length > 0 && selectedVisible.length === visible.length}
          onChange={toggleAll}
          aria-label="Select all"
        />
      ),
      render: (p) => (
        <Checkbox
          radius={2}
          checked={selectedIds.has(p.id)}
          onChange={() => toggleSelection(p.id)}
          aria-label={`Select ${p.name ?? p.id}`}
        />
      ),
    },
    { header: 'ID', render: (p) => <Text span c="dimmed">#{p.id}</Text>, sortBy: (p) => p.id },
    {
      header: 'Name',
      render: (p) => <Text fw={600}>{p.name || 'N/A'}</Text>,
      sortBy: (p) => p.name,
    },
    ...(canEditNickname ? [{
      header: 'Nickname',
      render: (p: ParticipantRow) => (
        <TextInput
          size="xs"
          w={130}
          placeholder="Goes by…"
          aria-label={`Nickname for ${p.name ?? `#${p.id}`}`}
          value={nicknameDrafts[p.id] ?? p.nickname ?? ''}
          onChange={(e) => editNickname(p.id, e.currentTarget.value)}
          onBlur={(e) => commitNickname(p.id, e.currentTarget.value)}
        />
      ),
      sortBy: (p: ParticipantRow) => p.nickname || null,
    }] : []),
    {
      header: 'Printed Name',
      render: (p) => <Text>{printedName(p)}</Text>,
      sortBy: printedName,
    },
    {
      header: 'Membership',
      render: (p) => (p.isMember ? <Text c="green">Active</Text> : <Text c="red">Inactive</Text>),
      sortBy: (p) => (p.isMember ? 'Active' : 'Inactive'),
    },
    {
      // Blank here means blank on the badge — the renewal prompt, visible before printing.
      header: 'Year',
      render: (p) => <Text c={printedYears.get(p.id) ? undefined : 'dimmed'}>{printedYears.get(p.id) ?? 'Not renewed'}</Text>,
      sortBy: (p) => printedYears.get(p.id),
    },
    {
      header: 'Roles',
      render: (p) => (
        <Group gap={4}>
          {p.isSysadmin && <Badge size="xs" color="red">ADMIN</Badge>}
          {p.isBoardMember && <Badge size="xs" color="blue">BOARD</Badge>}
          {p.isKeyholder && <Badge size="xs" color="orange">KEYHOLDER</Badge>}
          {!p.isSysadmin && !p.isBoardMember && !p.isKeyholder && p.isMember && (
            <Badge size="xs">MEMBER</Badge>
          )}
        </Group>
      ),
    },
  ];

  return (
    <Stack>
      <Text c="dimmed">
        Select participants to generate double-sided standard Avery 5390 ID badges.
        {canEditNickname && " Type a nickname to print the name someone goes by instead of their first name."}
      </Text>

      <Group gap="md" wrap="wrap">
        <TextInput
          placeholder="Search by name, email, or ID..."
          style={{ flex: 1, minWidth: 200 }}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.currentTarget.value)}
        />
        <Select
          label="Membership year"
          data={availableYears}
          value={selectedYear}
          onChange={setSelectedYear}
          style={{ minWidth: 140 }}
          allowDeselect={false}
        />
        <Checkbox
          label="Filter by year"
          checked={filterByYear}
          onChange={(e) => setFilterByYear(e.currentTarget.checked)}
        />
        <Checkbox
          label={inactiveHidden ? `Hide inactive & admins (${inactiveHidden})` : "Hide inactive & admins"}
          checked={hideInactive}
          onChange={(e) => setHideInactive(e.currentTarget.checked)}
        />
        {/* Held until the roster lands: printing first would silently emit un-disambiguated
            names onto physical badges, with nothing on screen to say so. */}
        <Button onClick={() => generate('badge')} disabled={selectedVisible.length === 0 || isGenerating || roster === null} loading={isGenerating}>
          Generate Badge ({selectedVisible.length})
        </Button>
        <Button color="grape" onClick={() => generate('sticker')} disabled={selectedVisible.length === 0 || isGenerating || roster === null} loading={isGenerating}>
          Generate Sticker ({selectedVisible.length})
        </Button>
      </Group>

      <DataTable
        columns={columns}
        rows={visible}
        getRowKey={(p) => p.id}
        loading={loading}
        emptyMessage={hidden > 0
          ? `No active people match — ${hidden} hidden by the filter.`
          : "No participants found."}
        rowProps={(p) => ({ bg: selectedIds.has(p.id) ? 'var(--mantine-color-blue-light)' : undefined })}
      />
    </Stack>
  );
}
