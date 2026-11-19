"use client";

import { useState } from "react";
import {
  Alert, Button, Card, Center, Group, Loader, Modal, Progress, Stack, Text, Textarea, TextInput, Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { errorMessage, HttpError, invalidateLoads, LoadError, showError, showSuccess } from "@checkin/component-ui";
import { api, useLoad } from "@/lib/api";
import { useFreshRead } from "@/hooks/useFreshRead";
import { useRequireRole } from "@/hooks/useRequireRole";
import { SETTINGS_ADMIN_ROLES, SETTINGS_ROLES } from "@/lib/nav/sections/settings";
import { hasAnyRole } from "@/lib/nav/gates";
import { useUnsavedGuard, shallowEqual } from "@/components/UnsavedChangesProvider";
import { REGISTRY } from "@/lib/email-templates/registry";
import { renderTemplate, withDefaults } from "@/lib/email-templates/tokens";

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
  skipped_denied: number;
  skipped_not_member: number;
  skipped_not_audience: number;
  sending: number;
  total: number;
}

interface BulkSendSummary {
  id: number;
  emailType: string;
  startedAt: string;
  completedAt: string | null;
  counts: Counts;
}

const SAMPLE_NAME = "Jordan Rivera";
const STATUS_PATH = "/api/outreach/status";
const TEMPLATE_LABEL: Record<TemplateKey, string> = { opening: "Opening of renewals", reminder: "Reminder" };
const AUDIENCE_LABEL: Record<TemplateKey, string> = {
  opening: "every member household's leads",
  reminder: "leads of member households that have not completed renewal",
};

export default function OutreachSettingsPage() {
  const { ready, loading: authLoading, user } = useRequireRole(SETTINGS_ROLES);
  const canEdit = hasAnyRole(user, SETTINGS_ADMIN_ROLES);

  const [opening, setOpening] = useState({ subject: "", body: "" });
  const [reminder, setReminder] = useState({ subject: "", body: "" });
  const [initial, setInitial] = useState<{ opening: { subject: string; body: string }; reminder: { subject: string; body: string } } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testSending, setTestSending] = useState<TemplateKey | null>(null);

  const templatesPath = ready ? "/api/settings/outreach" : null;
  const { data, error: loadError, reload } = useLoad<{ settings: Settings; nextDeadline: string | null }>(templatesPath);
  const { fresh, retry } = useFreshRead(templatesPath, reload);
  const nextDeadline = data?.nextDeadline ?? null;
  // Each fresh read of the settings resets the form to it.
  const [formFor, setFormFor] = useState<typeof data>(null);
  if (data && data !== formFor) {
    setFormFor(data);
    const snap = {
      opening: { subject: data.settings.outreachOpeningSubject ?? "", body: data.settings.outreachOpeningBody ?? "" },
      reminder: { subject: data.settings.outreachReminderSubject ?? "", body: data.settings.outreachReminderBody ?? "" },
    };
    setOpening(snap.opening);
    setReminder(snap.reminder);
    setInitial(snap);
  }

  const isDirty = !!initial && !shallowEqual(
    { os: initial.opening.subject, ob: initial.opening.body, rs: initial.reminder.subject, rb: initial.reminder.body },
    { os: opening.subject, ob: opening.body, rs: reminder.subject, rb: reminder.body },
  );
  useUnsavedGuard(isDirty);

  const saveSettings = async () => {
    setSaving(true);
    try {
      await api("/api/settings/outreach", {
        method: "PUT",
        body: JSON.stringify({
          outreachOpeningSubject: opening.subject,
          outreachOpeningBody: opening.body,
          outreachReminderSubject: reminder.subject,
          outreachReminderBody: reminder.body,
        }),
      });
      showSuccess("Outreach templates saved.");
      await reload();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async (key: TemplateKey) => {
    const t = key === "opening" ? opening : reminder;
    setTestSending(key);
    try {
      await api("/api/outreach/test-send", { method: "POST", body: JSON.stringify({ emailType: key, subject: t.subject, body: t.body }) });
      showSuccess("Test email sent to your address.");
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setTestSending(null);
    }
  };

  if (authLoading) return <Center mih="60vh"><Loader /></Center>;
  if (!ready) return null; // redirect to / is in flight

  return (
    <Stack>
      {loadError ? (
        <LoadError what="the outreach templates" message={loadError} onRetry={retry} />
      ) : data === null || !fresh ? (
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
            emailType="opening"
            value={opening}
            onChange={setOpening}
            deadline={nextDeadline}
            testSending={testSending === "opening"}
            canEdit={canEdit}
            onSendTest={() => sendTest("opening")}
          />
          <TemplateCard
            emailType="reminder"
            value={reminder}
            onChange={setReminder}
            deadline={nextDeadline}
            testSending={testSending === "reminder"}
            canEdit={canEdit}
            onSendTest={() => sendTest("reminder")}
          />

          <Group>
            <Button disabled={saving || !canEdit} loading={saving} onClick={saveSettings}>Save templates</Button>
            {!canEdit && <Text size="sm" c="dimmed">Only the Board and sysadmins change the wording.</Text>}
          </Group>

          <SendPanel deadlineSet={nextDeadline !== null} />
        </>
      )}
    </Stack>
  );
}

function TemplateCard({
  emailType, value, onChange, deadline, testSending, onSendTest, canEdit,
}: {
  canEdit: boolean;
  emailType: TemplateKey;
  value: { subject: string; body: string };
  onChange: (v: { subject: string; body: string }) => void;
  deadline: string | null;
  testSending: boolean;
  onSendTest: () => void;
}) {
  const title = TEMPLATE_LABEL[emailType];
  const spec = REGISTRY[`outreach.${emailType}`];
  const sent = withDefaults(spec, value);
  const tokens = { name: SAMPLE_NAME, deadline: deadline ?? "(boundary not set)", actionLink: "/membership" };
  const preview = renderTemplate(sent.subject, sent.body, tokens, spec.allowedTokens);

  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={3} mb="xs">{title}</Title>
      <Text c="dimmed" size="sm" mb="md">
        Tokens: <code>{"{{name}}"}</code> <code>{"{{deadline}}"}</code> <code>{"{{actionLink}}"}</code>.
        {" "}The action link points at <code>/membership</code>. A blank line starts a new paragraph; a blank field sends the default wording.
      </Text>

      <Stack gap="sm">
        <TextInput
          label="Subject"
          placeholder={spec.defaultSubject}
          value={value.subject}
          disabled={!canEdit}
          onChange={(e) => onChange({ ...value, subject: e.currentTarget.value })}
        />
        <Textarea
          label="Body"
          placeholder={spec.defaultBody}
          minRows={6}
          autosize
          value={value.body}
          disabled={!canEdit}
          onChange={(e) => onChange({ ...value, body: e.currentTarget.value })}
        />
      </Stack>

      <Card mt="md" withBorder padding="sm" radius="sm">
        <Text fw={600} size="sm" mb={4}>{preview.subject}</Text>
        {/* The body is escaped by renderTemplate; the scriptless sandbox keeps the preview inert regardless. */}
        <iframe
          title={`${title}: preview`}
          sandbox=""
          srcDoc={preview.html}
          style={{ border: 0, width: "100%", height: 280 }}
        />
      </Card>

      <Button mt="md" variant="light" disabled={!canEdit} loading={testSending} onClick={onSendTest}>
        Send test to me
      </Button>
    </Card>
  );
}

function SendPanel({ deadlineSet }: { deadlineSet: boolean }) {
  const { data: status, error: statusError, reload: refreshStatus } = useLoad<{ inFlight: BulkSendSummary | null; lastCompleted: BulkSendSummary | null }>(STATUS_PATH);
  const { fresh: statusFresh, retry: retryStatus } = useFreshRead(STATUS_PATH, refreshStatus);
  const inFlight = status?.inFlight ?? null;
  const lastCompleted = status?.lastCompleted ?? null;
  const [draining, setDraining] = useState(false);
  const [confirm, setConfirm] = useState<{ emailType: TemplateKey; bulkSendId: number; counts: { queued: number; leadsWithoutEmail: number } } | null>(null);
  const [confirmOpened, { open: openConfirm, close: closeConfirm }] = useDisclosure(false);
  const [starting, setStarting] = useState<TemplateKey | null>(null);

  const drain = async (bulkSendId: number) => {
    setDraining(true);
    try {
      for (;;) {
        const data = await api<{ remaining: number; processed: number }>("/api/outreach/process-batch", {
          method: "POST",
          body: JSON.stringify({ bulkSendId }),
          invalidate: false,
        });
        await refreshStatus();
        if (data.remaining === 0 || data.processed === 0) break;
      }
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      invalidateLoads();
      setDraining(false);
    }
  };

  const startSend = async (emailType: TemplateKey) => {
    setStarting(emailType);
    try {
      const data = await api<{
        bulkSend: { id: number };
        counts: { queued: number; leadsWithoutEmail: number };
      }>("/api/outreach/send", { method: "POST", body: JSON.stringify({ emailType }) });
      setConfirm({
        emailType,
        bulkSendId: data.bulkSend.id,
        counts: { queued: data.counts.queued, leadsWithoutEmail: data.counts.leadsWithoutEmail },
      });
      openConfirm();
    } catch (e) {
      showError(errorMessage(e));
      if (e instanceof HttpError && e.status === 409) await refreshStatus();
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
    try {
      await api("/api/outreach/status", { method: "POST", body: JSON.stringify({ action: "retry", bulkSendId }) });
    } catch (e) {
      showError(errorMessage(e));
      return;
    }
    await refreshStatus();
    await drain(bulkSendId);
  };

  const done = (c: Counts) => c.sent + c.failed + c.skipped_denied + c.skipped_not_member + c.skipped_not_audience;
  const progress = (c: Counts) => (c.total === 0 ? 100 : Math.round((done(c) / c.total) * 100));

  return (
    <Card withBorder radius="md" padding="lg" style={{ borderColor: "var(--mantine-color-yellow-5)" }}>
      <Title order={3} mb="xs">Send a campaign</Title>
      <Text c="dimmed" size="sm" mb="md">
        The opening goes to {AUDIENCE_LABEL.opening}; the reminder goes to {AUDIENCE_LABEL.reminder}.
        Sending is manual — nothing here runs on a schedule.
      </Text>

      {statusError ? (
        <LoadError what="the send status" message={`${statusError} No new send can start until it loads.`} onRetry={retryStatus} />
      ) : status === null || !statusFresh ? (
        <Center py="md"><Loader size="sm" /></Center>
      ) : inFlight ? (
        <Stack>
          <Alert color="blue" variant="light">
            A {TEMPLATE_LABEL[inFlight.emailType as TemplateKey] ?? inFlight.emailType} send is in progress — {done(inFlight.counts)} of{" "}
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
              Last sent: {TEMPLATE_LABEL[lastCompleted.emailType as TemplateKey] ?? lastCompleted.emailType}{" "}
              — {lastCompleted.counts.sent} sent, {lastCompleted.counts.failed} failed,{" "}
              {lastCompleted.counts.skipped_denied > 0 && `${lastCompleted.counts.skipped_denied} skipped (denied), `}
              {lastCompleted.counts.skipped_not_member > 0 && `${lastCompleted.counts.skipped_not_member} skipped (no longer a member), `}
              {lastCompleted.counts.skipped_not_audience > 0 && `${lastCompleted.counts.skipped_not_audience} skipped (won't renew, already renewed, or no longer the lead), `}on{" "}
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


      <Modal opened={confirmOpened} onClose={closeConfirm} title="Confirm send" centered>
        {confirm && (
          <Stack>
            <Text>
              This will send to <strong>{confirm.counts.queued}</strong> recipient(s).{" "}
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
