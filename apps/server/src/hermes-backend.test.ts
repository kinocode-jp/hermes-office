import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HermesBackend } from "./hermes-backend.js";

test("inventory reaches the 101st session and profile through bounded continuation pages", async () => {
  const sessionRows = Array.from({ length: 101 }, (_, index) => sessionRow(index));
  const profileRows = Array.from({ length: 101 }, (_, index) => profileRow(index));
  const offsets: number[] = [];
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") return writeJson(response, { profiles: profileRows });
    if (url.pathname === "/api/profiles/sessions") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      offsets.push(offset);
      return writeJson(response, { sessions: sessionRows.slice(offset, offset + 100), total: sessionRows.length, limit: 100, offset, errors: [] });
    }
    return defaultFixtureRoute(request, response, url);
  });
  const backend = fixture.backend;
  try {
    assert.equal((await backend.start()).state, "ready");
    const snapshot = await backend.snapshot();
    assert.equal(snapshot.sessions.length, 100);
    assert.equal(snapshot.profiles.length, 100);
    assert.deepEqual(offsets, [0, 100]);
    assert.equal(snapshot.inventory.sessions.hasMore, true);
    assert.equal(snapshot.inventory.profiles.hasMore, true);
    const sessionsPage = await backend.inventoryPage("sessions", snapshot.inventory.sessions.nextCursor!, 100);
    const profilesPage = await backend.inventoryPage("profiles", snapshot.inventory.profiles.nextCursor!, 100);
    assert.deepEqual(sessionsPage.sessions.map((session) => session.id), ["session-100"]);
    assert.deepEqual(profilesPage.profiles.map((profile) => profile.id), ["profile-100"]);
  } finally {
    await backend.close();
    await fixture.close();
  }
});

test("concurrent snapshots share one inventory collection and both cursors remain usable", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => sessionRow(index));
  let profileRequests = 0;
  let sessionRequests = 0;
  let boardRequests = 0;
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") {
      profileRequests += 1;
      setTimeout(() => writeJson(response, { profiles: [profileRow(0)] }), 20);
      return;
    }
    if (url.pathname === "/api/profiles/sessions") {
      sessionRequests += 1;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      setTimeout(() => writeJson(response, { sessions: rows.slice(offset, offset + 100), total: rows.length, errors: [] }), 20);
      return;
    }
    if (url.pathname === "/api/plugins/kanban/board") {
      boardRequests += 1;
      setTimeout(() => writeJson(response, { columns: [], latest_event_id: 0 }), 60);
      return;
    }
    return defaultFixtureRoute(request, response, url);
  });
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    const [first, second] = await Promise.all([fixture.backend.snapshot(), fixture.backend.snapshot()]);
    assert.equal(profileRequests, 1);
    assert.equal(sessionRequests, 2);
    assert.equal(boardRequests, 1);
    assert.equal(first.inventory.sessions.nextCursor, second.inventory.sessions.nextCursor);
    assert.deepEqual((await fixture.backend.inventoryPage("sessions", first.inventory.sessions.nextCursor!, 100)).sessions.map((item) => item.id), ["session-100"]);
    assert.deepEqual((await fixture.backend.inventoryPage("sessions", second.inventory.sessions.nextCursor!, 100)).sessions.map((item) => item.id), ["session-100"]);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("inventory preserves first-seen order, removes overlapping page duplicates, and reports the missing row", async () => {
  const first = Array.from({ length: 100 }, (_, index) => sessionRow(index));
  const offsets: number[] = [];
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") return writeJson(response, { profiles: [profileRow(0)] });
    if (url.pathname === "/api/profiles/sessions") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      offsets.push(offset);
      const sessions = offset === 0 ? first : [sessionRow(99), sessionRow(100)];
      return writeJson(response, { sessions, total: 102, limit: 100, offset, errors: [] });
    }
    return defaultFixtureRoute(request, response, url);
  });
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    const snapshot = await fixture.backend.snapshot();
    const page = await fixture.backend.inventoryPage("sessions", snapshot.inventory.sessions.nextCursor!, 100);
    assert.deepEqual(offsets, [0, 100]);
    assert.deepEqual([...snapshot.sessions, ...page.sessions].map((session) => session.id), Array.from({ length: 101 }, (_, index) => `session-${index}`));
    assert.equal(page.pagination.available, 101);
    assert.equal(page.pagination.total, 102);
    assert.equal(page.pagination.truncated, true);
    assert.equal(page.pagination.partialFailures, 1);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("an upstream failure after the first page retains a clearly truncated usable inventory", async () => {
  const offsets: number[] = [];
  const fixture = await startHermesFixture((request, response, url) => {
    if (url.pathname === "/api/profiles") return writeJson(response, { profiles: [profileRow(0)] });
    if (url.pathname === "/api/profiles/sessions") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      offsets.push(offset);
      if (offset > 0) { response.writeHead(500); response.end(); return; }
      return writeJson(response, { sessions: Array.from({ length: 100 }, (_, index) => sessionRow(index)), total: 101, limit: 100, offset, errors: [] });
    }
    return defaultFixtureRoute(request, response, url);
  });
  try {
    assert.equal((await fixture.backend.start()).state, "ready");
    const snapshot = await fixture.backend.snapshot();
    assert.deepEqual(offsets, [0, 100]);
    assert.equal(snapshot.sessions.length, 100);
    assert.equal(snapshot.inventory.sessions.hasMore, false);
    assert.equal(snapshot.inventory.sessions.truncated, true);
    assert.equal(snapshot.inventory.sessions.partialFailures, 1);
  } finally {
    await fixture.backend.close();
    await fixture.close();
  }
});

test("managed backend drains output beyond pipe capacity after readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-backend-"));
  const executable = join(directory, "fake-hermes.mjs");
  const donePath = join(directory, "output-drained.done");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
if (process.argv.includes("--version")) {
  process.stdout.write("Hermes Agent v0.18.2\\n");
  process.exit(0);
}
const server = createServer((request, response) => {
  if (request.url === "/api/status") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ version: "0.18.2" }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  process.stdout.write("HERMES_DASHBOARD_READY port=" + address.port + "\\n");
  const flood = async (stream) => {
    const chunk = "x".repeat(16 * 1024);
    for (let written = 0; written < 2 * 1024 * 1024; written += chunk.length) {
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once("drain", resolve));
    }
  };
  await flood(process.stdout);
  await flood(process.stderr);
  writeFileSync(${JSON.stringify(donePath)}, "done");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`, "utf8");
  await chmod(executable, 0o755);

  const backend = new HermesBackend({
    executable,
    startTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    globalSettingsPath: join(directory, "global-settings.json"),
  });
  try {
    assert.equal((await backend.start()).state, "ready");
    await waitForFile(donePath, 3_000);
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch { /* Not written yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function startHermesFixture(handler: (request: IncomingMessage, response: ServerResponse, url: URL) => void): Promise<{ backend: HermesBackend; close(): Promise<void> }> {
  const server = createServer((request, response) => handler(request, response, new URL(request.url ?? "/", "http://fixture.local")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    backend: new HermesBackend({ baseUrl: `http://127.0.0.1:${address.port}`, sessionToken: "fixture-session-token-0123456789", requestTimeoutMs: 2_000 }),
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function defaultFixtureRoute(_request: IncomingMessage, response: ServerResponse, url: URL): void {
  if (url.pathname === "/api/status") { writeJson(response, { version: "0.18.2" }); return; }
  if (url.pathname === "/api/plugins/kanban/board") { writeJson(response, { columns: [], latest_event_id: 0 }); return; }
  response.writeHead(404);
  response.end();
}

function profileRow(index: number): Record<string, unknown> {
  return { name: `profile-${index}`, gateway_running: false, skill_count: index };
}

function sessionRow(index: number): Record<string, unknown> {
  return { id: `session-${index}`, profile: "profile-0", title: `Session ${index}`, is_active: false, started_at: 1_700_000_000 - index, last_active: 1_700_000_000 - index };
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
