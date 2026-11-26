"use client";

import { useState, useEffect } from "react";
import { Box, Button, Card, Group, Paper, Text, TextInput } from "@mantine/core";
import { searchId } from "@/lib/searchId";
import { useLoad } from "@/lib/api";
import { clearError, showError } from "@checkin/component-ui";
import type { ParticipantMergeView } from "./mergeView";

// Two characters are too little to search on — except for an id, which is a whole
// query at one digit.
function isSearchable(query: string) {
  return query.trim().length > 2 || searchId(query) !== null;
}

// Results for a picker that is still searching. They clear once a person is picked
// or the query gets too short, and otherwise stay up until the current query's answer lands.
// A failed search raises a chip that stays until dismissed or a later search answers.
export function usePeopleSearch(label: string, query: string, picked: boolean) {
  const active = !picked && isSearchable(query);
  const { data, error, loading, reload } = useLoad<{ people?: ParticipantMergeView[] }>(
    active ? `/api/people/search?q=${encodeURIComponent(query)}` : null,
    { keepPrevious: true, retry: false },
  );
  const key = `merge-search-${label}`;
  const answered = !!data && !error && !loading;
  // Bumped once a retry answers, so a retry that fails again raises the chip again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (error) showError(error, { key, title: `Couldn't search for ${label}` });
    else if (answered) clearError(key);
  }, [error, answered, key, label, attempt]);
  const retry = () => reload().then(() => setAttempt((n) => n + 1));
  return { results: error ? [] : data?.people ?? [], failed: !!error, retry };
}

export function PersonPicker({ label, value, setValue, search, selected, setSelected }: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  search: ReturnType<typeof usePeopleSearch>;
  selected: ParticipantMergeView | null;
  setSelected: (p: ParticipantMergeView | null) => void;
}) {
  return (
    <Box style={{ flex: 1, position: "relative" }}>
      {selected ? (
        <Card withBorder radius="md" padding="md" bg="var(--mantine-color-blue-light)">
          <Group justify="space-between">
            <div>
              <Text fw={600}>{selected.name || "Unnamed"}</Text>
              <Text size="sm" c="dimmed">{selected.email || "No email"} | ID: {selected.id}</Text>
            </div>
            <Button size="xs" fz={15} variant="default" onClick={() => setSelected(null)}>Change</Button>
          </Group>
        </Card>
      ) : (
        <>
          <TextInput
            label={label}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            placeholder="Search by name, email, or ID..."
          />
          {search.failed && (
            <Button size="xs" variant="light" color="red" mt="xs" onClick={search.retry}>Retry search</Button>
          )}
          {search.results.length > 0 && (
            <Paper withBorder shadow="md" radius="sm" pos="absolute" left={0} right={0} style={{ zIndex: 10, maxHeight: 320, overflowY: "auto" }}>
              {search.results.map((r) => (
                <Box key={r.id} p="sm" style={{ cursor: "pointer", borderBottom: "1px solid var(--mantine-color-default-border)" }} onClick={() => setSelected(r)}>
                  <Text>{r.name || "Unnamed"} <Text component="span" size="xs" c="dimmed">(ID: {r.id})</Text></Text>
                  <Text size="xs" c="dimmed">{r.email}</Text>
                </Box>
              ))}
            </Paper>
          )}
        </>
      )}
    </Box>
  );
}
