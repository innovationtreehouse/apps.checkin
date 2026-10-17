"use client";

import { useState, useEffect } from "react";
import { Anchor, Badge, Button, Card, Center, Code, Group, List, Loader, Stack, Text, Title } from "@mantine/core";

type DailyStat = {
  date: string;
  count: number;
  median: number;
  p90: number;
  p99: number;
};

// A dependency-free SVG Line Chart Component
function SvgLineChart({ data }: { data: DailyStat[] }) {
  if (data.length === 0) return <Text c="dimmed">No data available.</Text>;

  const width = 800;
  const height = 400;
  const padding = 40;
  const graphWidth = width - padding * 2;
  const graphHeight = height - padding * 2;

  // Find max value to scale the Y axis
  const maxP99 = Math.max(...data.map(d => d.p99), 100); // minimum scale is 100ms
  const yMax = Math.ceil(maxP99 / 100) * 100 + 50; // Add some headroom

  const getX = (index: number) => padding + (index / (data.length - 1)) * graphWidth;
  const getY = (value: number) => height - padding - (value / yMax) * graphHeight;

  const createPath = (key: 'median' | 'p90' | 'p99') => {
    return data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(d[key])}`).join(' ');
  };

  return (
    <Card withBorder radius="md" p="md" style={{ overflowX: 'auto' }}>
      <svg width="100%" height="auto" viewBox={`0 0 ${width} ${height}`} style={{ minWidth: '600px', display: 'block' }}>
        {/* Background Grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding + graphHeight * ratio;
          const val = Math.round(yMax * (1 - ratio));
          return (
            <g key={ratio}>
              <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="var(--mantine-color-default-border)" strokeWidth="1" strokeDasharray="4,4" />
              <text x={padding - 10} y={y + 4} fill="var(--mantine-color-dimmed)" fontSize="12" textAnchor="end">{val}ms</text>
            </g>
          );
        })}

        {/* Data Lines */}
        <path d={createPath('median')} fill="none" stroke="#4ade80" strokeWidth="3" />
        <path d={createPath('p90')} fill="none" stroke="#facc15" strokeWidth="3" style={{ opacity: 0.8 }} />
        <path d={createPath('p99')} fill="none" stroke="#ef4444" strokeWidth="3" style={{ opacity: 0.8 }} />

        {/* Data Points and Tooltips (simulated via titles for simplicity) */}
        {data.map((d, i) => (
          <g key={i}>
            <circle cx={getX(i)} cy={getY(d.p99)} r="4" fill="#ef4444">
              <title>{d.date} - P99: {d.p99}ms ({d.count} scans)</title>
            </circle>
            <circle cx={getX(i)} cy={getY(d.p90)} r="4" fill="#facc15">
              <title>{d.date} - P90: {d.p90}ms ({d.count} scans)</title>
            </circle>
            <circle cx={getX(i)} cy={getY(d.median)} r="4" fill="#4ade80">
              <title>{d.date} - Median: {d.median}ms ({d.count} scans)</title>
            </circle>

            {/* X-Axis Labels (every 5 days to avoid crowding) */}
            {i % 5 === 0 && (
              <text x={getX(i)} y={height - 15} fill="var(--mantine-color-dimmed)" fontSize="12" textAnchor="middle">
                {d.date.substring(5)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <Group justify="center" gap="xl" mt="md">
        <Group gap="xs"><Badge color="green" circle /> <Text size="sm">Median</Text></Group>
        <Group gap="xs"><Badge color="yellow" circle /> <Text size="sm">P90</Text></Group>
        <Group gap="xs"><Badge color="red" circle /> <Text size="sm">P99</Text></Group>
      </Group>
    </Card>
  );
}

type ConfigCheck = { id: string; label: string; ok: boolean; detail: string };

/**
 * System-config health — one row per check (Zoho e-sign, agreement PDF, webhook
 * secret, email). Fed by GET /api/system-status/config-health (admins + board only).
 * Green dot = configured/healthy (detail may note a dev-mock state); red = a real gap
 * whose detail names the env var to set. See lib/configHealth.ts.
 */
export function ConfigHealthBox() {
  const [checks, setChecks] = useState<ConfigCheck[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch('/api/system-status/config-health')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setChecks(data.checks as ConfigCheck[]))
      .catch(() => setFailed(true));
  }, []);

  const openIssues = checks?.filter((c) => !c.ok).length ?? 0;

  return (
    <Card withBorder radius="md" padding="lg">
      <Group gap="sm" mb="md">
        <Title order={4}>Integration Config</Title>
        {openIssues > 0 && <Badge color="red" circle title={`${openIssues} config issue(s)`} />}
      </Group>

      {failed ? (
        <Text c="yellow">Unable to load config health.</Text>
      ) : !checks ? (
        <Text c="dimmed">Checking configuration…</Text>
      ) : (
        <List spacing="sm" listStyleType="none">
          {checks.map((c) => (
            <List.Item key={c.id}>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <span>{c.label}</span>
                <Text c={c.ok ? 'green' : 'red'} fw={c.ok ? undefined : 700} ta="right">
                  ● {c.ok ? 'Configured' : 'NOT configured'}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">{c.detail}</Text>
            </List.Item>
          ))}
        </List>
      )}
    </Card>
  );
}

// Mirrors CronJobStatus in lib/cronRuns.ts (lastSuccessAt arrives JSON-serialized).
type CronJob = { job: string; lastSuccessAt: string; stale: boolean; lastError?: string };

/** "3 hours ago" / "2 days ago" — coarse on purpose; the exact stamp is the title text. */
function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/**
 * Last successful run of each cron sweep, from GET /api/system-status/config-health
 * (admins + board only). Nothing in this repo schedules the crons — the schedule and
 * the caller live in a separate infra repo — so this panel is the app's only view of
 * whether its own nightly sweeps are still firing. Two separate failures show here and
 * both add to the red System Status nav pill: a job past the staleness window (stopped
 * running) and a job whose latest run could not finish its work. See lib/cronRuns.ts.
 */
export function CronRunsBox() {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch('/api/system-status/config-health')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setJobs(data.cronJobs as CronJob[]))
      .catch(() => setFailed(true));
  }, []);

  // Mirrors countUnhealthyCronJobs so the panel badge and the nav pill agree: a job
  // that ran last night but failed rows is not stale, and still needs attention.
  const alertCount = jobs?.filter((j) => j.stale || j.lastError).length ?? 0;

  return (
    <Card withBorder radius="md" padding="lg">
      <Group gap="sm" mb="xs">
        <Title order={4}>Scheduled Jobs</Title>
        {alertCount > 0 && <Badge color="red" circle title={`${alertCount} job(s) need attention`} />}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Last completed run of each nightly sweep. A red timestamp means the job has not run
        in over 48 hours — treat it as stopped and check the scheduler. A red line beneath a
        green timestamp means the job ran, but could not finish its work.
      </Text>

      {failed ? (
        <Text c="yellow">Unable to load scheduled-job status.</Text>
      ) : !jobs ? (
        <Text c="dimmed">Checking scheduled jobs…</Text>
      ) : jobs.length === 0 ? (
        <Text c="dimmed">No cron run has been recorded yet.</Text>
      ) : (
        <List spacing="sm" listStyleType="none">
          {jobs.map((j) => (
            <List.Item key={j.job}>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Code>{j.job}</Code>
                <Text c={j.stale ? 'red' : 'green'} fw={j.stale ? 700 : undefined} ta="right" title={j.lastSuccessAt}>
                  ● {timeAgo(j.lastSuccessAt)}
                </Text>
              </Group>
              {j.lastError && (
                <Text size="xs" c="red">Last run: {j.lastError}</Text>
              )}
            </List.Item>
          ))}
        </List>
      )}
    </Card>
  );
}

// Mirrors DiagStep in api/finance-ops/s-read/diagnose/route.ts.
type DiagStep = { id: string; ok: boolean | null; detail: string; code?: string };

// Human labels for the diagnose route's stable step slugs.
const DIAG_LABELS: Record<string, string> = {
  "env": "Mirror env wiring",
  "mirror-read": "Mirror read (network → auth → DB → table → grant → rows)",
  "latest-run": "Latest sync run",
  "clock": "Timestamp sanity",
  "trigger-env": "Sync trigger env wiring",
  "trigger-invoke": "Sync trigger invoke (dry run)",
};

/**
 * On-demand deep probe of the s-read chain (docs/ops/shopify-mirror.md).
 * Deliberately NOT run on page load and never polled: every probe wakes the
 * scale-to-zero Aurora cluster, so it fires only on an explicit click. This is
 * the deep counterpart to ConfigHealthBox above, which stays presence-only.
 */
export function SReadDiagnosticsBox() {
  const [steps, setSteps] = useState<DiagStep[] | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);

  const run = async () => {
    setRunning(true);
    setFailed(false);
    try {
      const res = await fetch('/api/finance-ops/s-read/diagnose');
      if (!res.ok) throw new Error();
      setSteps((await res.json()).steps as DiagStep[]);
    } catch {
      setSteps(null);
      setFailed(true);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" mb="md">
        <Title order={4}>Shopify Mirror (s-read) Diagnostics</Title>
        <Button size="xs" variant="light" onClick={run} loading={running}>Run diagnostics</Button>
      </Group>
      <Text size="sm" c="dimmed" mb={steps || failed ? "md" : 0}>
        Probes each link the payments page&apos;s sync status depends on and names the first
        broken one. Wakes the database cluster — run it when something is wrong, not on a timer.
      </Text>

      {failed && <Text c="red">Diagnostics failed to run — see the server log.</Text>}
      {steps && (
        <List spacing="sm" listStyleType="none">
          {steps.map((s) => (
            <List.Item key={s.id}>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <span>{DIAG_LABELS[s.id] ?? s.id}</span>
                <Text c={s.ok === null ? 'dimmed' : s.ok ? 'green' : 'red'} fw={s.ok === false ? 700 : undefined} ta="right">
                  ● {s.ok === null ? 'Skipped' : s.ok ? 'OK' : 'FAIL'}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                {s.detail}{s.code ? <> <Code>{s.code}</Code></> : null}
              </Text>
            </List.Item>
          ))}
        </List>
      )}
    </Card>
  );
}

type GithubCommit = {
  sha: string;
  html_url: string;
  commit: { message: string };
};

export function SystemVersionBox() {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [commits, setCommits] = useState<GithubCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function checkVersion() {
      try {
        const localRes = await fetch('/api/system-status/kiosk-version');
        const localData = await localRes.json();
        const currentSha = localData.version;
        setCurrentVersion(currentSha);

        if (currentSha && !currentSha.startsWith('unknown')) {
          const ghRes = await fetch('https://api.github.com/repos/innovationtreehouse/apps.checkin/commits/main');
          if (!ghRes.ok) throw new Error('Failed to fetch latest version from GitHub');

          const ghData = await ghRes.json();
          const latestSha = ghData.sha;
          setLatestVersion(latestSha);

          if (latestSha && currentSha !== latestSha && !latestSha.startsWith(currentSha)) {
            const compRes = await fetch(`https://api.github.com/repos/innovationtreehouse/apps.checkin/compare/${currentSha}...main`);
            if (compRes.ok) {
              const compData = await compRes.json();
              if (compData.commits) {
                setCommits(compData.commits);
              }
            }
          }
        }
      } catch (err) {
        console.error("Failed to check version:", err);
        setError("Unable to verify updates");
      } finally {
        setLoading(false);
      }
    }
    checkVersion();
  }, []);

  if (loading) {
    return (
      <Card withBorder radius="md" padding="lg">
        <Title order={4} mb="xs">System Version</Title>
        <Text c="dimmed">Checking for updates...</Text>
      </Card>
    );
  }

  const isMismatch = currentVersion && latestVersion && !latestVersion.startsWith(currentVersion) && currentVersion !== latestVersion;

  return (
    <Card withBorder radius="md" padding="lg">
      <Group gap="sm" mb="xs">
        <Title order={4}>System Version</Title>
        {isMismatch && <Badge color="red" circle title="Update Available" />}
      </Group>

      <Text c="dimmed" mb="md">
        Current launched version: <Code>{currentVersion?.substring(0, 7) || 'Unknown'}</Code>
      </Text>

      {error ? (
        <Text c="yellow">{error}</Text>
      ) : isMismatch ? (
        <Stack>
          <Text c="red" fw={700}>
            Update Available! (Latest: <Code>{latestVersion?.substring(0, 7)}</Code>)
          </Text>

          <Anchor
            href={`https://github.com/innovationtreehouse/apps.checkin/compare/${currentVersion}...main`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Upgrade Now
          </Anchor>

          {commits.length > 0 && (
            <Card withBorder radius="sm" p="md">
              <Title order={5} mb="xs">Summary of changes:</Title>
              <List size="sm" spacing="xs">
                {commits.map((c) => (
                  <List.Item key={c.sha}>
                    <Anchor href={c.html_url} target="_blank" rel="noopener noreferrer">
                      <Code>{c.sha.substring(0, 7)}</Code>
                    </Anchor>
                    {' - '}{c.commit.message.split('\n')[0]}
                  </List.Item>
                ))}
              </List>
            </Card>
          )}
        </Stack>
      ) : (
        <Text c="green" fw={700}>✓ System is up to date</Text>
      )}
    </Card>
  );
}

type HeartbeatRow = { metric: string; timestamp: string; value: number };

export function KioskHeartbeatBox() {
  const [rows, setRows] = useState<HeartbeatRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/system-status/kiosk-heartbeat")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: { heartbeat?: HeartbeatRow[] }) => {
        setRows(Array.isArray(data?.heartbeat) ? data.heartbeat : []);
      })
      .catch(() => setRows(null))
      .finally(() => setLoading(false));
  }, []);

  let body: string;
  if (loading) body = "Checking…";
  else if (rows == null) body = "Unable to read kiosk last-seen.";
  else if (rows.length === 0) body = "No kiosk request since this task started (stale during overnight curfew is expected).";
  else {
    const age = rows[0].value;
    const minutes = Math.floor(age / 60);
    body = minutes < 1 ? `Kiosk last seen ${age}s ago` : `Kiosk last seen ${minutes}m ago`;
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={4} mb="xs">Kiosk last seen</Title>
      <Text size="sm" c="dimmed">{body}</Text>
    </Card>
  );
}

export function BadgeScanChart() {
  const [stats, setStats] = useState<DailyStat[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/system-status/health')
      .then(res => res.json())
      .then(data => {
        if (data && data.days) {
          setStats(data.days);
        }
      })
      .catch((err) => console.error("Failed to load system health:", err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={4}>Badge Scan Response Times (Last 30 Days)</Title>
      <Text c="dimmed" size="sm" mb="lg">
        This graph displays the operational latency of the badge scanning system. Lower values
        indicate faster responses.
      </Text>

      {loading ? (
        <Center py="xl"><Loader /></Center>
      ) : stats ? (
        <SvgLineChart data={stats} />
      ) : (
        <Center py="xl"><Text c="red">Failed to load metrics.</Text></Center>
      )}
    </Card>
  );
}
