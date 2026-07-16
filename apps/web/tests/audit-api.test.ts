import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessAuditResponse } from "../src/audit-api.ts";

test("audit parser preserves logout entries without unknown fields", () => {
  const parsed = parseAccessAuditResponse({
    records: [
      {
        occurredAt: "2026-07-16T01:02:03.000Z",
        operation: "auth.logout",
        outcome: "allowed",
        deviceName: "Phone",
        local: false,
        token: "must-not-survive",
      },
      {
        occurredAt: "2026-07-16T01:03:03.000Z",
        operation: "audit.read",
        outcome: "allowed",
        deviceName: "Phone",
        local: false,
      },
    ],
  });

  assert.equal(parsed.records[1]?.operation, "auth.logout");
  assert.equal("token" in (parsed.records[1] ?? {}), false);
  assert.deepEqual(parsed.currentAccess, { deviceName: "Phone", local: false });
});

test("audit parser skips unsupported operations", () => {
  const parsed = parseAccessAuditResponse({
    records: [{
      occurredAt: "2026-07-16T01:02:03.000Z",
      operation: "secret.read",
      outcome: "allowed",
      deviceName: "Phone",
      local: false,
    }],
  });
  assert.deepEqual(parsed.records, []);
});
