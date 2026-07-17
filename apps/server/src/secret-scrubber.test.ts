import assert from "node:assert/strict";
import test from "node:test";
import { containsLikelySecret, isLikelySecretIdentifier, redactSecrets } from "./secret-scrubber.js";

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
  assert.match(result.value, /access_token=\[REDACTED\]&mode=safe/);
  assert.doesNotMatch(result.value, /\[REDACTED\]\]/);
  assert.match(result.value, /Bearer \[REDACTED\]/);
  assert.match(result.value, /\[REDACTED PRIVATE KEY\]/);
});

test("redacts short explicit assignments, Basic auth, and HTTP URL userinfo", () => {
  const source = [
    "password=x",
    "note: API_KEY='short7'",
    'wrapper: "clientSecret=abc"',
    "Authorization: Basic dXNlcjpwYXNz",
    "Proxy-Authorization: Basic cHJveHk6cGFzcw==",
    "https://operator:tiny@example.test/private?mode=safe",
  ].join("\n");

  const result = redactSecrets(source);

  assert.equal(result.redacted, true);
  assert.equal(result.value, [
    "password=[REDACTED]",
    "note: API_KEY='[REDACTED]'",
    'wrapper: "clientSecret=[REDACTED]"',
    "Authorization: Basic [REDACTED]",
    "Proxy-Authorization: Basic [REDACTED]",
    "https://[REDACTED]:[REDACTED]@example.test/private?mode=safe",
  ].join("\n"));
  for (const line of source.split("\n")) assert.equal(containsLikelySecret(line), true);
});

test("redacts high-confidence standalone provider credentials", () => {
  const credentials = [
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghij",
    "AKIAABCDEFGHIJKLMNOP",
    "ASIAABCDEFGHIJKLMNOP",
    "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    "xoxb-" + "123456789012-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "sk_" + "live_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ];
  const source = credentials.map((credential) => `value ${credential} end`).join("\n");
  const result = redactSecrets(source);

  assert.equal(result.redacted, true);
  assert.equal(result.value, credentials.map(() => "value [REDACTED] end").join("\n"));
  for (const credential of credentials) assert.equal(containsLikelySecret(credential), true);
});

test("rescans nested assignments instead of letting an outer label hide a secret", () => {
  const source = [
    "note: HERMES_DASHBOARD_SESSION_TOKEN=dashboard-example-value",
    "credential: OPENAI_API_KEY=openai-example-value",
    "status=clientSecret=client-example-value",
    'wrapper: "database_password=database-example-value"',
    "https://example.test/?session_token=session-example-value&mode=safe",
  ].join("\n");

  const result = redactSecrets(source);

  assert.equal(result.redacted, true);
  assert.equal(result.value, [
    "note: HERMES_DASHBOARD_SESSION_TOKEN=[REDACTED]",
    "credential: [REDACTED]",
    "status=clientSecret=[REDACTED]",
    'wrapper: "database_password=[REDACTED]"',
    "https://example.test/?session_token=[REDACTED]&mode=safe",
  ].join("\n"));
  for (const line of source.split("\n")) assert.equal(containsLikelySecret(line), true);
});

test("does not treat token metadata or nonsecret prose identifiers as credentials", () => {
  const source = [
    "token_count = 12345678",
    "token_limit = 87654321",
    "accessTokenTtl = 86400000",
    "nonsecret = abcdefgh",
    "secretary = enabled-value",
    "examples = sk-short, ghp_fixture, AKIAEXAMPLE",
  ].join("\n");

  assert.deepEqual(redactSecrets(source), { value: source, redacted: false });
  assert.equal(containsLikelySecret(source), false);
  for (const secret of [
    "accessToken = access-example-value",
    "clientSecret = client-example-value",
    "database_password = database-example-value",
    "AWS_SECRET_ACCESS_KEY = aws-example-value",
  ]) assert.equal(containsLikelySecret(secret), true);
  assert.equal(isLikelySecretIdentifier("api_key"), true);
  assert.equal(isLikelySecretIdentifier("clientSecret"), true);
  assert.equal(isLikelySecretIdentifier("token_count"), false);
  for (const identifier of [
    "private_key", "aws.accessKey", "signing-key", "encryptionKey", "credential",
    "serviceAuthorization", "session.key",
  ]) assert.equal(isLikelySecretIdentifier(identifier), true, identifier);
  for (const metadata of ["private_key_name", "accessKeyCount", "authorization_status", "session-key-ttl"]) {
    assert.equal(isLikelySecretIdentifier(metadata), false, metadata);
  }
});

test("redaction is idempotent for query and assignment placeholders", () => {
  const source = [
    "https://example.test/?token=query-example-value&mode=safe",
    "OPENAI_API_KEY=openai-example-value",
    'clientSecret = "client-example-value"',
    "session_token=[REDACTED]actual-secret-value",
  ].join("\n");

  const once = redactSecrets(source);
  const twice = redactSecrets(once.value);

  assert.equal(once.value, [
    "https://example.test/?token=[REDACTED]&mode=safe",
    "OPENAI_API_KEY=[REDACTED]",
    'clientSecret = "[REDACTED]"',
    "session_token=[REDACTED]",
  ].join("\n"));
  assert.equal(twice.value, once.value);
  assert.equal(twice.redacted, false);
});

test("long non-sensitive assignment chains remain unchanged with bounded header scanning", () => {
  const source = `${"note:".repeat(32_768)}safe-value`;
  assert.deepEqual(redactSecrets(source), { value: source, redacted: false });
  assert.equal(containsLikelySecret(source), false);
});
