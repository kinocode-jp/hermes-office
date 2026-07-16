import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HermesBackend } from "./hermes-backend.js";

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
