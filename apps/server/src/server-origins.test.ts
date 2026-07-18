import assert from "node:assert/strict";
import test from "node:test";
import { listenerOrigins } from "./server-origins.js";

test("listenerOrigins includes actual and localhost alias for IPv4 loopback", () => {
  const origins = listenerOrigins({ address: "127.0.0.1", family: "IPv4", port: 4173 });
  assert.deepEqual(origins, ["http://127.0.0.1:4173", "http://localhost:4173"]);
});

test("listenerOrigins includes actual and localhost alias for IPv6 loopback", () => {
  const origins = listenerOrigins({ address: "::1", family: "IPv6", port: 4173 });
  assert.deepEqual(origins, ["http://[::1]:4173", "http://localhost:4173"]);
});

test("listenerOrigins includes only the actual origin for non-loopback addresses", () => {
  assert.deepEqual(listenerOrigins({ address: "192.0.2.1", family: "IPv4", port: 4173 }), [
    "http://192.0.2.1:4173",
  ]);
  assert.deepEqual(listenerOrigins({ address: "2001:db8::1", family: "IPv6", port: 4173 }), [
    "http://[2001:db8::1]:4173",
  ]);
});
