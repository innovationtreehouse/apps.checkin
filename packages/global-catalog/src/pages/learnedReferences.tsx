"use client";
import { Title } from "@mantine/core";
import LearnedReferencesClient from "../components/LearnedReferencesClient";

/** /catalog/learned-references — the part-to-item references learned from receipts. */
export default function LearnedReferencesPage() {
  return (
    <>
      <Title order={3} mb="md">Learned References</Title>
      <LearnedReferencesClient />
    </>
  );
}
