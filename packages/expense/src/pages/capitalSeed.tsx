"use client";
import { useState } from "react";
import { Button, Paper, Stack, Table, Text, Textarea, Title } from "@mantine/core";
import { api, errorMessage } from "../components/api";

interface SeedResult {
  created: number;
  skipped: number;
  errors: number;
  results: { assetNumber: string; status: string; error?: string }[];
}

/**
 * /expense/capital-seed — FINANCE seeds the capital register from historical QuickBooks asset
 * numbers. Paste a JSON array of { assetNumber, description, acquisitionDate?, costCents?,
 * depreciationYears?, parentAssetNumber?, sourceQbTxnId? }; re-running skips existing assets.
 */
export default function CapitalSeedPage() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<SeedResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      setResult(await api<SeedResult>("/capital-assets/seed", { method: "POST", body: JSON.stringify(JSON.parse(text)) }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      <Title order={3} mb="md">Capital register seed</Title>
      <Paper withBorder p="md" maw={720}>
        <Stack>
          <Text size="sm" c="dimmed">One record per physical asset (ITFA numbers). Existing asset numbers are skipped.</Text>
          <Textarea autosize minRows={8} placeholder='[{"assetNumber":"ITFA001","description":"Table saw"}]' value={text} onChange={(e) => setText(e.currentTarget.value)} />
          <Button onClick={() => void submit()} disabled={!text.trim()}>Seed</Button>
          {error && <Text c="red" size="sm">{error}</Text>}
        </Stack>
      </Paper>
      {result && (
        <>
          <Text mt="md">Created {result.created} · skipped {result.skipped} · errors {result.errors}</Text>
          <Table maw={720}>
            <Table.Tbody>
              {result.results.map((r) => (
                <Table.Tr key={r.assetNumber}><Table.Td>{r.assetNumber}</Table.Td><Table.Td>{r.status}</Table.Td><Table.Td>{r.error ?? ""}</Table.Td></Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
    </>
  );
}
