import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HermesProfileBackendPool } from "./hermes-profile-pool.js";

test("parallel profile starts never exceed the configured process slots", async () => {
  const fixture = await createFixture();
  const allowed = new Set(["one", "two", "three", "four", "five"]);
  const pool = new HermesProfileBackendPool({
    executable: fixture.executable,
    cwd: fixture.directory,
    maxBackends: 2,
    startTimeoutMs: 2_000,
    isKnownProfile: async (profile) => allowed.has(profile),
  });
  try {
    await Promise.all([...allowed].map(async (profile) => await pool.resolve(profile)));
    const files = await readdir(fixture.directory);
    assert.equal(files.filter((file) => file.endsWith(".pid")).length, 2);
    const observed = await Promise.all(
      files.filter((file) => file.endsWith(".observed"))
        .map(async (file) => Number(await readFile(join(fixture.directory, file), "utf8"))),
    );
    assert.ok(Math.max(...observed) <= 2);

    await assert.rejects(pool.resolve("unknown"), /does not exist/);
    assert.equal((await readdir(fixture.directory)).includes("unknown.pid"), false);
  } finally {
    await pool.close();
    await fixture.close();
  }
});

test("failed and timed-out starts always release their process slot", async () => {
  const fixture = await createFixture();
  const pool = new HermesProfileBackendPool({
    executable: fixture.executable,
    cwd: fixture.directory,
    maxBackends: 1,
    startTimeoutMs: 1_000,
    isKnownProfile: async () => true,
  });
  try {
    await assert.rejects(pool.resolve("fail"), /exited before readiness/);
    await assert.rejects(pool.resolve("stall"), /startup timed out/);
    await pool.resolve("one");
    const files = await readdir(fixture.directory);
    assert.deepEqual(files.filter((file) => file.endsWith(".pid")), ["one.pid"]);
  } finally {
    await pool.close();
    await fixture.close();
  }
});

test("profile output is drained after readiness without retaining it", async () => {
  const fixture = await createFixture();
  const pool = new HermesProfileBackendPool({
    executable: fixture.executable,
    cwd: fixture.directory,
    maxBackends: 1,
    startTimeoutMs: 2_000,
    isKnownProfile: async (profile) => profile === "drain-output",
  });
  try {
    await pool.resolve("drain-output");
    await waitForFile(join(fixture.directory, "drain-output.done"), 3_000);
  } finally {
    await pool.close();
    await fixture.close();
  }
});

async function createFixture(): Promise<{
  directory: string;
  executable: string;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-profile-pool-"));
  const executable = join(directory, "fake-hermes.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const index = process.argv.indexOf("--profile");
const profile = process.argv[index + 1];
const directory = process.cwd();
const pidFile = join(directory, profile + ".pid");
writeFileSync(pidFile, String(process.pid));
const live = readdirSync(directory).filter((file) => file.endsWith(".pid")).length;
writeFileSync(join(directory, profile + ".observed"), String(live));
const stop = () => { try { rmSync(pidFile); } catch {} process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
if (profile === "fail") stop();
if (profile === "stall") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
process.stdout.write("HERMES_DASHBOARD_READY port=12345\\n");
if (profile === "drain-output") {
  const flood = async (stream) => {
    const chunk = "x".repeat(16 * 1024);
    for (let written = 0; written < 2 * 1024 * 1024; written += chunk.length) {
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once("drain", resolve));
    }
  };
  await flood(process.stdout);
  await flood(process.stderr);
  writeFileSync(join(directory, profile + ".done"), "done");
}
setInterval(() => {}, 1000);
`, "utf8");
  await chmod(executable, 0o755);
  return { directory, executable, close: async () => await rm(directory, { recursive: true, force: true }) };
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch { /* Not written yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}
