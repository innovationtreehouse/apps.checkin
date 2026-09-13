export function normalizeDescription(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
