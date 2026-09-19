"use client";

import { useState, useEffect, useRef } from 'react';
import { useRequireRole } from '@/hooks/useRequireRole';
import { Alert, Anchor, Button, Card, Center, Group, Loader, Modal, Select, Stack, Table, Tabs, Text, TextInput } from '@mantine/core';
import { ToolLevelBadge, toToolLevel, toolLevelDot, toolLevelLabel } from '@/components/ToolLevelBadge';
import { ScrollableTabsList } from '@/components/ui/ScrollableTabsList';

import { PageLoader } from "@/components/ui/PageLoader";
import { personQueryMatcher } from "@/lib/searchId";

type Tool = {
  id: number;
  name: string;
  safetyGuide: string | null;
  _count?: { toolStatuses: number };
};

type Certification = {
  personId: number;
  toolId: number;
  level: "BASIC" | "DOF" | "CERTIFIED" | "INSTRUCTOR" | "MAY_CERTIFY_OTHERS";
  person?: { id: number; name: string | null };
  tool?: { id: number; name: string };
};

// email is omitted for certifiers (security policy strips pii from their view);
// only admins/board receive it. Treat as optional everywhere it's read.
type Member = { id: number; name: string | null; email?: string };

type Tab = 'tools' | 'person' | 'all';

const LEVEL_OPTIONS = [
  { value: 'BASIC', label: 'Basic' },
  { value: 'CERTIFIED', label: 'Certified' },
  { value: 'DOF', label: 'DoF' },
  { value: 'INSTRUCTOR', label: 'Instructor' },
  { value: 'MAY_CERTIFY_OTHERS', label: 'Certifier' },
];

function GrantForm({
  tools, members, prefillToolId, prefillMemberId, onGranted, saving, setSaving, canGrantCertifier,
}: {
  tools: Tool[];
  members: Member[];
  prefillToolId?: number;
  prefillMemberId?: number;
  onGranted: (msg: string) => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  // Only admins/board may grant the Certifier (MAY_CERTIFY_OTHERS) level.
  canGrantCertifier: boolean;
}) {
  // Tool certifiers can grant up to (but not including) Certifier; the backend
  // enforces this too — this just keeps the option out of their dropdown.
  const levelOptions = canGrantCertifier
    ? LEVEL_OPTIONS
    : LEVEL_OPTIONS.filter(o => o.value !== 'MAY_CERTIFY_OTHERS');
  const [toolId, setToolId] = useState(prefillToolId?.toString() ?? "");
  const [memberId, setMemberId] = useState(prefillMemberId?.toString() ?? "");
  const [level, setLevel] = useState("CERTIFIED");
  const [confirm, setConfirm] = useState<null | { toolName: string; userName: string; newLevel: string; payload: object }>(null);

  const selectedTool = tools.find(t => t.id === parseInt(toolId));
  const selectedMember = members.find(m => m.id === parseInt(memberId));

  const initiate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!toolId || !memberId || !level) return;
    setConfirm({
      toolName: selectedTool?.name ?? '?',
      userName: selectedMember?.name ?? selectedMember?.email ?? '?',
      newLevel: level,
      payload: { toolId: parseInt(toolId), personId: parseInt(memberId), level },
    });
  };

  const confirm_ = async () => {
    if (!confirm) return;
    setSaving(true);
    try {
      const res = await fetch('/api/shop/certifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirm.payload),
      });
      const data = await res.json();
      if (res.ok) {
        onGranted(`Certification updated for ${confirm.userName} on ${confirm.toolName}.`);
        setMemberId(prefillMemberId?.toString() ?? "");
        setToolId(prefillToolId?.toString() ?? "");
      } else {
        onGranted(data.error ?? 'Failed.');
      }
    } finally {
      setSaving(false);
      setConfirm(null);
    }
  };

  return (
    <>
      <form onSubmit={initiate}>
        <Group align="flex-end" gap="sm" wrap="wrap">
          {!prefillToolId && (
            <Select
              label="Tool" required style={{ flex: '1 1 180px' }}
              placeholder="-- Tool --"
              value={toolId} onChange={(v) => setToolId(v ?? "")}
              data={tools.map(t => ({ value: String(t.id), label: t.name }))}
            />
          )}
          {!prefillMemberId && (
            <Select
              label="Member" required style={{ flex: '1 1 180px' }} searchable
              placeholder="-- Member --"
              value={memberId} onChange={(v) => setMemberId(v ?? "")}
              data={members.map(m => ({ value: String(m.id), label: m.name ?? m.email ?? `#${m.id}` }))}
            />
          )}
          <Select label="Level" w={140} value={level} onChange={(v) => setLevel(v ?? "CERTIFIED")} allowDeselect={false} data={levelOptions} />
          <Button type="submit" disabled={saving}>Grant</Button>
        </Group>
      </form>

      <Modal opened={!!confirm} onClose={() => setConfirm(null)} title="Confirm Certification" centered>
        <Text mb="lg">
          Grant <strong>{confirm?.newLevel}</strong> on <strong>{confirm?.toolName}</strong> to <strong>{confirm?.userName}</strong>?
        </Text>
        <Group grow>
          <Button variant="default" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button onClick={confirm_} disabled={saving} loading={saving}>Confirm</Button>
        </Group>
      </Modal>
    </>
  );
}

// ---- Tools tab ----

function ToolsTab({ tools, members, isAdmin, isCertifier, onToolsChange }: {
  tools: Tool[];
  members: Member[];
  isAdmin: boolean;
  isCertifier: boolean;
  onToolsChange: () => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [certs, setCerts] = useState<Certification[]>([]);
  const [loadingCerts, setLoadingCerts] = useState(false);
  const [editingGuide, setEditingGuide] = useState<{ id: number; value: string } | null>(null);
  const [savingGuide, setSavingGuide] = useState(false);
  const [msg, setMsg] = useState("");
  const [grantMsg, setGrantMsg] = useState("");
  const [grantSaving, setGrantSaving] = useState(false);
  const [search, setSearch] = useState("");

  const loadCerts = async (toolId: number) => {
    setLoadingCerts(true);
    try {
      const res = await fetch(`/api/shop/certifications?toolId=${toolId}`);
      if (res.ok) setCerts(await res.json());
    } finally {
      setLoadingCerts(false);
    }
  };

  const toggle = (toolId: number) => {
    if (expanded === toolId) { setExpanded(null); setCerts([]); return; }
    setExpanded(toolId);
    void loadCerts(toolId);
  };

  const saveGuide = async () => {
    if (!editingGuide) return;
    setSavingGuide(true);
    try {
      const res = await fetch(`/api/shop/tools/${editingGuide.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ safetyGuide: editingGuide.value }),
      });
      if (res.ok) {
        setMsg("Safety guide updated.");
        setEditingGuide(null);
        onToolsChange();
        if (expanded === editingGuide.id) {
          const toolRes = await fetch(`/api/shop/certifications?toolId=${editingGuide.id}`);
          if (toolRes.ok) setCerts(await toolRes.json());
        }
      } else {
        setMsg("Failed to update.");
      }
    } finally {
      setSavingGuide(false);
    }
  };

  const filtered = tools.filter(t => t.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      {msg && <Alert color="cyan" mb="md">{msg}</Alert>}

      <Group mb="md" align="center" wrap="wrap">
        <TextInput placeholder="Search tools..." value={search} onChange={e => setSearch(e.currentTarget.value)} style={{ flex: '1 1 220px' }} />
      </Group>

      {filtered.length === 0 && <Text c="dimmed">No tools match.</Text>}

      <Stack gap="xs">
        {filtered.map((tool) => {
          const isOpen = expanded === tool.id;
          return (
            <Card key={tool.id} withBorder radius="md" padding={0} style={isOpen ? { borderColor: 'var(--mantine-color-cyan-5)' } : undefined}>
              <Group gap="md" p="md" wrap="wrap" style={{ cursor: 'pointer' }} onClick={() => toggle(tool.id)}>
                <Text fw={600} c={isOpen ? 'cyan' : undefined} style={{ flex: '1 1 160px', minWidth: 120 }}>{tool.name}</Text>
                <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{tool._count?.toolStatuses ?? '?'} certified</Text>
                {tool.safetyGuide ? (
                  <Anchor href={tool.safetyGuide} target="_blank" rel="noopener noreferrer" size="sm" onClick={(e) => e.stopPropagation()}>Safety Guide ↗</Anchor>
                ) : (
                  <Text size="sm" c="dimmed">No guide</Text>
                )}
                {isAdmin && (
                  <Button size="compact-xs" variant="default" onClick={(e) => { e.stopPropagation(); setEditingGuide({ id: tool.id, value: tool.safetyGuide ?? '' }); setMsg(""); }}>
                    Edit guide
                  </Button>
                )}
                <Text c="dimmed" size="sm">{isOpen ? '▲' : '▼'}</Text>
              </Group>

              {isOpen && (
                <Card.Section withBorder p="md">
                  {loadingCerts ? <Center py="sm"><Loader size="sm" /></Center> : (
                    <>
                      <Text fw={600} size="sm" c="dimmed" mb="sm">Certified Treehouse Members</Text>
                      {certs.length === 0 ? (
                        <Text c="dimmed" size="sm">No certifications yet.</Text>
                      ) : (
                        <Stack gap={6} mb="md">
                          {certs.map((c) => (
                            <Group key={`${c.personId}-${c.toolId}`} justify="space-between" p="xs" style={{ borderRadius: 6, background: 'var(--mantine-color-default-hover)' }}>
                              <Text size="sm">{c.person?.name ?? 'Unnamed'}</Text>
                              <ToolLevelBadge level={toToolLevel(c.level)} />
                            </Group>
                          ))}
                        </Stack>
                      )}
                      {isCertifier && (
                        <>
                          {grantMsg && <Text size="sm" c="cyan" mb="sm">{grantMsg}</Text>}
                          <GrantForm tools={tools} members={members} prefillToolId={tool.id}
                            canGrantCertifier={isAdmin}
                            onGranted={m => { setGrantMsg(m); void loadCerts(tool.id); }}
                            saving={grantSaving} setSaving={setGrantSaving} />
                        </>
                      )}
                    </>
                  )}
                </Card.Section>
              )}
            </Card>
          );
        })}
      </Stack>

      <Modal opened={!!editingGuide} onClose={() => setEditingGuide(null)} title="Edit Safety Guide URL" centered>
        <TextInput type="url" placeholder="https://..." value={editingGuide?.value ?? ''} onChange={e => editingGuide && setEditingGuide({ ...editingGuide, value: e.currentTarget.value })} mb="md" />
        <Group grow>
          <Button variant="default" onClick={() => setEditingGuide(null)}>Cancel</Button>
          <Button onClick={saveGuide} disabled={savingGuide} loading={savingGuide}>Save</Button>
        </Group>
      </Modal>
    </div>
  );
}

// ---- By Person tab ----

function PersonTab({ members, tools, isCertifier, isAdmin }: { members: Member[]; tools: Tool[]; isCertifier: boolean; isAdmin: boolean }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [certs, setCerts] = useState<Certification[]>([]);
  const [loadingCerts, setLoadingCerts] = useState(false);
  const [search, setSearch] = useState("");
  const [grantMsg, setGrantMsg] = useState("");
  const [grantSaving, setGrantSaving] = useState(false);

  const loadCerts = async (memberId: number) => {
    setLoadingCerts(true);
    try {
      const res = await fetch(`/api/shop/certifications?personId=${memberId}`);
      if (res.ok) setCerts(await res.json());
    } finally {
      setLoadingCerts(false);
    }
  };

  const toggle = (memberId: number) => {
    if (expanded === memberId) { setExpanded(null); setCerts([]); return; }
    setExpanded(memberId);
    void loadCerts(memberId);
  };

  const filtered = members.filter(personQueryMatcher(search));

  return (
    <div>
      <TextInput placeholder="Search members by name, email, or ID..." value={search} onChange={e => setSearch(e.currentTarget.value)} mb="md" />

      {filtered.length === 0 && <Text c="dimmed">No members match.</Text>}

      <Stack gap="xs">
        {filtered.map((member) => {
          const isOpen = expanded === member.id;
          return (
            <Card key={member.id} withBorder radius="md" padding={0} style={isOpen ? { borderColor: 'var(--mantine-color-cyan-5)' } : undefined}>
              <Group gap="md" p="md" wrap="nowrap" style={{ cursor: 'pointer' }} onClick={() => toggle(member.id)}>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <Text fw={600} c={isOpen ? 'cyan' : undefined} truncate>{member.name ?? 'Unnamed'}</Text>
                </div>
                <Text c="dimmed" size="sm">{isOpen ? '▲' : '▼'}</Text>
              </Group>

              {isOpen && (
                <Card.Section withBorder p="md">
                  {loadingCerts ? <Center py="sm"><Loader size="sm" /></Center> : (
                    <>
                      <Text fw={600} size="sm" c="dimmed" mb="sm">Tool certifications</Text>
                      {certs.length === 0 ? (
                        <Text c="dimmed" size="sm">No certifications.</Text>
                      ) : (
                        <Stack gap={6} mb="md">
                          {certs.map((c) => (
                            <Group key={`${c.personId}-${c.toolId}`} justify="space-between" p="xs" style={{ borderRadius: 6, background: 'var(--mantine-color-default-hover)' }}>
                              <Text size="sm">{c.tool?.name ?? 'Unknown Tool'}</Text>
                              <ToolLevelBadge level={toToolLevel(c.level)} />
                            </Group>
                          ))}
                        </Stack>
                      )}
                      {isCertifier && (
                        <>
                          {grantMsg && <Text size="sm" c="cyan" mb="sm">{grantMsg}</Text>}
                          <GrantForm tools={tools} members={members} prefillMemberId={member.id}
                            canGrantCertifier={isAdmin}
                            onGranted={m => { setGrantMsg(m); void loadCerts(member.id); }}
                            saving={grantSaving} setSaving={setGrantSaving} />
                        </>
                      )}
                    </>
                  )}
                </Card.Section>
              )}
            </Card>
          );
        })}
      </Stack>
    </div>
  );
}

// ---- All Assignments tab ----

function AllTab({ tools }: { tools: Tool[] }) {
  const [certs, setCerts] = useState<Certification[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch('/api/shop/certifications?all=true')
      .then(r => r.ok ? r.json() : [])
      .then(setCerts)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Center py="md"><Loader /></Center>;

  const s = search.toLowerCase();

  // Build the person×tool matrix from the flat cert list.
  const memberMap = new Map<number, string>();
  const toolMap = new Map<number, string>();
  const cell = new Map<string, Certification>(); // `${personId}-${toolId}` -> cert
  // Seed all tools so columns show even with zero assignments.
  for (const t of tools) toolMap.set(t.id, t.name);
  for (const c of certs) {
    if (c.person) memberMap.set(c.person.id, c.person.name ?? 'Unnamed');
    if (c.tool) toolMap.set(c.tool.id, c.tool.name);
    cell.set(`${c.personId}-${c.toolId}`, c);
  }
  const byName = (a: [number, string], b: [number, string]) => a[1].localeCompare(b[1]);
  const allMembers = [...memberMap].sort(byName);
  const allTools = [...toolMap].sort(byName);

  // ponytail: one search box, intuitive narrowing — matched tools narrow columns,
  // matched members narrow rows; if neither side matches, that axis stays full.
  const mMembers = allMembers.filter(([, n]) => n.toLowerCase().includes(s));
  const mTools = allTools.filter(([, n]) => n.toLowerCase().includes(s));
  const rows = !s ? allMembers : (mMembers.length ? mMembers : allMembers);
  const cols = !s ? allTools : (mTools.length ? mTools : allTools);

  const DOT = 22;       // dot diameter — matches the height of the labeled badge blob
  const COL = 52;       // tool column width; also sets diagonal-label spacing
  const HEAD_H = 150;   // header height reserved for the 45° tool labels
  const MEMBER_W = 180; // fixed width for the member-name column
  const BORDER = '1px solid var(--mantine-color-default-border)'; // body-only column separators
  // The rightmost labels rise up-right past the last column; reserve a trailing
  // spacer column sized to the longest label's horizontal reach so they stay inside
  // the table border. ~6.8px/char at 12px/600, projected onto x via /√2.
  const maxLen = cols.reduce((m, [, n]) => Math.max(m, n.length), 0);
  const SPACER = Math.ceil((maxLen * 6.8 + 12) / 1.414);
  const dotCount = rows.reduce((n, [uid]) =>
    n + cols.reduce((m, [tid]) => m + (cell.has(`${uid}-${tid}`) ? 1 : 0), 0), 0);

  return (
    <div>
      <Group justify="space-between" align="center" mb="md" wrap="wrap">
        <TextInput placeholder="Filter by tool or member..." value={search} onChange={e => setSearch(e.currentTarget.value)} style={{ flex: '1 1 220px' }} />
        <Text size="sm" c="dimmed">{dotCount} assignment{dotCount !== 1 ? 's' : ''}</Text>
      </Group>

      {rows.length === 0 || cols.length === 0 ? (
        <Text c="dimmed">No assignments found.</Text>
      ) : (
        // Self-contained scroll box: header sticks to the box top (offset 0),
        // rows scroll vertically and tools scroll horizontally inside it.
        <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 240px)' }}>
          <Table
            striped
            highlightOnHover
            withTableBorder
            stickyHeader
            verticalSpacing={6}
            style={{ width: 'max-content' }}
          >
            {/* opaque header backdrop so scrolled rows don't show through the sticky header */}
            <Table.Thead style={{ background: 'var(--mantine-color-body)' }}>
              <Table.Tr>
                <Table.Th style={{ width: MEMBER_W, verticalAlign: 'bottom', whiteSpace: 'nowrap', background: 'transparent' }}>Member</Table.Th>
                {cols.map(([tid, name]) => (
                  // Each label anchored at its column's bottom-center and rotated -45°
                  // around that point → parallel diagonals, evenly spaced by COL, no overlap.
                  <Table.Th key={tid} style={{ height: HEAD_H, padding: 0, width: COL, verticalAlign: 'bottom', overflow: 'visible', background: 'transparent' }}>
                    <div style={{ position: 'relative', height: HEAD_H, width: COL, overflow: 'visible' }}>
                      <span
                        title={name}
                        style={{
                          position: 'absolute', bottom: 6, left: '50%', zIndex: 1,
                          transformOrigin: 'left bottom',
                          transform: 'rotate(-45deg)',
                          whiteSpace: 'nowrap',
                          borderBottom: '1px solid var(--mantine-color-gray-4)',
                          paddingBottom: 2, fontWeight: 600, fontSize: 12, lineHeight: 1,
                        }}
                      >
                        {name}
                      </span>
                    </div>
                  </Table.Th>
                ))}
                <Table.Th style={{ width: SPACER, padding: 0, background: 'transparent' }} aria-hidden />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map(([uid, mname]) => (
                <Table.Tr key={uid}>
                  <Table.Td fw={500} style={{ width: MEMBER_W, whiteSpace: 'nowrap', borderRight: BORDER }}>{mname}</Table.Td>
                  {cols.map(([tid]) => {
                    const c = cell.get(`${uid}-${tid}`);
                    const lvl = c ? toToolLevel(c.level) : null;
                    return (
                      <Table.Td key={tid} style={{ textAlign: 'center', padding: 2, width: COL, borderRight: BORDER }}>
                        {lvl && (
                          <span
                            title={`${mname} · ${toolMap.get(tid)} — ${toolLevelLabel(lvl)}`}
                            style={{
                              display: 'inline-block', verticalAlign: 'middle',
                              width: DOT, height: DOT, borderRadius: '50%',
                              background: toolLevelDot(lvl),
                            }}
                          />
                        )}
                      </Table.Td>
                    );
                  })}
                  <Table.Td style={{ width: SPACER }} aria-hidden />
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ---- Embeddable panel (no outer Container/header) ----

export function ToolManagementPanel() {
  const { user, loading: authLoading, ready } = useRequireRole([]);
  const hasFetched = useRef(false);

  const [tab, setTab] = useState<Tab>('tools');
  const [tools, setTools] = useState<Tool[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (ready && !hasFetched.current) {
      hasFetched.current = true;
      Promise.all([
        fetch('/api/shop/tools').then(r => r.ok ? r.json() : []),
        fetch('/api/shop/org-members').then(r => r.ok ? r.json() : { orgMembers: [] }),
      ]).then(([toolData, memberData]) => {
        setTools(toolData);
        setMembers(memberData.orgMembers ?? []);
      }).finally(() => setLoading(false));
    }
  }, [ready]);

  if (loading || authLoading) {
    return <PageLoader minHeight="40vh" />;
  }

  // Role gate stays inline: this renders a Forbidden alert (not a redirect),
  // so useRequireRole can only own the generic sign-in gate above.
  const isSysadmin = user?.isSysadmin;
  const isBoardMember = user?.isBoardMember;
  const isAdmin = isSysadmin || isBoardMember;

  const isKeyholder = user?.isKeyholder;
  const hasCertifierAuth = (user?.toolStatuses ?? []).some((ts: { level?: string }) => ts.level === 'MAY_CERTIFY_OTHERS');
  const isCertifier = isSysadmin || isBoardMember || hasCertifierAuth;
  const canSeeAll = isCertifier || isKeyholder;

  if (!isCertifier && !isAdmin) {
    return (
      <Alert color="red">Forbidden: You require the Admin, Board Member, or Certifier role.</Alert>
    );
  }

  const reloadTools = () => {
    fetch('/api/shop/tools').then(r => r.ok ? r.json() : []).then(setTools);
  };

  return (
    <Tabs value={tab} onChange={(v) => setTab(v as Tab)} keepMounted={false}>
      <ScrollableTabsList mb="md">
        <Tabs.Tab value="tools">All Tools</Tabs.Tab>
        <Tabs.Tab value="person">By Person</Tabs.Tab>
        {canSeeAll && <Tabs.Tab value="all">All Assignments</Tabs.Tab>}
      </ScrollableTabsList>

      <Tabs.Panel value="tools">
        <ToolsTab tools={tools} members={members} isAdmin={!!isAdmin} isCertifier={!!isCertifier} onToolsChange={reloadTools} />
      </Tabs.Panel>
      <Tabs.Panel value="person">
        <PersonTab members={members} tools={tools} isCertifier={!!isCertifier} isAdmin={!!isAdmin} />
      </Tabs.Panel>
      {canSeeAll && (
        <Tabs.Panel value="all">
          <AllTab tools={tools} />
        </Tabs.Panel>
      )}
    </Tabs>
  );
}
