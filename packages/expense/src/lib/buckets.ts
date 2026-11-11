export interface Bucket {
  id: number;
  name: string;
  archivedAt: string | null;
}

/** Bucket picker options: the live buckets, by id. */
export function bucketChoices(buckets: Bucket[] | null): { value: string; label: string }[] {
  return (buckets ?? []).filter((b) => !b.archivedAt).map((b) => ({ value: String(b.id), label: b.name }));
}
