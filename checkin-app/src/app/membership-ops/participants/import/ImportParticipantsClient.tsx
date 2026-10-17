"use client";

import { useState } from "react";
import { Alert, Badge, Box, Button, Card, FileInput, Group, List, Stack, Table, Text, Title } from "@mantine/core";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { useRequireRole } from "@/hooks/useRequireRole";
import { PageLoader } from "@/components/ui/PageLoader";

type RowStatus = "ready" | "update" | "warning" | "error";

interface RowPreview {
  rowNumber: number;
  data: {
    firstName: string;
    lastName: string;
    email: string;
    parentEmail: string;
    dob: string;
    address: string;
    sameHouseholdAs: string;
  };
  status: RowStatus;
  action: string;
  warnings: string[];
  existingParticipant?: { id: number; name: string | null };
}

interface PreviewResult {
  columns: string[];
  rows: RowPreview[];
  summary: { ready: number; update: number; warning: number; error: number };
}

type ImportResult = { success?: boolean; message?: string; errors?: string[] };

const STATUS_META: Record<RowStatus | "all", { label: string; icon: string; color: string }> = {
  all: { label: "All", icon: "📋", color: "gray" },
  ready: { label: "New", icon: "✅", color: "treehouseGreen" },
  update: { label: "Update", icon: "🔄", color: "blue" },
  warning: { label: "Warning", icon: "⚠️", color: "yellow" },
  error: { label: "Error", icon: "❌", color: "red" },
};

export default function BulkImportParticipants() {
  const { ready, loading: authLoading } = useRequireRole(['isSysadmin', 'isBoardMember']);
  const [file, setFile] = useState<File | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [statusFilter, setStatusFilter] = useState<RowStatus | "all">("all");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) {
    return null;
  }

  const handleFileChange = (f: File | null) => {
    setFile(f);
    setPreview(null);
    setImportResult(null);
    setPreviewError(null);
  };

  const handlePreview = async () => {
    if (!file) return;
    setIsPreviewing(true);
    setPreview(null);
    setPreviewError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/membership-ops/participants/import/preview", { method: "POST", body: formData });
      const data = await res.json();
      if (res.ok) setPreview(data);
      else setPreviewError(data.error || "Failed to parse file.");
    } catch (err) {
      console.error("Preview error:", err);
      setPreviewError("An unexpected error occurred during preview.");
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!file) return;
    setIsImporting(true);
    setImportResult(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/membership-ops/participants/import", { method: "POST", body: formData });
      const data = await res.json();
      if (res.ok) {
        setImportResult({ success: true, message: data.message, errors: data.errors });
        setPreview(null);
      } else {
        setImportResult({ success: false, message: data.error || "Failed to import." });
      }
    } catch (err) {
      console.error("Import error:", err);
      setImportResult({ success: false, message: "An unexpected error occurred during import." });
    } finally {
      setIsImporting(false);
    }
  };

  const handleReset = () => {
    setFile(null);
    setPreview(null);
    setImportResult(null);
    setPreviewError(null);
    setStatusFilter("all");
    setExpandedRow(null);
  };

  const filteredRows = preview
    ? statusFilter === "all" ? preview.rows : preview.rows.filter(r => r.status === statusFilter)
    : [];

  const importableCount = preview ? preview.rows.filter(r => r.status !== "error").length : 0;

  return (
    <Stack maw={900} mx="auto">
      <AdminPageHeader title="Bulk Import Participants" back={{ href: '/membership-ops', label: '← Membership Ops' }} />

      {/* Step 1: Upload */}
      {!preview && !importResult && (
        <>
          <Text c="dimmed">
            Upload an Excel (.xlsx) or CSV file containing participant records. You&apos;ll get a
            chance to review everything before anything is imported.
          </Text>

          <Alert color="blue" variant="light" title="Instructions">
            <List type="ordered" spacing="xs">
              <List.Item>Download the import template provided below.</List.Item>
              <List.Item>Fill in the participant data. <strong>First Name</strong> and <strong>Last Name</strong> are required.</List.Item>
              <List.Item>For adult members, provide their <strong>Email</strong>. A household and membership will be created automatically.</List.Item>
              <List.Item>For students or dependents, leave <strong>Email</strong> blank and provide the primary member&apos;s email in <strong>Parent Email</strong>.</List.Item>
              <List.Item>Use <strong>Same Household As</strong> to link someone to another participant&apos;s household by name or email (e.g. a spouse).</List.Item>
              <List.Item>Save the file and upload it here.</List.Item>
            </List>
            <Button component="a" href="/Participant_Import_Template.xlsx" download variant="light" mt="md">
              ⬇️ Download Template (.xlsx)
            </Button>
          </Alert>

          <Card withBorder radius="md" padding="lg">
            <Title order={4} mb="md">Upload File</Title>
            <Stack>
              <FileInput
                accept=".xlsx,.xls,.csv"
                placeholder="Select a .xlsx, .xls, or .csv file"
                value={file}
                onChange={handleFileChange}
                clearable
              />
              <Button onClick={handlePreview} disabled={!file || isPreviewing} loading={isPreviewing}>
                🔍 Preview Import
              </Button>
            </Stack>
          </Card>

          {previewError && <Alert color="red" title="❌ Preview Failed">{previewError}</Alert>}
        </>
      )}

      {/* Step 2: Preview / Staging */}
      {preview && !importResult && (
        <>
          <Group gap="xs" wrap="wrap">
            {(["all", "ready", "update", "warning", "error"] as const).map((key) => {
              const count = key === "all" ? preview.rows.length : preview.summary[key];
              const meta = STATUS_META[key];
              return (
                <Button
                  key={key}
                  variant={statusFilter === key ? 'filled' : 'default'}
                  color={meta.color}
                  size="xs" fz={15}
                  onClick={() => setStatusFilter(key)}
                  rightSection={<Badge color={meta.color} variant="light" size="sm">{count}</Badge>}
                >
                  {meta.icon} {meta.label}
                </Button>
              );
            })}
          </Group>

          <Table.ScrollContainer minWidth={650}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Row</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Email</Table.Th>
                  <Table.Th>Action</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filteredRows.map((row) => {
                  const meta = STATUS_META[row.status];
                  const isExpanded = expandedRow === row.rowNumber;
                  return (
                    <Table.Tr key={row.rowNumber} onClick={() => setExpandedRow(isExpanded ? null : row.rowNumber)} style={{ cursor: 'pointer' }}>
                      <Table.Td c="dimmed">{row.rowNumber}</Table.Td>
                      <Table.Td>
                        <Badge color={meta.color} variant="light">{meta.icon} {meta.label}</Badge>
                      </Table.Td>
                      <Table.Td fw={500}>{row.data.firstName} {row.data.lastName}</Table.Td>
                      <Table.Td c="dimmed">
                        {row.data.email || row.data.parentEmail ? (
                          <>
                            {row.data.email || <Text component="span" fs="italic">none</Text>}
                            {row.data.parentEmail && <Text size="xs" mt={2}>↳ Parent: {row.data.parentEmail}</Text>}
                          </>
                        ) : (
                          <Text component="span" fs="italic">none</Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{row.action}</Text>
                        {isExpanded && row.warnings.length > 0 && (
                          <List size="sm" c="yellow" mt="xs">
                            {row.warnings.map((w, i) => <List.Item key={i}>{w}</List.Item>)}
                          </List>
                        )}
                        {isExpanded && (
                          <Group gap="md" mt="xs">
                            {row.data.dob && <Text size="xs" c="dimmed">DOB: {row.data.dob}</Text>}
                            {row.data.address && <Text size="xs" c="dimmed">Address: {row.data.address}</Text>}
                            {row.data.sameHouseholdAs && <Text size="xs" c="dimmed">Same Household As: {row.data.sameHouseholdAs}</Text>}
                          </Group>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>

          {filteredRows.length === 0 && (
            <Text ta="center" c="dimmed" fs="italic" py="md">No rows match the selected filter.</Text>
          )}

          <Group justify="space-between" wrap="wrap">
            <Button variant="default" onClick={handleReset}>← Back to File Selection</Button>
            <Button onClick={handleConfirmImport} disabled={isImporting || importableCount === 0} loading={isImporting}>
              🚀 Import {importableCount} Participant{importableCount !== 1 ? "s" : ""}
              {preview.summary.error > 0 && !isImporting && ` (${preview.summary.error} error${preview.summary.error !== 1 ? "s" : ""} skipped)`}
            </Button>
          </Group>
        </>
      )}

      {/* Step 3: Import Result */}
      {importResult && (
        <Stack>
          <Alert color={importResult.success ? 'treehouseGreen' : 'red'} title={importResult.success ? "✅ Import Successful" : "❌ Import Failed"}>
            <Text>{importResult.message}</Text>
            {importResult.errors && importResult.errors.length > 0 && (
              <Box mt="md">
                <Text fw={600} size="sm" c="red" mb="xs">Warnings / Partial Errors:</Text>
                <List size="sm" style={{ maxHeight: 200, overflowY: 'auto' }}>
                  {importResult.errors.map((err, i) => <List.Item key={i}>{err}</List.Item>)}
                </List>
              </Box>
            )}
          </Alert>
          <Button variant="default" onClick={handleReset} style={{ alignSelf: 'flex-start' }}>Import Another File</Button>
        </Stack>
      )}
    </Stack>
  );
}
