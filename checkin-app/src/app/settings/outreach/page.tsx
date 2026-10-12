"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Alert, Badge, Button, Card, Center, Group, Loader, Modal, Progress, Radio, Stack, Text, Textarea, TextInput, Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useUnsavedGuard, shallowEqual } from "@/components/UnsavedChangesProvider";
import { substituteTokens } from "@/lib/outreach/tokens";

type TemplateKey = "opening" | "reminder";

interface Settings {
  outreachOpeningSubject: string | null;
  outreachOpeningBody: string | null;
  outreachReminderSubject: string | null;
  outreachReminderBody: string | null;
}

interface Counts {
  queued: number;
  sent: number;
  failed: number;
  skipped_unsubscribed: number;
  sending: number;
  total: number;
}

interface BulkSendSummary {
  id: number;
  emailType: string;
  audience: string;
  startedAt: string;
  completedAt: string | null;
  counts: Counts;
}

const SAMPLE_NAME = "Jordan Rivera";
const TEMPLATE_LABEL: Record<TemplateKey, string> = { opening: "Opening of renewals", reminder: "Reminder" };
const AUDIENCE_LABEL: Record<string, string> = {
  a: "Unsettled members + non-members (default)",
  b: "Same as (a), excluding in-flight renewals/applications",
  c: "Everyone (all live leads with an email)",
};

export default function OutreachSettingsPage() {
  const { ready, loading: authLoading } = useRequireRole(["isBoardMember", "isSysadmin", "isOperations"]);

  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState({ subject: "", body: "" });
  const [reminder, setReminder] = useState({ subject: "", body: "" });
  const [initial, setInitial] = useState<{ opening: { subject: string; body: string }; reminder: { subject: string; body: string } } | null>(null);
  const [nextDeadline, setNextDeadline] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<{ text: string; err: boolean } | null>(null);
  const [testSending, setTestSending] = useState<TemplateKey | null>(null);

  const load = useCallback(() => fetch("/api/settings/outreach")
    .then(async (res) => {
      if (res.ok) {
        const data = (await res.json()) as { settings: Settings; nextDeadline: string | null };
        const snap = {
          opening: { subject: data.settings.outreachOpeningSubject ?? "", body: data.settings.outreachOpeningBody ?? "" },
          reminder: { subject: data.settings.outreachReminderSubject ?? "", body: data.settings.outreachReminderBody ?? "" },
        };
        setOpening(snap.opening);
        setReminder(snap.reminder);
        setInitial(snap);
        setNextDeadline(data.nextDeadline);
      }
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  const isDirty = !!initial && !shallowEqual(
    { os: initial.opening.subject, ob: initial.opening.body, rs: initial.reminder.subject, rb: initial.reminder.body },
    { os: opening.subject, ob: opening.body, rs: reminder.subject, rb: reminder.body },
  );
  useUnsavedGuard(isDirty);

  const saveSettings = async () => {
    setSaveNotice(null);
    setSaving(true);
    try {
      const res = await fetch("/api/settings/outreach", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outreachOpeningSubject: opening.subject,
          outreachOpeningBody: opening.body,
          outreachReminderSubject: reminder.subject,
          outreachReminderBody: reminder.body,
        }),
      });
      if (res.ok) {
        notifications.show({ color: "green", message: "Outreach templates saved." });
        setLoading(true);
        await load();
      } else {
        const d = await res.json().catch(() => ({}));
        setSaveNotice({ text: d.error || "Save failed.", err: true });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async (key: TemplateKey) => {
    const t = key === "opening" ? opening : reminder;
    setTestSending(key);
    try {
      const res = await fetch("/api/outreach/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: t.subject, body: t.body }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) notifications.show({ color: "green", message: "Test email sent (both variants) to your address." });
      else notifications.show({ color: "red", message: d.error || "Test send failed.", autoClose: false });
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setTestSending(null);
    }
  };

  if (authLoading) return <Center mih="60vh"><Loader /></Center>;
  if (!ready) return null; // redirect to / is in flight

  return (
    <Stack>
      <SettingsTabs active="outreach" />

      {loading ? (
        <Center py="xl"><Loader /></Center>
      ) : (
        <>
          {nextDeadline === null && (
            <Alert color="red" variant="light">
              The membership-year boundary is not set (Settings → Membership). <code>{"{{deadline}}"}</code> has
              nothing to render — sending (test or campaign) is blocked until it is configured.
            </Alert>
          )}

          <TemplateCard
            title={TEMPLATE_LABEL.opening}
            value={opening}
            onChange={setOpening}
            deadline={nextDeadline}
            testSending={testSending === "opening"}
            onSendTest={() => sendTest("opening")}
          />
          <TemplateCard
            title={TEMPLATE_LABEL.reminder}
            value={reminder}
            onChange={setReminder}
            deadline={nextDeadline}
            testSending={testSending === "reminder"}
            onSendTest={() => sendTest("reminder")}
          />

          {saveNotice && <Alert color={saveNotice.err ? "red" : "green"} variant="light">{saveNotice.text}</Alert>}
          <Group>
            <Button disabled={saving} loading={saving} onClick={saveSettings}>Save templates</Button>
          </Group>

          <SendPanel deadlineSet={nextDeadline !== null} />
        </>
      )}
    </Stack>
  );
}

function TemplateCard({
  title, value, onChange, deadline, testSending, onSendTest,
}: {
  title: string;
  value: { subject: string; body: string };
  onChange: (v: { subject: string; body: string }) => void;
  deadline: string | null;
  testSending: boolean;
  onSendTest: () => void;
}) {
  const deadlineText = deadline ?? "(boundary not set)";
  const preview = (variant: "join" | "renew") =>
    substituteTokens(value.body, {
      name: SAMPLE_NAME,
      deadline: deadlineText,
      actionWord: variant === "renew" ? "renew" : "join",
      actionLink: "/membership",
    }) + (variant === "join" ? '<p><a href="#">Unsubscribe from invitations</a></p>' : "");
  const previewSubject = (variant: "join" | "renew") =>
    substituteTokens(value.subject, {
      name: SAMPLE_NAME,
      deadline: deadlineText,
      actionWord: variant === "renew" ? "renew" : "join",
      actionLink: "/membership",
    });

  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={3} mb="xs">{title}</Title>
      <Text c="dimmed" size="sm" mb="md">
        Tokens: <code>{"{{name}}"}</code> <code>{"{{deadline}}"}</code> <code>{"{{actionWord}}"}</code> <code>{"{{actionLink}}"}</code>.
        {" "}The action link always points at <code>/membership</code>, for both members and non-members.
      </Text>

      <Stack gap="sm">
        <TextInput
          label="Subject"
          value={value.subject}
          onChange={(e) => onChange({ ...value, subject: e.currentTarget.value })}
        />
        <Textarea
          label="Body (HTML)"
          minRows={6}
          autosize
          value={value.body}
          onChange={(e) => onChange({ ...value, body: e.currentTarget.value })}
        />
      </Stack>

      <Group mt="md" grow align="flex-start">
        {(["join", "renew"] as const).map((variant) => (
          <Card key={variant} withBorder padding="sm" radius="sm">
            <Badge size="sm" mb="xs" variant="light">{variant === "join" ? "Join (non-member preview)" : "Renew (member preview)"}</Badge>
            <Text fw={600} size="sm" mb={4}>{previewSubject(variant)}</Text>
            {/* Template body is operator-authored HTML (PUT is open to isOperations). Render it in a
                scriptless sandboxed iframe so an <img onerror> can't run in a board/sysadmin session
                that opens this same-origin admin page — sandbox="" blocks scripts while still showing
                the markup a mail client would. */}
            <iframe
              title={`${title}: ${variant} preview`}
              sandbox=""
              srcDoc={`<style>body{margin:0;font:13px system-ui,sans-serif}</style>${preview(variant)}`}
              style={{ border: 0, width: "100%", height: 160 }}
            />
          </Card>
        ))}
      </Group>

      <Button mt="md" variant="light" loading={testSending} onClick={onSendTest}>
        Send test to me (both variants)
      </Button>
    </Card>
  );
}

function SendPanel({ deadlineSet }: { deadlineSet: boolean }) {
  const [audience, setAudience] = useState<"a" | "b" | "c">("a");
  const [panelLoading, setPanelLoading] = useState(true);
  const [inFlight, setInFlight] = useState<BulkSendSummary | null>(null);
  const [lastCompleted, setLastCompleted] = useState<BulkSendSummary | null>(null);
  const [draining, setDraining] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ emailType: TemplateKey; bulkSendId: number; counts: { queued: number; skippedUnsubscribed: number; leadsWithoutEmail: number } } | null>(null);
  const [confirmOpened, { open: openConfirm, close: closeConfirm }] = useDisclosure(false);
  const [starting, setStarting] = useState<TemplateKey | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/outreach/status");
      if (res.ok) {
        const data = (await res.json()) as { inFlight: BulkSendSummary | null; lastCompleted: BulkSendSummary | null };
        setInFlight(data.inFlight);
        setLastCompleted(data.lastCompleted);
      }
    } finally {
      setPanelLoading(false);
    }
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const drain = async (bulkSendId: number) => {
    setDraining(true);
    setSendError(null);
    try {
      for (;;) {
        const res = await fetch("/api/outreach/process-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bulkSendId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { setSendError(data.error || "Send failed mid-batch."); break; }
        await refreshStatus();
        if (data.remaining === 0 || data.processed === 0) break;
      }
    } finally {
      setDraining(false);
    }
  };

  const startSend = async (emailType: TemplateKey) => {
    setSendError(null);
    setStarting(emailType);
    try {
      const res = await fetch("/api/outreach/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailType, audience }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) { setSendError(data.error || "A send is already in progress."); await refreshStatus(); return; }
      if (!res.ok) { setSendError(data.error || "Failed to start send."); return; }
      setConfirm({
        emailType,
        bulkSendId: data.bulkSend.id,
        counts: { queued: data.counts.queued, skippedUnsubscribed: data.counts.skippedUnsubscribed, leadsWithoutEmail: data.counts.leadsWithoutEmail },
      });
      openConfirm();
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setStarting(null);
    }
  };

  const confirmSend = async () => {
    if (!confirm) return;
    closeConfirm();
    const id = confirm.bulkSendId;
    setConfirm(null);
    await drain(id);
  };

  const retryFailed = async (bulkSendId: number) => {
    setSendError(null);
    const res = await fetch("/api/outreach/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", bulkSendId }),
    });
    if (res.ok) {
      await refreshStatus();
      await drain(bulkSendId);
    } else {
      const d = await res.json().catch(() => ({}));
      setSendError(d.error || "Retry failed.");
    }
  };

  const progress = (c: Counts) => (c.total === 0 ? 100 : Math.round(((c.sent + c.failed + c.skipped_unsubscribed) / c.total) * 100));

  return (
    <Card withBorder radius="md" padding="lg" style={{ borderColor: "var(--mantine-color-yellow-5)" }}>
      <Title order={3} mb="xs">Send a campaign</Title>
      <Text c="dimmed" size="sm" mb="md">
        One email per live household lead with an email; the copy resolves join vs. renew from
        current membership. Sending is manual — nothing here runs on a schedule.
      </Text>

      {panelLoading ? (
        <Center py="md"><Loader size="sm" /></Center>
      ) : inFlight ? (
        <Stack>
          <Alert color="blue" variant="light">
            A {TEMPLATE_LABEL[inFlight.emailType as TemplateKey] ?? inFlight.emailType} send (audience {inFlight.audience}) is
            in progress — {inFlight.counts.sent + inFlight.counts.failed + inFlight.counts.skipped_unsubscribed} of{" "}
            {inFlight.counts.total} done.
          </Alert>
          <Progress value={progress(inFlight.counts)} animated={draining} />
          <Group>
            <Button loading={draining} onClick={() => drain(inFlight.id)}>Resume send</Button>
            {inFlight.counts.failed > 0 && (
              <Button variant="light" color="orange" loading={draining} onClick={() => retryFailed(inFlight.id)}>
                Retry {inFlight.counts.failed} failed
              </Button>
            )}
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Radio.Group label="Audience" value={audience} onChange={(v) => setAudience(v as "a" | "b" | "c")}>
            <Stack gap={4} mt="xs">
              {(["a", "b", "c"] as const).map((key) => (
                <Radio key={key} value={key} label={AUDIENCE_LABEL[key]} />
              ))}
            </Stack>
          </Radio.Group>
          <Text size="xs" c="dimmed">
            Off-season, no member has yet &quot;settled&quot; for the coming cycle — presets (a) and (b) count
            every current member until the renewal window opens.
          </Text>

          <Group>
            <Button disabled={!deadlineSet} loading={starting === "opening"} onClick={() => startSend("opening")}>
              Send Opening-of-renewals campaign
            </Button>
            <Button disabled={!deadlineSet} loading={starting === "reminder"} onClick={() => startSend("reminder")}>
              Send Reminder campaign
            </Button>
          </Group>

          {lastCompleted && (
            <Text size="sm" c="dimmed">
              Last sent: {TEMPLATE_LABEL[lastCompleted.emailType as TemplateKey] ?? lastCompleted.emailType} (audience{" "}
              {lastCompleted.audience}) — {lastCompleted.counts.sent} sent, {lastCompleted.counts.failed} failed,{" "}
              {lastCompleted.counts.skipped_unsubscribed} skipped (unsubscribed), on{" "}
              {lastCompleted.completedAt ? new Date(lastCompleted.completedAt).toLocaleString() : ""}.
              {lastCompleted.counts.failed > 0 && (
                <>
                  {" "}
                  <Button size="compact-xs" variant="light" color="orange" onClick={() => retryFailed(lastCompleted.id)}>
                    Retry {lastCompleted.counts.failed} failed
                  </Button>
                </>
              )}
            </Text>
          )}
        </Stack>
      )}

      {sendError && <Alert color="red" variant="light" mt="md">{sendError}</Alert>}

      <Modal opened={confirmOpened} onClose={closeConfirm} title="Confirm send" centered>
        {confirm && (
          <Stack>
            <Text>
              This will send to <strong>{confirm.counts.queued}</strong> recipient(s).{" "}
              {confirm.counts.skippedUnsubscribed > 0 && <>{confirm.counts.skippedUnsubscribed} more are skipped (unsubscribed). </>}
              {confirm.counts.leadsWithoutEmail > 0 && <>{confirm.counts.leadsWithoutEmail} household lead(s) have no email on file and are not counted.</>}
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={closeConfirm}>Cancel</Button>
              <Button onClick={confirmSend}>Send now</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Card>
  );
}
