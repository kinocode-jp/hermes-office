import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import type { HermesSettingsAdapter } from "./hermes-settings.js";
import { OfficeGlobalSettingsStore } from "./hermes-settings.js";
import { createOfficeServer } from "./server.js";
import { createDemoSnapshot, createDemoRuntimeStatus } from "./demo-state.js";

test("Office Server settings API requires authentication and CSRF on writes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-settings-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const global = new OfficeGlobalSettingsStore(join(directory, "global.json"));
  let selectedProvider = "builtin";
  const settings = makeSettingsAdapter(
    () => selectedProvider,
    (provider) => { selectedProvider = provider; },
  );
  const runtime: HermesRuntimeSource = {
    status: createDemoRuntimeStatus,
    snapshot: async () => createDemoSnapshot(),
    close: async () => undefined,
    chat: () => { throw new Error("unused"); },
    kanban: () => { throw new Error("unused"); },
    settings: () => settings,
    globalSettings: () => global,
  };
  const server = createOfficeServer({ port: 0, runtimeSource: runtime });
  const address = await server.listen();
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${address.port}`;
  const browserOrigin = "http://localhost:4173";

  const unauthenticated = await fetch(`${origin}/api/v1/settings/global`, { headers: { Origin: browserOrigin } });
  assert.equal(unauthenticated.status, 401);

  const bootstrap = await fetch(`${origin}/api/v1/auth/local`, { method: "POST", headers: { Origin: browserOrigin } });
  assert.equal(bootstrap.status, 200);
  const session = await bootstrap.json() as { csrfToken: string };
  const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0]!;

  const readable = await fetch(`${origin}/api/v1/profiles/coder/memory`, {
    headers: { Origin: browserOrigin, Cookie: cookie },
  });
  assert.equal(readable.status, 200);
  assert.equal((await readable.json() as { activeProvider: string }).activeProvider, "builtin");

  const skillsResponse = await fetch(`${origin}/api/v1/profiles/coder/skills`, {
    headers: { Origin: browserOrigin, Cookie: cookie },
  });
  const skillsText = await skillsResponse.text();
  assert.equal(skillsResponse.status, 200);
  assert.ok(Buffer.byteLength(skillsText) > 64 * 1024);
  assert.equal((JSON.parse(skillsText) as unknown[]).length, 1_000);

  const denied = await fetch(`${origin}/api/v1/profiles/coder/memory/provider`, {
    method: "PUT",
    headers: { Origin: browserOrigin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "honcho", expectedProvider: "builtin" }),
  });
  assert.equal(denied.status, 403);
  assert.equal(selectedProvider, "builtin");

  const allowed = await fetch(`${origin}/api/v1/profiles/coder/memory/provider`, {
    method: "PUT",
    headers: { Origin: browserOrigin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
    body: JSON.stringify({ provider: "honcho", expectedProvider: "builtin" }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(selectedProvider, "honcho");

  const reset = await fetch(`${origin}/api/v1/profiles/coder/memory/reset`, {
    method: "POST",
    headers: { Origin: browserOrigin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
    body: JSON.stringify({ target: "all" }),
  });
  assert.equal(reset.status, 404);
});

function makeSettingsAdapter(getProvider: () => string, setProvider: (provider: string) => void): HermesSettingsAdapter {
  const memory = () => ({ activeProvider: getProvider(), providers: [], builtin: { memoryBytes: 0, userBytes: 0, hasMemory: false, hasUser: false } });
  const soul = { profile: "coder", content: "identity", exists: true, redacted: false, revision: "a".repeat(43) };
  const skills = Array.from({ length: 1_000 }, (_, index) => ({
    name: `skill-${index}`,
    category: "workspace",
    description: `Safe skill ${index} ${"x".repeat(120)}`,
    enabled: index % 2 === 0,
    provenance: "agent" as const,
    usage: index,
  }));
  return {
    getProfileSettings: async (profile) => ({ profile, skills, memory: memory(), soul: { ...soul, profile } }),
    listSkills: async () => skills,
    setSkillEnabled: async () => undefined,
    getSkillContent: async (_profile, name) => ({ name, content: "", redacted: false, revision: "a".repeat(43) }),
    updateSkillContent: async () => undefined,
    getMemoryStatus: async () => memory(),
    setMemoryProvider: async (_profile, provider, expected) => {
      if (expected !== getProvider()) throw new Error("conflict");
      setProvider(provider);
    },
    getMemoryProviderConfig: async (_profile, name) => ({ name, label: name, fields: [], revision: "a".repeat(43) }),
    updateMemoryProviderConfig: async () => undefined,
    resetBuiltinMemory: async () => { throw new Error("must not be called"); },
    getProfileSoul: async (profile) => ({ ...soul, profile }),
    updateProfileSoul: async () => undefined,
  };
}
