"use client";

import { useState } from "react";
import { Alert, Badge, Button, Card, Center, Checkbox, Loader, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { errorMessage, LoadError, showError, showSuccess } from "@checkin/component-ui";
import { useUnsavedGuard, shallowEqual } from "@/components/UnsavedChangesProvider";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useSeedForm } from "@/hooks/useSeedForm";
import { api, useLoad } from "@/lib/api";
import { SETTINGS_ADMIN_ROLES } from "@/lib/nav/sections/settings";
import { isValidEmailHeader, parseEmailHeaderList } from "@/lib/emailHeader";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { REGISTRY } from "@/lib/email-templates/registry";

const ACK_MEMBERSHIP = REGISTRY["scholarship.ackMembership"];
const ACK_PROGRAM = REGISTRY["scholarship.ackProgram"];

interface Settings {
  emailFromAddress: string | null;
  emailReplyToAddress: string | null;
  scholarshipNotifyEmail: string | null;
  financeAlertEmailAddress: string | null;
  boardEmailAddress: string | null;
  sysadminEmailAddress: string | null;
  bgReviewerEmailAddress: string | null;
  financeContactEmail: string | null;
  scholarshipAckSubject: string | null;
  scholarshipAckMembershipBody: string | null;
  scholarshipAckProgramBody: string | null;
}

const HEADER_ERROR = 'Enter an email address or "Name <addr@domain>".';
const ADDRESS_ERROR = "Enter one email address.";
const REPLY_TO_ERROR = 'Enter one or more comma-separated addresses, each an email address or "Name <addr@domain>".';

type FieldErrors = { from?: string; replyTo?: string; scholarshipNotify?: string; financeAlert?: string; boardAddress?: string; sysadminList?: string; bgReviewerList?: string; financeContact?: string };

const MUST_BE_SET = "Must be set.";

/** A label with a "Not set" pill while the saved value is empty. */
function labelWithPill(text: string, saved: string | undefined) {
  return (
    <>
      {text}
      {!saved && <Badge ml="xs" size="sm" color="red" variant="light">Not set</Badge>}
    </>
  );
}

export default function EmailSettingsPage() {
  // The sender identity is editable by board + sysadmin (same as the /settings layout
  // admits). Gate the page client-side and redirect anyone else, rather than letting them
  // load the form and only discover the 403 on save.
  const { authorized, ready, loading: authLoading } = useRequireRole(SETTINGS_ADMIN_ROLES);

  const [emailFrom, setEmailFrom] = useState("");
  const [emailReplyTo, setEmailReplyTo] = useState("");
  const [scholarshipNotify, setScholarshipNotify] = useState("");
  const [financeAlert, setFinanceAlert] = useState("");
  const [boardAddress, setBoardAddress] = useState("");
  const [sysadminList, setSysadminList] = useState("");
  const [bgReviewerList, setBgReviewerList] = useState("");
  const [financeContact, setFinanceContact] = useState("");
  const [ackSubject, setAckSubject] = useState("");
  const [ackMembershipBody, setAckMembershipBody] = useState("");
  const [ackProgramBody, setAckProgramBody] = useState("");
  // Once an identity exists, editing From/Reply-To is high-stakes (a wrong From on an
  // unverified domain bounces all mail; a wrong Reply-To misroutes replies) — lock those
  // two behind an explicit unlock, mirroring the membership-year boundary. First-time set is free.
  const [unlocked, setUnlocked] = useState(false);

  const [initial, setInitial] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const { data, error, reload } = useLoad<{ settings: Settings }>(ready ? "/api/settings/email" : null);

  const wasSet = !!(initial?.emailFrom || initial?.emailReplyTo);
  const locked = wasSet && !unlocked;

  const save = async () => {
    // Belt-and-suspenders: the page is role-gated and the route re-checks, but never fire
    // a mutation the user isn't allowed to make.
    if (!authorized) { showError("You do not have permission to change these settings."); return; }
    // Validate client-side with the same rule the route enforces (imported, not
    // duplicated) so a typo is caught inline instead of surfacing as a raw API error.
    const from = emailFrom.trim();
    const replyTo = emailReplyTo.trim();
    const notify = scholarshipNotify.trim();
    const finance = financeAlert.trim();
    const board = boardAddress.trim();
    const sysadmins = sysadminList.trim();
    const reviewers = bgReviewerList.trim();
    const contact = financeContact.trim();
    const fe: FieldErrors = {};
    if (!locked && from && !isValidEmailHeader(from)) fe.from = HEADER_ERROR;
    if (!locked && replyTo && !parseEmailHeaderList(replyTo)) fe.replyTo = REPLY_TO_ERROR;
    if (notify && !parseEmailHeaderList(notify)) fe.scholarshipNotify = REPLY_TO_ERROR;
    if (finance && !isValidEmail(finance)) fe.financeAlert = ADDRESS_ERROR;
    if (board && !isValidEmail(board)) fe.boardAddress = ADDRESS_ERROR;
    if (sysadmins && !isValidEmail(sysadmins)) fe.sysadminList = ADDRESS_ERROR;
    if (reviewers && !isValidEmail(reviewers)) fe.bgReviewerList = ADDRESS_ERROR;
    if (contact && !isValidEmail(contact)) fe.financeContact = ADDRESS_ERROR;
    if (Object.keys(fe).length > 0) { setFieldErrors(fe); return; }
    setFieldErrors({});
    setSaving(true);
    // A locked save leaves the sender alone: the route skips absent fields.
    const sender = locked ? {} : { emailFromAddress: from || null, emailReplyToAddress: replyTo || null };
    const saved = locked && initial ? { ...current, emailFrom: initial.emailFrom, emailReplyTo: initial.emailReplyTo } : current;
    try {
      await api("/api/settings/email", {
        method: "PUT",
        body: JSON.stringify({
          ...sender,
          scholarshipNotifyEmail: notify || null,
          financeAlertEmailAddress: finance || null,
          boardEmailAddress: board || null,
          sysadminEmailAddress: sysadmins || null,
          bgReviewerEmailAddress: reviewers || null,
          financeContactEmail: contact || null,
          scholarshipAckSubject: ackSubject.trim() || null,
          scholarshipAckMembershipBody: ackMembershipBody.trim() || null,
          scholarshipAckProgramBody: ackProgramBody.trim() || null,
        }),
      });
      showSuccess("Email settings saved.");
      setUnlocked(false);
      setEmailFrom(saved.emailFrom);
      setEmailReplyTo(saved.emailReplyTo);
      setInitial(saved);
    } catch (e) { showError(errorMessage(e)); }
    finally { setSaving(false); }
  };

  const current = { emailFrom, emailReplyTo, scholarshipNotify, financeAlert, boardAddress, sysadminList, bgReviewerList, financeContact, ackSubject, ackMembershipBody, ackProgramBody };
  const isDirty = !!initial && !shallowEqual(initial, current);
  useUnsavedGuard(isDirty);
  useSeedForm(data, isDirty, ({ settings }) => {
    const snap = {
      emailFrom: settings.emailFromAddress ?? "",
      emailReplyTo: settings.emailReplyToAddress ?? "",
      scholarshipNotify: settings.scholarshipNotifyEmail ?? "",
      financeAlert: settings.financeAlertEmailAddress ?? "",
      boardAddress: settings.boardEmailAddress ?? "",
      sysadminList: settings.sysadminEmailAddress ?? "",
      bgReviewerList: settings.bgReviewerEmailAddress ?? "",
      financeContact: settings.financeContactEmail ?? "",
      ackSubject: settings.scholarshipAckSubject ?? "",
      ackMembershipBody: settings.scholarshipAckMembershipBody ?? "",
      ackProgramBody: settings.scholarshipAckProgramBody ?? "",
    };
    setEmailFrom(snap.emailFrom);
    setEmailReplyTo(snap.emailReplyTo);
    setScholarshipNotify(snap.scholarshipNotify);
    setFinanceAlert(snap.financeAlert);
    setBoardAddress(snap.boardAddress);
    setSysadminList(snap.sysadminList);
    setBgReviewerList(snap.bgReviewerList);
    setFinanceContact(snap.financeContact);
    setAckSubject(snap.ackSubject);
    setAckMembershipBody(snap.ackMembershipBody);
    setAckProgramBody(snap.ackProgramBody);
    setInitial(snap);
  });

  if (authLoading) return <Center mih="60vh"><Loader /></Center>;
  if (!ready) return null; // redirect to / is in flight

  return (
    <Stack>
      {error && <LoadError what="the email settings" message={error} onRetry={reload} />}

      {!data ? (
        !error && <Center py="xl"><Loader /></Center>
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
              placeholder="Example Org <noreply@updates.example.com>"
              w={440}
              value={emailFrom}
              error={fieldErrors.from}
              onChange={(e) => { setEmailFrom(e.currentTarget.value); setFieldErrors((f) => ({ ...f, from: undefined })); }}
              disabled={locked}
            />
            <TextInput
              label="Reply-To address"
              description="Where replies go. Comma-separated for multiple addresses. Blank = replies go to the From address."
              placeholder="info@example.com, ops@example.com"
              w={440}
              value={emailReplyTo}
              error={fieldErrors.replyTo}
              onChange={(e) => { setEmailReplyTo(e.currentTarget.value); setFieldErrors((f) => ({ ...f, replyTo: undefined })); }}
              disabled={locked}
            />
          </Stack>

          <Title order={4} mt="xl" mb="xs">Recipients and message text</Title>
          <Stack gap="md">
            <TextInput
              label="Scholarship review notifications"
              description="Comma-separated for multiple addresses. Blank = the whole board is notified of new scholarship / payment-plan requests."
              placeholder="scholarships@example.com"
              w={440}
              value={scholarshipNotify}
              error={fieldErrors.scholarshipNotify}
              onChange={(e) => { setScholarshipNotify(e.currentTarget.value); setFieldErrors((f) => ({ ...f, scholarshipNotify: undefined })); }}
            />
            <TextInput
              label={labelWithPill("Finance alert address", initial?.financeAlert)}
              description={`Finance's group address, for finance and QuickBooks alerts. ${MUST_BE_SET}`}
              placeholder="finance-alerts@example.com"
              w={440}
              value={financeAlert}
              error={fieldErrors.financeAlert}
              onChange={(e) => { setFinanceAlert(e.currentTarget.value); setFieldErrors((f) => ({ ...f, financeAlert: undefined })); }}
            />
            <TextInput
              label={labelWithPill("Board address", initial?.boardAddress)}
              description={`The Board's group address. ${MUST_BE_SET}`}
              placeholder="board@example.com"
              w={440}
              value={boardAddress}
              error={fieldErrors.boardAddress}
              onChange={(e) => { setBoardAddress(e.currentTarget.value); setFieldErrors((f) => ({ ...f, boardAddress: undefined })); }}
            />
            <TextInput
              label={labelWithPill("Sysadmin list", initial?.sysadminList)}
              description={`The sysadmins' group address. ${MUST_BE_SET}`}
              placeholder="sysadmins@example.com"
              w={440}
              value={sysadminList}
              error={fieldErrors.sysadminList}
              onChange={(e) => { setSysadminList(e.currentTarget.value); setFieldErrors((f) => ({ ...f, sysadminList: undefined })); }}
            />
            <TextInput
              label={labelWithPill("Background-check reviewer list", initial?.bgReviewerList)}
              description={`The background-check reviewers' group address. ${MUST_BE_SET}`}
              placeholder="bg-reviewers@example.com"
              w={440}
              value={bgReviewerList}
              error={fieldErrors.bgReviewerList}
              onChange={(e) => { setBgReviewerList(e.currentTarget.value); setFieldErrors((f) => ({ ...f, bgReviewerList: undefined })); }}
            />
            <TextInput
              label={labelWithPill("Finance contact address", initial?.financeContact)}
              description={`The address members see for finance questions. ${MUST_BE_SET}`}
              placeholder="finance@example.com"
              w={440}
              value={financeContact}
              error={fieldErrors.financeContact}
              onChange={(e) => { setFinanceContact(e.currentTarget.value); setFieldErrors((f) => ({ ...f, financeContact: undefined })); }}
            />
            <TextInput
              label="Scholarship ACK subject"
              description={'Subject line for the applicant\'s request-received email. Blank = default shown below.'}
              placeholder={ACK_MEMBERSHIP.defaultSubject}
              w={440}
              value={ackSubject}
              onChange={(e) => setAckSubject(e.currentTarget.value)}
            />
            <Textarea
              label="Scholarship ACK body — membership fee request"
              description="Plain text (blank lines separate paragraphs) — not HTML. Blank = default shown below."
              placeholder={ACK_MEMBERSHIP.defaultBody}
              minRows={3}
              autosize
              value={ackMembershipBody}
              onChange={(e) => setAckMembershipBody(e.currentTarget.value)}
            />
            <Textarea
              label="Scholarship ACK body — program request"
              description={'Plain text (blank lines separate paragraphs) — not HTML. "{{programName}}" is replaced with the program\'s name. Blank = default shown below.'}
              placeholder={ACK_PROGRAM.defaultBody}
              minRows={3}
              autosize
              value={ackProgramBody}
              onChange={(e) => setAckProgramBody(e.currentTarget.value)}
            />
          </Stack>

          <Button mt="lg" disabled={saving} loading={saving} onClick={save} style={{ alignSelf: "flex-start" }}>
            Save settings
          </Button>
        </Card>
      )}
    </Stack>
  );
}
