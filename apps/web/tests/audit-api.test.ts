import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessAuditResponse } from "../src/audit-api.ts";
import { accessDeviceName } from "../src/audit-presentation.ts";
import { locale, setLocale } from "../src/i18n.ts";

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

test("audit parser preserves all current mutation operations and skips unknown operations", () => {
  const parsed = parseAccessAuditResponse({
    records: [
      {
        occurredAt: "2026-07-16T01:02:03.000Z",
        operation: "kanban.card.update",
        outcome: "allowed",
        deviceName: "Phone",
        local: false,
      },
      {
        occurredAt: "2026-07-16T01:03:03.000Z",
        operation: "global-settings.update",
        outcome: "denied",
        deviceName: "Phone",
        local: false,
      },
      {
        occurredAt: "2026-07-16T01:04:03.000Z",
        operation: "secret.read",
        outcome: "allowed",
        deviceName: "Phone",
        local: false,
      },
    ],
  });
  assert.deepEqual(parsed.records.map((record) => record.operation), ["global-settings.update", "kanban.card.update"]);
});

test("missing current device names stay locale-neutral until presentation", () => {
  const previousLocale = locale.value;
  const local = parseAccessAuditResponse({
    records: [{
      occurredAt: "2026-07-16T01:03:03.000Z",
      operation: "audit.read",
      outcome: "allowed",
      deviceName: null,
      local: true,
    }],
  });
  const remote = parseAccessAuditResponse({
    records: [{
      occurredAt: "2026-07-16T01:03:03.000Z",
      operation: "audit.read",
      outcome: "allowed",
      deviceName: null,
      local: false,
    }],
  });

  try {
    assert.deepEqual(local.currentAccess, { deviceName: null, local: true });
    assert.deepEqual(remote.currentAccess, { deviceName: null, local: false });
    setLocale("ja");
    assert.equal(accessDeviceName(local.currentAccess), "このMac");
    assert.equal(accessDeviceName(remote.currentAccess), "リモート端末");
    setLocale("en");
    assert.equal(accessDeviceName(local.currentAccess), "This Mac");
    assert.equal(accessDeviceName(remote.currentAccess), "Remote device");
    assert.equal(accessDeviceName(null), "Checking");
  } finally {
    setLocale(previousLocale);
  }
});
