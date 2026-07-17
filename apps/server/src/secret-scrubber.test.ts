import assert from "node:assert/strict";
import test from "node:test";
import { containsLikelySecret, redactSecrets } from "./secret-scrubber.js";

test("redacts namespaced, quoted, spaced, and lowercase secret assignments", () => {
  const source = [
    "HERMES_DASHBOARD_SESSION_TOKEN=dashboard-example-value",
    "OPENAI_API_KEY = 'openai-example-value'",
    '"AWS_SECRET_ACCESS_KEY": "aws-example-secret-value"',
    "database_password = database-example-value",
    "service_secret: service-example-value",
    "github.token = github-example-value",
    "accessToken = camel-token-example-value",
    "clientSecret = camel-secret-example-value",
    "unfinished_token = 'unfinished-example-value",
  ].join("\n");

  const result = redactSecrets(source);

  assert.equal(result.redacted, true);
  assert.equal(result.value, [
    "HERMES_DASHBOARD_SESSION_TOKEN=[REDACTED]",
    "OPENAI_API_KEY = '[REDACTED]'",
    '"AWS_SECRET_ACCESS_KEY": "[REDACTED]"',
    "database_password = [REDACTED]",
    "service_secret: [REDACTED]",
    "github.token = [REDACTED]",
    "accessToken = [REDACTED]",
    "clientSecret = [REDACTED]",
    "unfinished_token = '[REDACTED]",
  ].join("\n"));
  assert.equal(containsLikelySecret(source), true);
  assert.equal(containsLikelySecret("token budget = 4096\nsecretary = enabled"), false);
});

test("retains URL query, Bearer, private-key, and ANSI protections", () => {
  const source = [
    "https://example.test/?access_token=query-example-value&mode=safe",
    "Authorization: Bearer bearer-example-value-123456",
    "-----BEGIN PRIVATE KEY-----\nprivate-example-value\n-----END PRIVATE KEY-----",
    "\u001b[31mwarning\u001b[0m",
  ].join("\n");

  const result = redactSecrets(source);

  assert.equal(result.redacted, true);
  assert.equal(result.value.includes("query-example-value"), false);
  assert.equal(result.value.includes("bearer-example-value"), false);
  assert.equal(result.value.includes("private-example-value"), false);
  assert.equal(result.value.includes("\u001b"), false);
  assert.match(result.value, /access_token=\[REDACTED\]/);
  assert.match(result.value, /Bearer \[REDACTED\]/);
  assert.match(result.value, /\[REDACTED PRIVATE KEY\]/);
});
