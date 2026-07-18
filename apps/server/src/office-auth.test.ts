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
  const auth = new OfficeAuth({
    remoteToken,
    allowedOrigins: ["https://Office.Tailnet.Example:443/", "http://localhost:4173", "tauri://localhost", "http://127.0.0.1:4173"],
    trustedProxyHops: 1,
  });
  const local = auth.bootstrapLocal(
    { headers: { origin: "http://localhost:4173", host: "localhost:4173" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage,
    { appendHeader: () => undefined, setHeader: () => undefined } as unknown as ServerResponse,
  );
  assert.ok(local);
  const owner = auth.remoteConfig(local);
  assert.ok(owner);
  assert.equal(owner.enabled, true);
  assert.deepEqual(owner.origins, ["https://office.tailnet.example"]);
  assert.equal(owner.origins[0]?.toLowerCase(), owner.origins[0]);
  assert.equal(owner.trustedProxyHops, 1);
  assert.equal(owner.devices.length, 0);
  assert.equal(JSON.stringify(owner).includes(remoteToken), false);
});

test("OfficeAuth rejects invalid configured origins", () => {
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
