import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { createOfficeServer } from "./server.js";

const LOCAL_ORIGIN = "http://localhost:4173";
const REMOTE_ORIGIN = "https://office.tailnet.example";
const REMOTE_TOKEN = "correct-horse-battery-staple-remote-token";

async function deviceLogin(
  base: string,
  token: string,
  deviceName = "Travel phone",
): Promise<Response> {
  return await fetch(`${base}/api/v1/auth/device`, {
    method: "POST",
    headers: { Origin: REMOTE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ token, deviceName }),
  });
}

test("remote origins cannot claim local bootstrap even through a loopback proxy", async () => {
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [LOCAL_ORIGIN, REMOTE_ORIGIN],
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const remote = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN },
    });
    assert.equal(remote.status, 403);

    const proxiedSpoof = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: {
        Origin: LOCAL_ORIGIN,
        Host: "office.tailnet.example",
        "X-Forwarded-For": "100.64.0.10",
      },
    });
    assert.equal(proxiedSpoof.status, 403);

    const local = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: LOCAL_ORIGIN },
    });
    assert.equal(local.status, 200);
  } finally {
    await server.close();
  }
});

test("configured remote token issues a remote owner session without exposing the credential", async () => {
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [LOCAL_ORIGIN, REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await deviceLogin(base, REMOTE_TOKEN);
    assert.equal(login.status, 200);
    const loginText = await login.text();
    assert.equal(loginText.includes(REMOTE_TOKEN), false);
    const session = JSON.parse(loginText) as {
      csrfToken: string;
      principal: { id: string; local: boolean; deviceName: string; tier: string };
    };
    assert.deepEqual(session.principal, {
      id: session.principal.id,
      local: false,
      deviceName: "Travel phone",
      tier: "owner",
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);

    const audit = await fetch(`${base}/api/v1/audit`, {
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    });
    assert.equal(audit.status, 200);
    const auditText = await audit.text();
    assert.equal(auditText.includes(REMOTE_TOKEN), false);
    assert.equal(/password|api[_-]?key|access[_-]?token|refresh[_-]?token/i.test(auditText), false);
    const records = (JSON.parse(auditText) as { records: Array<{ operation: string; outcome: string }> }).records;
    assert.equal(records.some((record) => record.operation === "auth.device" && record.outcome === "allowed"), true);
    assert.equal(records.some((record) => record.operation === "audit.read"), true);
    assert.deepEqual(Object.keys(records[0] ?? {}).sort(), ["deviceName", "local", "occurredAt", "operation", "outcome"]);

    assert.equal((await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
      body: "{}",
    })).status, 413);
    assert.equal((await fetch(`${base}/api/v1/audit`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    })).status, 405);

    const events = new WebSocket(`${base.replace("http:", "ws:")}/api/v1/events`, {
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    });
    await once(events, "open");
    const closed = once(events, "close");

    const logout = await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie, "X-CSRF-Token": session.csrfToken },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    await closed;
    assert.equal((await fetch(`${base}/api/v1/audit`, { headers: { Origin: REMOTE_ORIGIN, Cookie: cookie } })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie, "X-CSRF-Token": session.csrfToken },
    })).status, 401);

    const nextLogin = await deviceLogin(base, REMOTE_TOKEN, "Owner phone");
    const nextCookie = nextLogin.headers.get("set-cookie") ?? "";
    const nextAudit = await fetch(`${base}/api/v1/audit`, { headers: { Origin: REMOTE_ORIGIN, Cookie: nextCookie } });
    const nextAuditText = await nextAudit.text();
    assert.equal(nextAuditText.includes(REMOTE_TOKEN), false);
    const nextRecords = (JSON.parse(nextAuditText) as { records: Array<{ operation: string; outcome: string }> }).records;
    assert.equal(nextRecords.some((record) => record.operation === "auth.logout" && record.outcome === "allowed"), true);
  } finally {
    await server.close();
  }
});

test("device authentication is disabled by default, bounded, strict, and rate limited", async () => {
  const disabledServer = createOfficeServer({ port: 0, allowedOrigins: [REMOTE_ORIGIN] });
  const disabledAddress = await disabledServer.listen();
  const disabledBase = `http://127.0.0.1:${disabledAddress.port}`;
  try {
    assert.equal((await deviceLogin(disabledBase, REMOTE_TOKEN)).status, 404);
  } finally {
    await disabledServer.close();
  }

  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    maxJsonBytes: 4 * 1024,
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const unknownField = await fetch(`${base}/api/v1/auth/device`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: REMOTE_TOKEN, deviceName: "Phone", extra: true }),
    });
    assert.equal(unknownField.status, 400);

    const oversized = await fetch(`${base}/api/v1/auth/device`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: "x".repeat(5_000), deviceName: "Phone" }),
    });
    assert.equal(oversized.status, 413);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await deviceLogin(base, `wrong-${"x".repeat(32)}-${attempt}`);
      assert.equal(rejected.status, 401);
      assert.equal((await rejected.text()).includes(`wrong-`), false);
    }
    const limited = await deviceLogin(base, `wrong-${"y".repeat(32)}`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
  } finally {
    await server.close();
  }
});
