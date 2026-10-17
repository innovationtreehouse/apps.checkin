"use client";

import { useState, useEffect, useCallback } from "react";
import { Alert, Button, Card, Center, Checkbox, Loader, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { useUnsavedGuard, shallowEqual } from "@/components/UnsavedChangesProvider";
import { useRequireRole } from "@/hooks/useRequireRole";
import { isValidEmailHeader, parseEmailHeaderList } from "@/lib/emailHeader";
import { DEFAULT_ACK_SUBJECT, DEFAULT_ACK_MEMBERSHIP_BODY, DEFAULT_ACK_PROGRAM_BODY } from "@/lib/scholarshipAckCopy";

interface Settings {
  emailFromAddress: string | null;
  emailReplyToAddress: string | null;
  scholarshipNotifyEmail: string | null;
  scholarshipAckSubject: string | null;
  scholarshipAckMembershipBody: string | null;
  scholarshipAckProgramBody: string | null;
}

const HEADER_ERROR = 'Enter an email address or "Name <addr@domain>".';
const REPLY_TO_ERROR = 'Enter one or more comma-separated addresses, each an email address or "Name <addr@domain>".';

export default function EmailSettingsPage() {
  // The sender identity is editable by board + sysadmin (same as the /settings layout
  // admits). Gate the page client-side and redirect anyone else, rather than letting them
  // load the form and only discover the 403 on save.
  const { authorized, ready, loading: authLoading } = useRequireRole(["isSysadmin", "isBoardMember"]);

  const [emailFrom, setEmailFrom] = useState("");
  const [emailReplyTo, setEmailReplyTo] = useState("");
  const [scholarshipNotify, setScholarshipNotify] = useState("");
  const [ackSubject, setAckSubject] = useState("");
  const [ackMembershipBody, setAckMembershipBody] = useState("");
  const [ackProgramBody, setAckProgramBody] = useState("");
  // Once an identity exists, editing is high-stakes (a wrong From on an unverified
  // domain bounces all mail; a wrong Reply-To misroutes replies) — lock behind an
  // explicit unlock, mirroring the membership-year boundary. First-time set is free.
  const [unlocked, setUnlocked] = useState(false);

  const [initial, setInitial] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<{ text: string; err: boolean } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ from?: string; replyTo?: string; scholarshipNotify?: string }>({});

  const load = useCallback(() => fetch("/api/settings/email")
    .then(async (res) => {
      if (res.ok) {
        const { settings } = (await res.json()) as { settings: Settings };
        const snap = {
          emailFrom: settings.emailFromAddress ?? "",
          emailReplyTo: settings.emailReplyToAddress ?? "",
          scholarshipNotify: settings.scholarshipNotifyEmail ?? "",
          ackSubject: settings.scholarshipAckSubject ?? "",
          ackMembershipBody: settings.scholarshipAckMembershipBody ?? "",
          ackProgramBody: settings.scholarshipAckProgramBody ?? "",
        };
        setEmailFrom(snap.emailFrom);
        setEmailReplyTo(snap.emailReplyTo);
        setScholarshipNotify(snap.scholarshipNotify);
        setAckSubject(snap.ackSubject);
        setAckMembershipBody(snap.ackMembershipBody);
        setAckProgramBody(snap.ackProgramBody);
        setInitial(snap);
      }
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  const wasSet = !!(initial?.emailFrom || initial?.emailReplyTo);
  const locked = wasSet && !unlocked;

  const save = async () => {
    setSaveNotice(null);
    // Belt-and-suspenders: the page is role-gated and the route re-checks, but never fire
    // a mutation the user isn't allowed to make.
    if (!authorized) { setSaveNotice({ text: "You do not have permission to change these settings.", err: true }); return; }
    // Validate client-side with the same rule the route enforces (imported, not
    // duplicated) so a typo is caught inline instead of surfacing as a raw API error.
    const from = emailFrom.trim();
    const replyTo = emailReplyTo.trim();
    const notify = scholarshipNotify.trim();
    const fe: { from?: string; replyTo?: string; scholarshipNotify?: string } = {};
    if (from && !isValidEmailHeader(from)) fe.from = HEADER_ERROR;
    if (replyTo && !parseEmailHeaderList(replyTo)) fe.replyTo = REPLY_TO_ERROR;
    if (notify && !parseEmailHeaderList(notify)) fe.scholarshipNotify = REPLY_TO_ERROR;
    if (fe.from || fe.replyTo || fe.scholarshipNotify) { setFieldErrors(fe); return; }
    setFieldErrors({});
    setSaving(true);
    try {
      const res = await fetch("/api/settings/email", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailFromAddress: emailFrom.trim() || null,
          emailReplyToAddress: emailReplyTo.trim() || null,
          scholarshipNotifyEmail: notify || null,
          scholarshipAckSubject: ackSubject.trim() || null,
          scholarshipAckMembershipBody: ackMembershipBody.trim() || null,
          scholarshipAckProgramBody: ackProgramBody.trim() || null,
        }),
      });
      if (res.ok) { notifications.show({ message: "Email settings saved." }); setUnlocked(false); setLoading(true); await load(); }
      else { const d = await res.json().catch(() => ({})); setSaveNotice({ text: d.error || "Save failed.", err: true }); }
    } catch { notifications.show({ color: "red", message: "Network error.", autoClose: false }); }
    finally { setSaving(false); }
  };

  const isDirty = !!initial && !shallowEqual(initial, {
    emailFrom, emailReplyTo, scholarshipNotify, ackSubject, ackMembershipBody, ackProgramBody,
  });
  useUnsavedGuard(isDirty);

  if (authLoading) return <Center mih="60vh"><Loader /></Center>;
  if (!ready) return null; // redirect to / is in flight

  return (
    <Stack>
      <SettingsTabs active="email" />

      {loading ? (
        <Center py="xl"><Loader /></Center>
      ) : (
        <Card withBorder radius="md" padding="lg">
          <Title order={3} mb="xs">Email sender identity</Title>
          <Text size="sm" c="dimmed" mb="md">
            Controls the sender on <strong>every</strong> outbound email (check-in receipts, membership
            notices, board alerts). Leave blank to use the sender configured in the environment —
            with neither set, outbound email is disabled.
          </Text>

          <Alert color={wasSet ? "yellow" : "blue"} variant="light" mb="md">
            {wasSet ? (
              <Text size="sm">
                ⚠️ The <strong>From</strong> address must be on a domain verified in Resend or all mail
                bounces. Changing these affects every outbound email — only edit if you are sure.
              </Text>
            ) : (
              <Text size="sm">
                The <strong>From</strong> address must be on a domain verified in Resend.{" "}
                <strong>Reply-To</strong> can be one or more addresses, comma-separated (e.g. real board
                inboxes) so replies to a no-reply sender reach someone.
              </Text>
            )}
          </Alert>

          {wasSet && (
            <Checkbox
              mb="md"
              checked={unlocked}
              onChange={(e) => setUnlocked(e.currentTarget.checked)}
              label="I understand — let me edit the sender addresses"
            />
          )}

          <Stack gap="md">
            <TextInput
              label="From address"
              description={'Bare address or "Name <addr@domain>". Blank = the environment sender.'}
              placeholder="Innovation Treehouse <noreply@updates.innovationtreehouse.org>"
              w={440}
              value={emailFrom}
              error={fieldErrors.from}
              onChange={(e) => { setEmailFrom(e.currentTarget.value); setFieldErrors((f) => ({ ...f, from: undefined })); }}
              disabled={locked}
            />
            <TextInput
              label="Reply-To address"
              description="Where replies go. Comma-separated for multiple addresses. Blank = replies go to the From address."
              placeholder="info@innovationtreehouse.org, ops@innovationtreehouse.org"
              w={440}
              value={emailReplyTo}
              error={fieldErrors.replyTo}
              onChange={(e) => { setEmailReplyTo(e.currentTarget.value); setFieldErrors((f) => ({ ...f, replyTo: undefined })); }}
              disabled={locked}
            />
            <TextInput
              label="Scholarship review notifications"
              description="Comma-separated for multiple addresses. Blank = the whole board is notified of new scholarship / payment-plan requests."
              placeholder="finance@innovationtreehouse.org"
              w={440}
              value={scholarshipNotify}
              error={fieldErrors.scholarshipNotify}
              onChange={(e) => { setScholarshipNotify(e.currentTarget.value); setFieldErrors((f) => ({ ...f, scholarshipNotify: undefined })); }}
              disabled={locked}
            />
            <TextInput
              label="Scholarship ACK subject"
              description={'Subject line for the applicant\'s request-received email. "{{programName}}" is replaced with the program\'s name. Blank = default shown below.'}
              placeholder={DEFAULT_ACK_SUBJECT}
              w={440}
              value={ackSubject}
              onChange={(e) => setAckSubject(e.currentTarget.value)}
              disabled={locked}
            />
            <Textarea
              label="Scholarship ACK body — membership fee request"
              description="Plain text (blank lines separate paragraphs) — not HTML. Blank = default shown below."
              placeholder={DEFAULT_ACK_MEMBERSHIP_BODY}
              minRows={3}
              autosize
              value={ackMembershipBody}
              onChange={(e) => setAckMembershipBody(e.currentTarget.value)}
              disabled={locked}
            />
            <Textarea
              label="Scholarship ACK body — program request"
              description={'Plain text (blank lines separate paragraphs) — not HTML. "{{programName}}" is replaced with the program\'s name. Blank = default shown below.'}
              placeholder={DEFAULT_ACK_PROGRAM_BODY}
              minRows={3}
              autosize
              value={ackProgramBody}
              onChange={(e) => setAckProgramBody(e.currentTarget.value)}
              disabled={locked}
            />
          </Stack>

          {saveNotice && (
            <Alert mt="lg" color={saveNotice.err ? "red" : "treehouseGreen"} variant="light">
              {saveNotice.text}
            </Alert>
          )}

          <Button mt="lg" disabled={saving || locked} loading={saving} onClick={save} style={{ alignSelf: "flex-start" }}>
            Save settings
          </Button>
        </Card>
      )}
    </Stack>
  );
}
