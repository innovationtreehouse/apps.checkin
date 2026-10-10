"use client";

import { useEffect, useState } from "react";
import { Box, Button, Paper, Text, TextInput } from "@mantine/core";

export interface EntityPickerProps<T extends { id: number }> {
  /** Run the search — the caller owns the endpoint, params, and result shape. */
  search: (query: string) => Promise<T[]>;
  /** Called when an option is chosen. */
  onSelect: (option: T) => void;
  /** Called when the current selection is cleared. */
  onClear: () => void;
  /** The currently-selected id (drives the Clear button and suppresses the dropdown). */
  selectedId: number | string | null;
  /** Text shown in the input once a selection exists. */
  selectedLabel?: string;
  /** Primary line for an option in the dropdown. */
  getOptionLabel: (option: T) => string;
  /** Optional secondary line for an option (string or custom node, e.g. an age badge). */
  getOptionDescription?: (option: T) => React.ReactNode;
  label?: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  /** Minimum query length before searching (default 1). */
  minChars?: number;
  /** Debounce delay in ms (default 300). */
  debounceMs?: number;
}

/**
 * Debounced search → dropdown → select-and-clear picker, shared across the admin pages that
 * each hand-rolled this widget (participant/household/mentor lookups). The caller owns the
 * selection state (`selectedId` + `selectedLabel`) and supplies `search`; this component owns
 * the transient query/results/loading and the dropdown rendering.
 */
export function EntityPicker<T extends { id: number }>({
  search,
  onSelect,
  onClear,
  selectedId,
  selectedLabel,
  getOptionLabel,
  getOptionDescription,
  label,
  description,
  placeholder,
  required,
  minChars = 1,
  debounceMs = 300,
}: EntityPickerProps<T>) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<T[]>([]);
  const [searching, setSearching] = useState(false);

  const hasSelection = selectedId !== null && selectedId !== "";
  const active = !hasSelection && query.length >= minChars;
  // Results clear once a selection is made or the query gets too short.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setResults([]);
  }

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timeoutId = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await search(query);
        if (!cancelled) setResults(found);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
    // `search` is recreated each render by callers; intentionally excluded so typing alone drives it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, active, debounceMs]);

  const handleClear = () => {
    setQuery("");
    setResults([]);
    onClear();
  };

  return (
    <Box pos="relative">
      <TextInput
        label={label}
        description={description}
        placeholder={placeholder}
        required={required}
        value={hasSelection ? (selectedLabel ?? "") : query}
        readOnly={hasSelection}
        onChange={(e) => setQuery(e.currentTarget.value)}
        rightSection={
          hasSelection ? (
            <Button variant="subtle" color="red" size="compact-xs" onClick={handleClear}>
              Clear
            </Button>
          ) : undefined
        }
        rightSectionWidth={hasSelection ? 60 : undefined}
      />
      {searching && <Text size="xs" c="dimmed" mt={4}>Searching...</Text>}
      {!hasSelection && results.length > 0 && (
        <Paper
          withBorder
          shadow="md"
          radius="sm"
          pos="absolute"
          left={0}
          right={0}
          style={{ zIndex: 10, maxHeight: 250, overflowY: "auto" }}
        >
          {results.map((option) => (
            <Box
              key={option.id}
              p="sm"
              style={{ cursor: "pointer", borderBottom: "1px solid var(--mantine-color-default-border)" }}
              onClick={() => {
                setQuery("");
                setResults([]);
                onSelect(option);
              }}
            >
              <Text fw={500}>{getOptionLabel(option)}</Text>
              {getOptionDescription && (
                <Text size="xs" c="dimmed" component="div">{getOptionDescription(option)}</Text>
              )}
            </Box>
          ))}
        </Paper>
      )}
    </Box>
  );
}
