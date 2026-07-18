import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { OfficeAuth } from "./office-auth.js";

test("local bootstrap issues an HttpOnly session and requires CSRF for mutation", async () => {
  const auth = new OfficeAuth();
  const server = createServer((request, response) => {
    if (request.url === "/bootstrap") {
      const session = auth.bootstrapLocal(request, response);
      response.end(JSON.stringify(session));
      return;
    }
    const session = request.url === "/mutate" ? auth.authorizeMutation(request) : auth.authenticate(request);
    response.writeHead(session === undefined ? 401 : 200);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const bootstrap = await fetch(`${base}/bootstrap`, { headers: { Origin: "http://localhost:4173" } });
    const cookie = bootstrap.headers.get("set-cookie");
    const body = await bootstrap.json() as { csrfToken: string };
    assert.match(cookie ?? "", /HttpOnly/);
    assert.equal((await fetch(`${base}/read`, { headers: { Cookie: cookie ?? "" } })).status, 200);
    assert.equal((await fetch(`${base}/mutate`, { headers: { Cookie: cookie ?? "" } })).status, 401);
    assert.equal((await fetch(`${base}/mutate`, { headers: { Cookie: cookie ?? "", "X-CSRF-Token": body.csrfToken } })).status, 200);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("desktop capability authenticates with canonicalized origin comparison", async () => {
  const capability = "c".repeat(64);
  const auth = new OfficeAuth({
    desktopCapability: capability,
    desktopOrigins: ["TAURI://Localhost", "HTTP://Localhost:4173", "http://127.0.0.1:4173"],
  });
  const server = createServer((request, response) => {
    const session = request.url === "/mutate" ? auth.authorizeMutation(request) : auth.authenticate(request);
    response.writeHead(session === undefined ? 401 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(session ?? {}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const rawOrigin of ["tauri://localhost", "TAURI://Localhost", "http://localhost:4173", "http://LOCALHOST:4173", "http://127.0.0.1:4173"]) {
      const result = await fetch(`${base}/read`, {
        headers: { Origin: rawOrigin, "X-Hermes-Office-Desktop-Capability": capability },
      });
      assert.equal(result.status, 200, `expected ${rawOrigin} to authenticate`);
    }

    for (const malformedOrigin of ["TAURI://Localhost/path", "TAURI://Localhost?query", "TAURI://Localhost#hash", "http://localhost.evil.com"]) {
      const result = await fetch(`${base}/read`, {
        headers: { Origin: malformedOrigin, "X-Hermes-Office-Desktop-Capability": capability },
      });
      assert.equal(result.status, 401, `expected ${malformedOrigin} to be rejected`);
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("desktop capability is Tauri-only, mutation-capable, and renews its bounded lease", async () => {
  const capability = "c".repeat(64);
  const auth = new OfficeAuth({ desktopCapability: capability });
  const server = createServer((request, response) => {
    const session = request.url === "/mutate" ? auth.authorizeMutation(request) : auth.authenticate(request);
    response.writeHead(session === undefined ? 401 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(session ?? {}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Origin: "tauri://localhost", "X-Hermes-Office-Desktop-Capability": capability };
  try {
    const first = await fetch(`${base}/read`, { headers });
    assert.equal(first.status, 200);
    const firstLease = await first.json() as { expiresAt: string };
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await fetch(`${base}/mutate`, { method: "POST", headers });
    assert.equal(second.status, 200);
    const secondLease = await second.json() as { expiresAt: string };
    assert.ok(Date.parse(secondLease.expiresAt) > Date.parse(firstLease.expiresAt));

    assert.equal((await fetch(`${base}/read`, {
      headers: { ...headers, Origin: "http://localhost:4173" },
    })).status, 401);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("remote config status returns configured allowed origins and never exposes secrets", () => {
  const remoteToken = "a".repeat(64);
  const capability = "d".repeat(64);
  const auth = new OfficeAuth({
    remoteToken,
    desktopCapability: capability,
    allowedOrigins: ["https://Office.Tailnet.Example:443/", "http://localhost:4173", "tauri://localhost", "http://127.0.0.1:4173"],
    trustedProxyHops: 1,
  });
  const desktop = auth.authenticate(
    { headers: { origin: "tauri://localhost", host: "localhost:4317", "x-hermes-office-desktop-capability": capability }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage,
  );
  assert.ok(desktop);
  assert.equal(desktop.principal.id, "local-desktop");
  const owner = auth.remoteConfig(desktop);
  assert.ok(owner);
  assert.equal(owner.enabled, true);
  assert.deepEqual(owner.origins, ["https://office.tailnet.example"]);
  assert.equal(owner.origins[0]?.toLowerCase(), owner.origins[0]);
  assert.equal(owner.trustedProxyHops, 1);
  assert.equal(owner.devices.length, 0);
  assert.equal(JSON.stringify(owner).includes(remoteToken), false);

  const local = auth.bootstrapLocal(
    { headers: { origin: "http://localhost:4173", host: "localhost:4173" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage,
    { appendHeader: () => undefined, setHeader: () => undefined } as unknown as ServerResponse,
  );
  assert.ok(local);
  assert.equal(auth.remoteConfig(local), undefined);
});

test("local bootstrap rejects raw local origins with credentials, path, query, or fragment", () => {
  const auth = new OfficeAuth();
  const response = { appendHeader: () => undefined, setHeader: () => undefined } as unknown as ServerResponse;
  const denied = [
    { origin: "http://localhost:4173/path", label: "path" },
    { origin: "http://user:pass@localhost:4173", label: "credentials" },
    { origin: "http://localhost:4173?query=1", label: "query" },
    { origin: "http://localhost:4173#hash", label: "fragment" },
  ];
  for (const { origin, label } of denied) {
    const request = {
      headers: { origin, host: "localhost:4173" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    assert.equal(auth.bootstrapLocal(request, response), undefined, label);
  }

  const accepted = [
    { origin: "http://localhost:4173", label: "lowercase" },
    { origin: "HTTP://LOCALHOST:4173", label: "uppercase" },
    { origin: "http://127.0.0.1:4173", label: "ipv4" },
    { origin: "TAURI://Localhost", label: "tauri-canonical" },
    { origin: "HTTP://Tauri.Localhost", label: "tauri-http-canonical" },
    { origin: "HTTPS://Tauri.Localhost", label: "tauri-https-canonical" },
  ];
  for (const { origin, label } of accepted) {
    const request = {
      headers: { origin, host: "localhost:4173" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    assert.ok(auth.bootstrapLocal(request, response), label);
  }
});

test("local bootstrap rejects malformed Host values with query or fragment", () => {
  const auth = new OfficeAuth();
  const response = { appendHeader: () => undefined, setHeader: () => undefined } as unknown as ServerResponse;
  const denied = [
    { host: "localhost:4173?query=1", label: "query" },
    { host: "localhost:4173#hash", label: "fragment" },
  ];
  for (const { host, label } of denied) {
    const request = {
      headers: { origin: "http://localhost:4173", host },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    assert.equal(auth.bootstrapLocal(request, response), undefined, label);
  }
});

test("Tauri bridge origins must be the exact portless constants; port-bearing Tauri origins are rejected", () => {
  const capability = "c".repeat(64);
  const auth = new OfficeAuth({
    desktopCapability: capability,
    desktopOrigins: ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"],
  });
  const response = { appendHeader: () => undefined, setHeader: () => undefined } as unknown as ServerResponse;

  // Exact portless constants are accepted.
  for (const origin of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]) {
    const request = {
      headers: { origin, host: "tauri.localhost", "x-hermes-office-desktop-capability": capability },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    assert.ok(auth.authenticate(request), origin);
  }

  // Port-bearing variants of the three special Tauri bridge origins are rejected.
  const denied = [
    { origin: "tauri://localhost:1234", label: "tauri-port" },
    { origin: "http://tauri.localhost:4173", label: "http-tauri-port" },
    { origin: "https://tauri.localhost:4173", label: "https-tauri-port" },
  ];
  for (const { origin, label } of denied) {
    const request = {
      headers: { origin, host: "tauri.localhost", "x-hermes-office-desktop-capability": capability },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    assert.equal(auth.authenticate(request), undefined, label);
  }

  // Local development can use an explicit localhost HTTP(S) origin (e.g. http://localhost:4173), not the tauri scheme.
  const local = auth.bootstrapLocal(
    { headers: { origin: "http://localhost:4173", host: "localhost:4173" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage,
    response,
  );
  assert.ok(local);
});

test("local bootstrap accepts IPv6 loopback [::1] origin and Host, rejects non-loopback/malformed IPv6", () => {
  const auth = new OfficeAuth();
  const response = { appendHeader: () => undefined, setHeader: () => undefined } as unknown as ServerResponse;

  const accepted = [
    { origin: "http://[::1]:4173", host: "[::1]:4173", label: "ipv6-loopback-port" },
    { origin: "HTTP://[::1]:4173", host: "[::1]:4173", label: "uppercase-ipv6" },
  ];
  for (const { origin, host, label } of accepted) {
    const request = {
      headers: { origin, host },
      socket: { remoteAddress: "::1" },
    } as unknown as IncomingMessage;
    assert.ok(auth.bootstrapLocal(request, response), label);
  }

  const denied = [
    { origin: "http://[::2]:4173", host: "[::2]:4173", label: "non-loopback-ipv6" },
    { origin: "http://[2001:db8::1]:4173", host: "[2001:db8::1]:4173", label: "non-loopback-ula" },
    { origin: "http://[::1]:4173", host: "[::2]:4173", label: "origin-host-mismatch" },
    { origin: "http://[::1]:4173/path", host: "[::1]:4173", label: "path" },
    { origin: "http://[::1]:4173?query=1", host: "[::1]:4173", label: "query" },
    { origin: "http://[::1]:4173#hash", host: "[::1]:4173", label: "fragment" },
    { origin: "http://user:pass@[::1]:4173", host: "[::1]:4173", label: "credentials" },
    { origin: "http://[::1:4173", host: "[::1:4173", label: "malformed-host-bracket" },
  ];
  for (const { origin, host, label } of denied) {
    const request = {
      headers: { origin, host },
      socket: { remoteAddress: "::1" },
    } as unknown as IncomingMessage;
    assert.equal(auth.bootstrapLocal(request, response), undefined, label);
  }
});

test("OfficeAuth rejects invalid configured origins", () => {
  assert.throws(
    () => new OfficeAuth({ remoteToken: "b".repeat(64), allowedOrigins: ["TAURI://Localhost:4173"] }),
    (error: unknown) => error instanceof Error && error.message.includes("exact portless Tauri bridge origin"),
    "uppercase tauri port-bearing origin must require exact portless Tauri bridge origin",
  );
  const invalidCases = [
    { origin: "http://insecure.example", label: "non-loopback HTTP" },
    { origin: "https://with-path.example/path", label: "path" },
    { origin: "https://user:secret@cred.example", label: "credentials", secret: "secret" },
    { origin: "https://query.example?foo=1", label: "query" },
    { origin: "https://fragment.example#hash", label: "fragment" },
    { origin: "https://192.0.2.1", label: "IP" },
    { origin: "https://trailing-dot.example.", label: "trailing-dot" },
    { origin: "https://example-.com", label: "trailing-hyphen-label" },
    { origin: "https://-example.com", label: "leading-hyphen-label" },
    { origin: `https://${"a".repeat(64)}.example.com`, label: "overlong-label" },
    { origin: "not a url", label: "malformed" },
    { origin: "", label: "empty" },
    { origin: "tauri://localhost:4173", label: "tauri-localhost-port" },
    { origin: "TAURI://Localhost:4173", label: "tauri-localhost-port-mixed-case" },
    { origin: "http://tauri.localhost:4173", label: "http-tauri-port" },
    { origin: "https://tauri.localhost:4173", label: "https-tauri-port" },
    { origin: "HTTP://Tauri.Localhost:4173", label: "http-tauri-port-mixed-case" },
    { origin: "HTTPS://Tauri.Localhost:4173", label: "https-tauri-port-mixed-case" },
  ];
  for (const { origin, label, secret } of invalidCases) {
    assert.throws(
      () => new OfficeAuth({ remoteToken: "b".repeat(64), allowedOrigins: [origin] }),
      (error: unknown) => {
        assert.ok(error instanceof Error, `${label}: expected Error`);
        if (secret !== undefined) {
          assert.equal(error.message?.includes(secret), false, `${label}: error message must not include credential`);
        }
        return true;
      },
      label,
    );
  }
});
