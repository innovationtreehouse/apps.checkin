// Placeholder so the egress allowlist can name this file before its calls land.
// The Directory members client replaces it; this stays the only file that calls fetch.
export interface GoogleMember {
  email: string;
  role: string;
  type: string;
  status: string;
}
