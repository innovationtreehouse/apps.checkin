"use client";
import { useState } from "react";
import { Anchor, Button, FileInput, Group, Paper, Table, Text, Title } from "@mantine/core";
import { act, api, useCanWrite, useLoad, when } from "../components/api";
import LoadError from "../components/LoadError";

interface FileRow {
  id: number;
  uploadedAt: string;
  originalFilename: string;
  rowCount: number;
  newRowCount: number;
  duplicateRowCount: number;
  allDuplicate: boolean;
  blobDeleted: boolean;
}

/** /donations/uploads — import a Benevity CSV and see every past upload. */
export default function UploadsPage() {
  const canWrite = useCanWrite();
  const files = useLoad<FileRow[]>("/uploaded-files");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    setBusy(true);
    const ok = await act(() => api("/uploaded-files", { method: "POST", body }), "Upload imported", files.reload);
    setBusy(false);
    if (ok) setFile(null);
  }

  return (
    <>
      <Title order={3} mb="md">Benevity uploads</Title>
      {canWrite && (
        <Paper withBorder p="md" radius="md" mb="md" maw={560}>
          <Group align="flex-end">
            <FileInput label="Benevity CSV" accept=".csv,text/csv" value={file} onChange={setFile} style={{ flex: 1 }} />
            <Button onClick={upload} loading={busy} disabled={!file}>Upload</Button>
          </Group>
          <Text size="xs" c="dimmed" mt="xs">Gifts already imported are skipped, so re-uploading a file is safe.</Text>
        </Paper>
      )}
      {files.error && <LoadError what="uploads" message={files.error} onRetry={files.reload} />}
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Uploaded</Table.Th><Table.Th>File</Table.Th><Table.Th>Rows</Table.Th>
            <Table.Th>New</Table.Th><Table.Th>Duplicate</Table.Th><Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(files.data ?? []).map((f) => (
            <Table.Tr key={f.id}>
              <Table.Td>{when(f.uploadedAt)}</Table.Td>
              <Table.Td>
                {f.blobDeleted ? f.originalFilename : (
                  <Anchor href={`/api/donations/uploaded-files/${f.id}/blob`}>{f.originalFilename}</Anchor>
                )}
              </Table.Td>
              <Table.Td>{f.rowCount}</Table.Td>
              <Table.Td>{f.newRowCount}</Table.Td>
              <Table.Td>{f.duplicateRowCount}</Table.Td>
              <Table.Td>
                {canWrite && f.allDuplicate && !f.blobDeleted && (
                  <Button size="xs" variant="light" color="red"
                    onClick={() => act(() => api(`/uploaded-files/${f.id}/blob`, { method: "DELETE" }), "Stored file deleted", files.reload)}>
                    Delete stored file
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}
