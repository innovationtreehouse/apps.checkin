"use client";
import { Group, Pagination } from "@mantine/core";
import { PAGE_SIZE } from "./api";

/** Pages a list route that returns no total: a full page offers the next one. */
export default function Pager({ page, onChange, rows }: { page: number; onChange: (page: number) => void; rows: readonly unknown[] | null | undefined }) {
  const total = page + ((rows?.length ?? 0) >= PAGE_SIZE ? 1 : 0);
  if (total <= 1) return null;
  return (
    <Group justify="center" mt="md">
      <Pagination value={page} onChange={onChange} total={total} />
    </Group>
  );
}
