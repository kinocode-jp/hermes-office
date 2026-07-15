import assert from "node:assert/strict";
import test from "node:test";
import { createOfficeServer, isLoopbackHost, makeOriginAllowlist } from "./server.js";

test("non-loopback listeners require an explicit opt-in", () => {
  assert.throws(() => createOfficeServer({ host: "0.0.0.0" }), /Refusing non-loopback bind/);
  assert.doesNotThrow(() =>
    createOfficeServer({ host: "0.0.0.0", allowNonLoopback: true }),
  );
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("192.168.1.20"), false);
});

test("origin allowlist rejects wildcards and null origins", () => {
  assert.throws(() => makeOriginAllowlist(["*"]), /explicit, non-null/);
  assert.throws(() => makeOriginAllowlist(["null"]), /explicit, non-null/);
  assert.equal(
    makeOriginAllowlist(["https://office.example/"]).has("https://office.example"),
    true,
  );
});

test("snapshot is bounded, explicit, and does not expose secret-shaped fields", async () => {
  const server = createOfficeServer({ port: 0 });
  const address = await server.listen();

  try {
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/v1/snapshot`, {
      headers: { Origin: "http://localhost:4173" },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(/password|api[_-]?key|access[_-]?token|refresh[_-]?token/i.test(body), false);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const rejected = await fetch(`${base}/api/v1/snapshot`, {
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(rejected.status, 403);
  } finally {
    await server.close();
  }
});
