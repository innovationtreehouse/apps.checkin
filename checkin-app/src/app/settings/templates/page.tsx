"use client";

import { useState } from "react";
import { Badge, Button, Card, Center, Code, Group, Loader, Select, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { errorMessage, LoadError, showError, showSuccess } from "@checkin/component-ui";
import { useConfirmNav, useUnsavedGuard } from "@/components/UnsavedChangesProvider";
import { useRequireRole } from "@/hooks/useRequireRole";
import { api, useLoad } from "@/lib/api";
import { SETTINGS_ADMIN_ROLES } from "@/lib/nav/sections/settings";
import { REGISTRY, type TemplateKey } from "@/lib/email-templates/registry";
import { findUnknownTokens, renderTemplate, withDefaults } from "@/lib/email-templates/tokens";

interface SavedTemplate {
  key: string;
  subject: string;
  body: string;
}

interface Copy {
  subject: string;
  body: string;
}

const KEYS = Object.keys(REGISTRY) as TemplateKey[];

/** Every key, grouped under the part of its name before the first dot. */
const GROUPS = Object.entries(
  KEYS.reduce<Record<string, TemplateKey[]>>((groups, key) => {
    const prefix = key.split(".")[0];
    (groups[prefix] ??= []).push(key);
    return groups;
  }, {}),
);

function unknownTokenError(text: string, key: TemplateKey): string | undefined {
  const unknown = findUnknownTokens(text, REGISTRY[key].allowedTokens);
  return unknown.length ? `This email has no {{${unknown[0]}}}.` : undefined;
}

export default function EmailTemplatesPage() {
  const { ready, loading: authLoading } = useRequireRole(SETTINGS_ADMIN_ROLES);
  const { data, error, reload } = useLoad<{ templates: SavedTemplate[] }>(ready ? "/api/settings/templates" : null);
  const confirmNav = useConfirmNav();

  const [key, setKey] = useState<TemplateKey | null>(null);
  const [draft, setDraft] = useState<Copy>({ subject: "", body: "" });
  const [busy, setBusy] = useState<"save" | "reset" | "test" | null>(null);

  const saved = new Map((data?.templates ?? []).map((row) => [row.key, row]));
  const initial = key ? withDefaults(REGISTRY[key], saved.get(key)) : null;
  const isDirty = !!initial && (draft.subject !== initial.subject || draft.body !== initial.body);
  useUnsavedGuard(isDirty);

  const choose = (next: string | null) => {
    if (!next || next === key || (isDirty && !confirmNav())) return;
    const nextKey = next as TemplateKey;
    setKey(nextKey);
    setDraft(withDefaults(REGISTRY[nextKey], saved.get(nextKey)));
  };

  const put = async (copy: Copy, action: "save" | "reset") => {
    if (!key) return;
    setBusy(action);
    try {
      await api(`/api/settings/templates/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify(copy) });
      if (action === "reset") setDraft(withDefaults(REGISTRY[key], null));
      showSuccess(action === "reset" ? "This email now sends its default wording." : "Template saved.");
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    if (!key) return;
    setBusy("test");
    try {
      await api(`/api/settings/templates/${encodeURIComponent(key)}/test-send`, { method: "POST", body: JSON.stringify(draft), invalidate: false });
      showSuccess("Test email sent to your address.");
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (authLoading) return <Center mih="60vh"><Loader /></Center>;
  if (!ready) return null;

  const options = GROUPS.map(([group, keys]) => ({
    group,
    items: keys.map((k) => ({ value: k, label: saved.has(k) ? `${k} (edited)` : k })),
  }));

  return (
    <Stack>
      {error && <LoadError what="the email templates" message={error} onRetry={reload} />}
      {!data ? (
        !error && <Center py="xl"><Loader /></Center>
      ) : (
        <>
          <Text c="dimmed" size="sm">
            Pick an email to change its wording. A blank line starts a new paragraph. An email you have not
            changed sends its default wording.
          </Text>
          <Select label="Email" placeholder="Choose an email" data={options} value={key} onChange={choose} searchable />
          {key && initial && (
            <TemplateEditor
              templateKey={key}
              draft={draft}
              onChange={setDraft}
              edited={saved.has(key)}
              busy={busy}
              onSave={() => put(draft, "save")}
              onReset={() => put({ subject: "", body: "" }, "reset")}
              onSendTest={sendTest}
            />
          )}
        </>
      )}
    </Stack>
  );
}

function TemplateEditor({
  templateKey, draft, onChange, edited, busy, onSave, onReset, onSendTest,
}: {
  templateKey: TemplateKey;
  draft: Copy;
  onChange: (copy: Copy) => void;
  edited: boolean;
  busy: "save" | "reset" | "test" | null;
  onSave: () => void;
  onReset: () => void;
  onSendTest: () => void;
}) {
  const spec = REGISTRY[templateKey];
  const subjectError = unknownTokenError(draft.subject, templateKey);
  const bodyError = unknownTokenError(draft.body, templateKey);
  const invalid = !!(subjectError || bodyError);
  const sent = withDefaults(spec, draft);
  const preview = renderTemplate(sent.subject, sent.body, spec.sampleCtx, spec.allowedTokens);
  const tokens = Object.entries(spec.allowedTokens);

  return (
    <Card withBorder radius="md" padding="lg">
      <Group mb="xs">
        <Title order={3}>{templateKey}</Title>
        {edited && <Badge variant="light">Edited</Badge>}
      </Group>
      <Text c="dimmed" size="sm" mb="md">
        {tokens.length === 0 ? "This email has no tokens." : (
          <>
            Tokens:{" "}
            {tokens.map(([name, token]) => (
              <span key={name}>
                <Code>{`{{${name}}}`}</Code>{token.kind === "link" ? ` (link${token.label ? `: "${token.label}"` : ""})` : ""}{" "}
              </span>
            ))}
          </>
        )}
      </Text>

      <Stack gap="sm">
        <TextInput
          label="Subject"
          value={draft.subject}
          error={subjectError}
          onChange={(e) => onChange({ ...draft, subject: e.currentTarget.value })}
        />
        <Textarea
          label="Body"
          minRows={6}
          autosize
          value={draft.body}
          error={bodyError}
          onChange={(e) => onChange({ ...draft, body: e.currentTarget.value })}
        />
      </Stack>

      <Card mt="md" withBorder padding="sm" radius="sm">
        <Text size="xs" c="dimmed" mb={4}>Preview, with sample values</Text>
        <Text fw={600} size="sm" mb={4}>{preview.subject}</Text>
        {/* The body is escaped by renderTemplate; the scriptless sandbox keeps the preview inert regardless. */}
        <iframe
          title={`${templateKey}: preview`}
          sandbox=""
          srcDoc={preview.html}
          style={{ border: 0, width: "100%", height: 280 }}
        />
      </Card>

      <Group mt="md">
        <Button disabled={invalid || busy !== null} loading={busy === "save"} onClick={onSave}>Save template</Button>
        <Button variant="light" disabled={invalid || busy !== null} loading={busy === "test"} onClick={onSendTest}>Send test to me</Button>
        {edited && (
          <Button variant="subtle" color="gray" disabled={busy !== null} loading={busy === "reset"} onClick={onReset}>
            Use the default wording
          </Button>
        )}
      </Group>
    </Card>
  );
}
