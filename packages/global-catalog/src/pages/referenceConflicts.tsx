"use client";
import { Title } from "@mantine/core";
import ReferenceConflictsClient from "../components/ReferenceConflictsClient";

/** /catalog/reference-conflicts — manual references that contradict a learned mapping. */
export default function ReferenceConflictsPage() {
  return (
    <>
      <Title order={3} mb="md">Reference Conflicts</Title>
      <ReferenceConflictsClient />
    </>
  );
}
