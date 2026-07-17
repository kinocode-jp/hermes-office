import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GlobalInheritanceCoordinator } from "./global-inheritance.js";
import type { HermesSettingsAdapter } from "./hermes-settings.js";
import { HermesSettingsError, OfficeGlobalSettingsStore } from "./hermes-settings.js";
import { routeSettingsHttp } from "./settings-http.js";

const REVISION = "a".repeat(43);

test("settings HTTP routes reads and revisioned mutations without exposing backend details", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-http-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter = makeAdapter(calls);
  const globalSettings = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const server = createServer(async (request, response) => {
    const result = await routeSettingsHttp(request, new URL(request.url ?? "/", "http://office.local"), { settings: adapter, globalSettings }, 4_096);
    response.writeHead(result.status, { "Content-Type": "application/json", ...(result.headers ?? {}) });
    response.end(JSON.stringify(result.body));
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const global = await fetch(`${origin}/api/v1/settings/global`);
  assert.equal(global.status, 200);
  assert.equal((await global.json() as { revision: number }).revision, 0);

  const saved = await jsonFetch(`${origin}/api/v1/settings/global`, "PATCH", {
    expectedRevision: 0,
    skills: ["browser"],
    context: "Shared context",
  });
  assert.equal(saved.status, 200);
  assert.equal((saved.body as { revision: number }).revision, 1);

  const stale = await jsonFetch(`${origin}/api/v1/settings/global`, "PATCH", { expectedRevision: 0, context: "stale" });
  assert.equal(stale.status, 409);
  assert.equal((stale.body as { error: { code: string } }).error.code, "conflict");

  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/settings`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/skills`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/skills/local/content`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/soul`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/memory`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/profiles/coder/memory/providers/honcho`)).status, 200);

  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local`, "PATCH", { enabled: false, expectedEnabled: true })).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local/content`, "PUT", { content: "safe", expectedRevision: REVISION })).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/soul`, "PUT", { content: "identity", expectedRevision: REVISION })).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/memory/provider`, "PUT", { provider: "honcho", expectedProvider: "builtin" })).status, 200);
  assert.equal((await jsonFetch(`${origin}/api/v1/profiles/coder/memory/providers/honcho`, "PATCH", { values: { mode: "local" }, expectedRevision: REVISION })).status, 200);

  assert.deepEqual(calls.filter((call) => call.method.startsWith("set") || call.method.startsWith("update")), [
    { method: "setSkillEnabled", args: ["coder", "local", false, true] },
    { method: "updateSkillContent", args: ["coder", "local", "safe", REVISION] },
    { method: "updateProfileSoul", args: ["coder", "identity", REVISION] },
    { method: "setMemoryProvider", args: ["coder", "honcho", "builtin"] },
    { method: "updateMemoryProviderConfig", args: ["coder", "honcho", { mode: "local" }, REVISION] },
  ]);
});

test("settings HTTP rejects unbounded/unknown input and omits memory reset and secret routes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-http-settings-safe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapter = makeAdapter([]);
  let persistenceWrites = 0;
  const globalSettings = new OfficeGlobalSettingsStore(join(directory, "global.json"), {
    beforeWrite: async () => { persistenceWrites += 1; },
  });
  const server = createServer(async (request, response) => {
    const result = await routeSettingsHttp(request, new URL(request.url ?? "/", "http://office.local"), { settings: adapter, globalSettings }, 128);
    response.writeHead(result.status, { "Content-Type": "application/json", ...(result.headers ?? {}) });
    response.end(JSON.stringify(result.body));
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const reset = await jsonFetch(`${origin}/api/v1/profiles/coder/memory/reset`, "POST", { target: "all" });
  assert.equal(reset.status, 404);
  const secret = await jsonFetch(`${origin}/api/v1/profiles/coder/memory/providers/honcho/secret`, "PUT", { apiKey: "hidden" });
  assert.equal(secret.status, 404);
  const extra = await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local`, "PATCH", { enabled: true, expectedEnabled: false, token: "hidden" });
  assert.equal(extra.status, 400);
  const invalidType = await fetch(`${origin}/api/v1/settings/global`, { method: "PATCH", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(invalidType.status, 415);
  const oversized = await fetch(`${origin}/api/v1/settings/global`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 0, context: "x".repeat(500) }) });
  assert.equal(oversized.status, 413);

  const hiddenCredentials = [
    "\u001b]0;API_KEY=title-secret\u0007",
    "\u001b]8;;https://example.test/?token=uri-secret\u001b\\label",
    "\u009d0;Authorization: Bearer c1-secret-value\u009c",
    "API_KEY=\u001b[12345678m",
    "API\u001b]0;ignored\u0018_KEY=cancelled-secret\u0007",
  ];
  for (const context of hiddenCredentials) {
    const rejected = await jsonFetch(`${origin}/api/v1/settings/global`, "PATCH", { expectedRevision: 0, context });
    assert.equal(rejected.status, 400, context);
    assert.equal(JSON.stringify(rejected.body).includes(context), false, context);
  }
  assert.equal(persistenceWrites, 0, "rejected control sequences never reach the persistence boundary");
  const after = await fetch(`${origin}/api/v1/settings/global`);
  const serialized = await after.text();
  assert.equal(after.status, 200);
  assert.equal((JSON.parse(serialized) as { revision: number }).revision, 0);
  for (const secretValue of ["title-secret", "uri-secret", "c1-secret-value", "12345678", "cancelled-secret"]) {
    assert.equal(serialized.includes(secretValue), false);
  }
});

test("settings HTTP maps adapter conflict and failure to stable public errors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-http-settings-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapter = makeAdapter([]);
  adapter.setSkillEnabled = async () => { throw new HermesSettingsError("conflict", "Hermes setting changed; refresh before saving."); };
  adapter.getMemoryStatus = async () => { throw new Error("/Users/private api_key=secret"); };
  const server = createServer(async (request, response) => {
    const result = await routeSettingsHttp(request, new URL(request.url ?? "/", "http://office.local"), { settings: adapter, globalSettings: new OfficeGlobalSettingsStore(join(directory, "global.json")) }, 4_096);
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const conflict = await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local`, "PATCH", { enabled: false, expectedEnabled: true });
  assert.equal(conflict.status, 409);
  const failed = await fetch(`${origin}/api/v1/profiles/coder/memory`);
  assert.equal(failed.status, 502);
  const text = await failed.text();
  assert.equal(text.includes("/Users/private"), false);
  assert.equal(text.includes("api_key"), false);
});

test("profile skill override is persisted only after the Hermes mutation succeeds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-http-skill-override-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  const staged = await store.beginMaterialization({ expectedRevision: 0, skills: ["local"] });
  await store.finishMaterialization(staged.settings.revision, [{ profile: "coder", skill: "local" }], [], []);
  const adapter = makeAdapter([]);
  let failure: HermesSettingsError | undefined = new HermesSettingsError("conflict", "Hermes setting changed; refresh before saving.");
  adapter.setSkillEnabled = async () => {
    if (failure !== undefined) throw failure;
  };
  const inheritance = new GlobalInheritanceCoordinator({ store, settings: adapter, listProfiles: async () => ["coder"] });
  const server = createServer(async (request, response) => {
    const result = await routeSettingsHttp(
      request,
      new URL(request.url ?? "/", "http://office.local"),
      { settings: adapter, globalSettings: store, globalInheritance: inheritance },
      4_096,
    );
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  const origin = await listen(server);
  t.after(() => server.close());

  const failed = await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local`, "PATCH", { enabled: false, expectedEnabled: true });
  assert.equal(failed.status, 409);
  assert.deepEqual((await store.readMaterialization()).managedSkills, [{ profile: "coder", skill: "local" }]);
  assert.deepEqual((await store.readMaterialization()).skillOverrides, []);
  assert.equal((await store.readMaterialization()).pendingSkillOverrides.length, 0, "definite conflicts abort the intent");

  failure = undefined;
  const succeeded = await jsonFetch(`${origin}/api/v1/profiles/coder/skills/local`, "PATCH", { enabled: false, expectedEnabled: true });
  assert.equal(succeeded.status, 200);
  assert.deepEqual((await store.readMaterialization()).managedSkills, []);
  assert.deepEqual((await store.readMaterialization()).skillOverrides, [{ profile: "coder", skill: "local" }]);
  assert.deepEqual((await store.readMaterialization()).pendingSkillOverrides, []);
});

function makeAdapter(calls: Array<{ method: string; args: unknown[] }>): HermesSettingsAdapter {
  const record = <T>(method: string, value: T) => async (...args: unknown[]): Promise<T> => { calls.push({ method, args }); return value; };
  const skill = { name: "local", category: "custom", description: "Safe", enabled: true, provenance: "agent" as const, usage: 1 };
  const memory = { activeProvider: "builtin", providers: [{ name: "builtin", description: "Built-in", configured: true }], builtin: { memoryBytes: 1, userBytes: 0, hasMemory: true, hasUser: false } };
  const soul = { profile: "coder", content: "identity", exists: true, redacted: false, revision: REVISION };
  const config = { name: "honcho", label: "Honcho", fields: [], revision: REVISION };
  return {
    getProfileSettings: record("getProfileSettings", { profile: "coder", skills: [skill], memory, soul }),
    listSkills: record("listSkills", [skill]),
    setSkillEnabled: record("setSkillEnabled", undefined),
    getSkillContent: record("getSkillContent", { name: "local", content: "safe", redacted: false, revision: REVISION }),
    updateSkillContent: record("updateSkillContent", undefined),
    getMemoryStatus: record("getMemoryStatus", memory),
    setMemoryProvider: record("setMemoryProvider", undefined),
    getMemoryProviderConfig: record("getMemoryProviderConfig", config),
    updateMemoryProviderConfig: record("updateMemoryProviderConfig", undefined),
    resetBuiltinMemory: record("resetBuiltinMemory", undefined),
    getProfileSoul: record("getProfileSoul", soul),
    updateProfileSoul: record("updateProfileSoul", undefined),
  } as HermesSettingsAdapter;
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function jsonFetch(url: string, method: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as unknown };
}
