import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractLiveModels,
  extractProviders,
  extractReasoningEfforts,
  mergeProviderExtracts,
} from "./hermes-models.js";

test("extractProviders reads session_visit-style and options-style payloads", () => {
  const sessionVisit = extractProviders({
    provider: "openrouter",
    providers: [
      { slug: "openrouter", label: "OpenRouter", is_current: true },
      { id: "ollama", name: "Ollama" },
      { id: "secret", label: "api_key_value" },
    ],
  }, 50);
  assert.equal(sessionVisit.activeProvider, "openrouter");
  assert.equal(sessionVisit.hasListedProviders, true);
  assert.deepEqual(sessionVisit.providers.map((item) => item.id), ["openrouter", "ollama"]);
  assert.equal(sessionVisit.providers[0]!.active, true);

  const optionsShape = extractProviders({
    provider: "anthropic",
    providers: [
      { slug: "anthropic", models: ["claude"] },
      { slug: "openai", models: ["gpt"] },
    ],
  }, 50);
  assert.equal(optionsShape.activeProvider, "anthropic");
  assert.equal(optionsShape.hasListedProviders, true);
  assert.equal(optionsShape.providers.length, 2);
});

test("extractProviders injects active-only payloads and marks them incomplete for fallback", () => {
  assert.deepEqual(extractProviders(null, 10), {
    providers: [],
    activeProvider: "",
    hasListedProviders: false,
  });
  const onlyActive = extractProviders({ active_provider: "custom:team", providers: [] }, 10);
  assert.equal(onlyActive.activeProvider, "custom:team");
  assert.equal(onlyActive.hasListedProviders, false);
  assert.deepEqual(onlyActive.providers, [{ id: "custom:team", label: "custom:team", active: true }]);

  const activeWithoutArray = extractProviders({ provider: "openrouter" }, 10);
  assert.equal(activeWithoutArray.hasListedProviders, false);
  assert.deepEqual(activeWithoutArray.providers, [
    { id: "openrouter", label: "openrouter", active: true },
  ]);
});

test("extractProviders omits explicitly unconfigured or disabled rows unless active", () => {
  const result = extractProviders({
    provider: "openrouter",
    providers: [
      { id: "openrouter", label: "OpenRouter", is_current: true },
      { id: "ollama", label: "Ollama", configured: true },
      { id: "missing-key", label: "Missing", configured: false },
      { id: "disabled", label: "Disabled", enabled: false },
      { id: "unauth", label: "Unauth", authenticated: false },
      { id: "active-unconfigured", label: "Still active", configured: false, is_current: true },
      "string-provider",
    ],
  }, 50);
  assert.equal(result.hasListedProviders, true);
  assert.deepEqual(result.providers.map((item) => item.id).sort(), [
    "active-unconfigured",
    "ollama",
    "openrouter",
    "string-provider",
  ].sort());
  assert.equal(result.providers.find((item) => item.id === "missing-key"), undefined);
  assert.equal(result.providers.find((item) => item.id === "disabled"), undefined);
  assert.equal(result.providers.find((item) => item.id === "unauth"), undefined);
  assert.equal(result.providers.find((item) => item.id === "active-unconfigured")?.active, true);
});

test("mergeProviderExtracts prefers listed fallback catalogs without dropping active", () => {
  const incomplete = extractProviders({ active_provider: "openrouter", providers: [] }, 50);
  assert.equal(incomplete.hasListedProviders, false);

  const full = extractProviders({
    providers: [
      { id: "openrouter", label: "OpenRouter" },
      { id: "ollama", label: "Ollama" },
      { id: "custom:team", label: "Team" },
    ],
  }, 50);
  assert.equal(full.hasListedProviders, true);

  const merged = mergeProviderExtracts(incomplete, full, 50);
  assert.equal(merged.hasListedProviders, true);
  assert.equal(merged.activeProvider, "openrouter");
  assert.deepEqual(merged.providers.map((item) => item.id), ["openrouter", "ollama", "custom:team"]);
  assert.equal(merged.providers.find((item) => item.id === "openrouter")?.active, true);

  // Later incomplete seed must not erase a listed catalog already held.
  const kept = mergeProviderExtracts(merged, incomplete, 50);
  assert.equal(kept.hasListedProviders, true);
  assert.equal(kept.providers.length, 3);
});

test("extractLiveModels accepts string ids and object rows without secrets", () => {
  const models = extractLiveModels({
    models: [
      "llama3.2",
      { id: "org::model", label: "Org" },
      { model: "api_key_leak", label: "bad" },
      { id: "ok", name: "OK" },
    ],
  }, 50);
  assert.deepEqual(models, [
    { id: "llama3.2", label: "llama3.2" },
    { id: "org::model", label: "Org" },
    { id: "ok", label: "OK" },
  ]);
});

test("extractReasoningEfforts only keeps the 8 Hermes levels and ignores boolean flags", () => {
  assert.equal(extractReasoningEfforts({ reasoning: true }), undefined);
  assert.equal(extractReasoningEfforts({ reasoning: false }), undefined);
  assert.deepEqual(
    extractReasoningEfforts({ reasoning_efforts: ["high", "BOGUS", "low", "high", "none"] }),
    ["none", "low", "high"],
  );
  assert.deepEqual(
    extractReasoningEfforts({ reasoning: { allowed_options: ["minimal", "xhigh", "ultra"] } }),
    ["minimal", "xhigh", "ultra"],
  );
  assert.deepEqual(
    extractReasoningEfforts({ supports: { reasoning_effort: ["medium", "max"] } }),
    ["medium", "max"],
  );
});

test("extractLiveModels attaches per-model reasoning efforts from rows and capability maps", () => {
  const models = extractLiveModels({
    models: [
      { id: "with-levels", label: "A", reasoningEfforts: ["low", "high"] },
      { id: "from-caps", label: "B" },
      { id: "plain", label: "C" },
    ],
    capabilities: {
      "from-caps": { reasoning_efforts: ["none", "medium"] },
      plain: { reasoning: true },
    },
  }, 50);
  assert.deepEqual(models.find((item) => item.id === "with-levels")?.reasoningEfforts, ["low", "high"]);
  assert.deepEqual(models.find((item) => item.id === "from-caps")?.reasoningEfforts, ["none", "medium"]);
  assert.equal(models.find((item) => item.id === "plain")?.reasoningEfforts, undefined);
});
