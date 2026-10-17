"use client";

import { AuditLogPanel } from "@/components/admin/AuditLogPanel";

// Admission (sysadmin or board) is the /system-status layout's gate; this page
// adds nothing on top of it.
export default function SystemStatusAuditLogPage() {
  return <AuditLogPanel />;
}
