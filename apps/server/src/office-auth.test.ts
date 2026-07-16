import assert from "node:assert/strict";
import { createServer } from "node:http";
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
