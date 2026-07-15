import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverHermesRuntime,
  normalizeBaseUrl,
  probeHermesCli,
} from "./hermes-runtime.js";

test("ready status is validated and reduced to a secret-free DTO", async () => {
  const fixture = await statusServer({
    version: "0.18.2",
    release_date: "2026.7.7.2",
    config_version: 33,
    latest_config_version: 33,
    gateway_running: true,
    gateway_state: "running",
    active_sessions: 2,
    auth_required: true,
    auth_providers: ["nous"],
    access_token: "must-not-escape",
    gateways: [{ port: 9119, secret: "must-not-escape" }],
  });

  try {
    const result = await discoverHermesRuntime({ baseUrl: fixture.baseUrl, timeoutMs: 500 });
    assert.equal(result.state, "ready");
    assert.equal(result.runtime?.version, "0.18.2");
    assert.equal(result.runtime?.activeSessions, 2);
    assert.equal(result.cli.state, "not_configured");
    assert.equal(/token|secret|9119/.test(JSON.stringify(result)), false);
  } finally {
    await fixture.close();
  }
});

test("reachable non-Hermes responses are incompatible", async () => {
  const fixture = await statusServer({ ok: true });
  try {
    const result = await discoverHermesRuntime({ baseUrl: fixture.baseUrl, timeoutMs: 500 });
    assert.equal(result.state, "incompatible");
    assert.equal(result.reason, "invalid_response");
  } finally {
    await fixture.close();
  }
});

test("CLI invocation never passes executable text through a shell", async () => {
  const sentinel = join(tmpdir(), `hermes-office-shell-${process.pid}-${Date.now()}`);
  const result = await probeHermesCli(`/missing/hermes;touch ${sentinel}`, 200);
  assert.equal(result.state, "unavailable");
  assert.equal(existsSync(sentinel), false);
});

test("base URL rejects credentials and non-origin paths", () => {
  assert.throws(() => normalizeBaseUrl("http://user:pass@127.0.0.1:9119"), /credentials/);
  assert.throws(() => normalizeBaseUrl("http://127.0.0.1:9119/dashboard"), /without a path/);
  assert.equal(normalizeBaseUrl("http://127.0.0.1:9119").origin, "http://127.0.0.1:9119");
});

async function statusServer(body: unknown): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}
