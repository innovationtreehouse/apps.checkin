import { describe, it, expect } from "vitest";
import { AUDIT_EVENT_LABEL, auditEventLabel, workflowAuditEventTypeEnum } from "../../db/schema";

describe("auditEventLabel", () => {
  it("gives every audit event a plain-word label", () => {
    for (const eventType of workflowAuditEventTypeEnum) {
      expect(auditEventLabel(eventType)).toBe(AUDIT_EVENT_LABEL[eventType]);
      expect(auditEventLabel(eventType)).not.toMatch(/_/);
    }
  });

  it("falls back to the raw code for an unknown event", () => {
    expect(auditEventLabel("something_new")).toBe("something_new");
    expect(auditEventLabel("constructor")).toBe("constructor");
  });
});
