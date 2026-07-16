import assert from "node:assert/strict";
import test from "node:test";
import { isOfficeSnapshot } from "../src/office-api.ts";

function snapshot(access: unknown): unknown {
  return {
    generatedAt: "2026-07-16T00:00:00.000Z",
    sequence: 1,
    capabilities: { protocolVersion: 1, serverVersion: "0.2.0", runtime: { state: "ready" }, access, features: ["chat", "profiles"] },
    profiles: [], sessions: [], boards: [],
  };
}

test("snapshot validator requires bounded effective access capabilities", () => {
  assert.equal(isOfficeSnapshot(snapshot({
    deviceId: "device-123",
    tier: "operator",
    exposure: "tailnet",
    authentication: "device-cookie",
    allowedOperations: ["state.read", "chat.session.create"],
  })), true);
  assert.equal(isOfficeSnapshot(snapshot({
    deviceId: "device-123",
    tier: "root",
    exposure: "tailnet",
    authentication: "device-cookie",
    allowedOperations: ["state.read"],
  })), false);
  assert.equal(isOfficeSnapshot(snapshot({
    deviceId: "device-123",
    tier: "operator",
    exposure: "tailnet",
    authentication: "device-cookie",
    allowedOperations: "state.read",
  })), false);
  assert.equal(isOfficeSnapshot(snapshot({
    deviceId: "device-123",
    tier: "operator",
    exposure: "tailnet",
    authentication: "device-cookie",
    allowedOperations: ["state.read", "invented.operation"],
  })), false);
});
