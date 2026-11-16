"use client";

import { useState } from "react";
import { Button, Card, Flex, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { errorMessage, LoadError, showError, showSuccess } from "@checkin/component-ui";
import { api, useLoad } from "@/lib/api";

type ToolListItem = {
  id: number;
  name: string;
  safetyGuide: string | null;
  _count?: { toolStatuses: number };
};

export default function CreateToolPage() {
  const [newToolName, setNewToolName] = useState("");
  const [newToolGuide, setNewToolGuide] = useState("");
  const [saving, setSaving] = useState(false);
  const { data: tools, error, reload } = useLoad<ToolListItem[]>("/api/shop/tools");

  const handleCreateTool = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/shop/tools", { method: "POST", body: JSON.stringify({ name: newToolName, safetyGuide: newToolGuide }) });
      showSuccess("New tool added successfully!");
      setNewToolName("");
      setNewToolGuide("");
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Flex gap="lg" align="flex-start" wrap="wrap">
      <Card withBorder radius="md" padding="lg" maw={520}>
        <Text c="dimmed" mb="lg">
          Define a new piece of shop equipment to begin tracking safety certifications,
          authorizing Certifiers, and tracking usage.
        </Text>

        <form onSubmit={handleCreateTool}>
          <Stack>
            <TextInput
              label="Equipment Name"
              required
              placeholder="e.g. Table Saw"
              value={newToolName}
              onChange={(e) => setNewToolName(e.currentTarget.value)}
            />
            <TextInput
              type="url"
              label="Safety Guide URL"
              placeholder="https://example.com/safety-manual"
              description="Optional link to the required reading or manufacturer manual."
              value={newToolGuide}
              onChange={(e) => setNewToolGuide(e.currentTarget.value)}
            />
            <Button type="submit" disabled={saving} loading={saving} mt="sm" style={{ alignSelf: "flex-start" }}>
              Create Tool
            </Button>
          </Stack>
        </form>
      </Card>

      <Card withBorder radius="md" padding="md" w={260}>
        <Text fw={700} size="sm" mb="xs">Existing tools</Text>
        {error && <LoadError what="the tools" message={error} onRetry={reload} />}
        <ScrollArea.Autosize mah={420} type="auto">
          <Stack gap={4}>
            {tools?.map((t) => (
              <Text key={t.id} size="sm">{t.name}</Text>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      </Card>
    </Flex>
  );
}
