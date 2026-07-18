import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackOrigin, isTrustedLocalOrigin, normalizeOrigin } from "./origin.js";

test("normalizeOrigin canonicalizes, rejects credentials/path/query/fragment, and preserves special values", () => {
  const accepted: { input: string; expected: string }[] = [
    { input: "http://localhost:4173", expected: "http://localhost:4173" },
    { input: "HTTP://LOCALHOST:4173", expected: "http://localhost:4173" },
    { input: "https://127.0.0.1:4173", expected: "https://127.0.0.1:4173" },
    { input: "tauri://localhost", expected: "tauri://localhost" },
    { input: "TAURI://Localhost", expected: "tauri://localhost" },
    { input: "http://tauri.localhost", expected: "http://tauri.localhost" },
    { input: "https://tauri.localhost", expected: "https://tauri.localhost" },
    { input: "https://example.com:443", expected: "https://example.com" },
    { input: "*", expected: "*" },
    { input: "null", expected: "null" },
    { input: "", expected: "" },
  ];
  for (const { input, expected } of accepted) {
    assert.equal(normalizeOrigin(input), expected, input);
  }

  const acceptedPortless: { input: string; expected: string }[] = [
    { input: "http://localhost", expected: "http://localhost" },
  ];
  for (const { input, expected } of acceptedPortless) {
    assert.equal(normalizeOrigin(input), expected, input);
  }

  const rejected: { input: string; label: string }[] = [
    { input: "http://localhost:4173/path", label: "path" },
    { input: "http://user:pass@localhost:4173", label: "credentials" },
    { input: "http://localhost:4173?query=1", label: "query" },
    { input: "http://localhost:4173#hash", label: "fragment" },
    { input: "not a url", label: "malformed" },
  ];
  for (const { input, label } of rejected) {
    assert.equal(normalizeOrigin(input), "", label);
  }
});

test("isTrustedLocalOrigin accepts the three portless Tauri constants and localhost/127.0.0.1 with or without port", () => {
  const accepted: { input: string; label: string }[] = [
    { input: "tauri://localhost", label: "tauri" },
    { input: "http://tauri.localhost", label: "http-tauri" },
    { input: "https://tauri.localhost", label: "https-tauri" },
    { input: "http://localhost:4173", label: "localhost-port" },
    { input: "http://localhost", label: "localhost-missing-port" },
    { input: "http://127.0.0.1:4173", label: "ipv4-port" },
    { input: "https://127.0.0.1:4173", label: "https-ipv4" },
    { input: "HTTP://LOCALHOST:4173", label: "uppercase" },
  ];
  for (const { input, label } of accepted) {
    assert.equal(isTrustedLocalOrigin(input), true, label);
  }

  const rejected: { input: string; label: string }[] = [
    { input: "tauri://localhost:1234", label: "tauri-port" },
    { input: "http://tauri.localhost:4173", label: "http-tauri-port" },
    { input: "https://tauri.localhost:4173", label: "https-tauri-port" },
    { input: "http://localhost:4173/path", label: "path" },
    { input: "http://localhost:4173?query=1", label: "query" },
    { input: "http://localhost:4173#hash", label: "fragment" },
    { input: "http://user:pass@localhost:4173", label: "credentials" },
    { input: "http://example.com:4173", label: "non-loopback" },
    { input: "", label: "empty" },
  ];
  for (const { input, label } of rejected) {
    assert.equal(isTrustedLocalOrigin(input), false, label);
  }

  assert.equal(isTrustedLocalOrigin(undefined), false, "undefined");
});

test("isLoopbackOrigin recognizes the three Tauri constants and localhost/127.0.0.1/::1", () => {
  const accepted: { input: string; label: string }[] = [
    { input: "tauri://localhost", label: "tauri" },
    { input: "http://tauri.localhost", label: "http-tauri" },
    { input: "https://tauri.localhost", label: "https-tauri" },
    { input: "http://localhost:4173", label: "localhost" },
    { input: "http://127.0.0.1:4173", label: "ipv4" },
    { input: "http://[::1]:4173", label: "ipv6" },
  ];
  for (const { input, label } of accepted) {
    assert.equal(isLoopbackOrigin(input), true, label);
  }

  const rejected: { input: string; label: string }[] = [
    { input: "http://example.com:4173", label: "non-loopback" },
    { input: "http://192.0.2.1:4173", label: "non-loopback-ip" },
    { input: "not a url", label: "malformed" },
    { input: "", label: "empty" },
  ];
  for (const { input, label } of rejected) {
    assert.equal(isLoopbackOrigin(input), false, label);
  }
});
