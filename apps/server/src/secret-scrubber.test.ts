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

test("retains URL query, authorization-header, private-key, and ANSI protections", () => {
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
  assert.match(result.value, /Authorization: \[REDACTED\]/);
  assert.match(result.value, /\[REDACTED PRIVATE KEY\]/);
});

test("ANSI normalization alone is not classified as credential material", () => {
  const decoratedProse = "\u001b[31mwarning\u001b[0m";
  const decoratedSecret = "\u001b[33mAPI_KEY=credential-value\u001b[0m";

  assert.deepEqual(redactSecrets(decoratedProse), { value: "warning", redacted: true });
  assert.equal(containsLikelySecret(decoratedProse), false);
  assert.equal(containsLikelySecret(decoratedSecret), true);
});

test("ECMA-48 strings cannot split secret labels or values", () => {
  const oscBel = "\u001b]0;window title\u0007";
  const oscSt = "\u001b]8;;https://example.test\u001b\\";
  const c1Osc = "\u009d0;c1 title\u009c";
  const dcs = "\u001bP1;2|ignored device control\u001b\\";
  const source = [
    `API${oscBel}_KEY=osc-label-secret`,
    `Coo${oscSt}kie: session=osc-cookie-secret`,
    `client${c1Osc}Secret=c1-label-secret`,
    `password=cred${oscBel}ential`,
    `access\u001b[31mToken=csi-label-secret`,
    `signing_${dcs}key=dcs-label-secret`,
    `ghp_ABCDEFGHIJKLMNO${oscSt}PQRSTUVWXYZabcdefghij`,
    `{"Coo${c1Osc}kie":"session=json-cookie-secret","safe":true}`,
  ].join("\n");

  const once = redactSecrets(source);
  const twice = redactSecrets(once.value);
  assert.equal(once.value, [
    "API_KEY=[REDACTED]",
    "Cookie: [REDACTED]",
    "clientSecret=[REDACTED]",
    "password=[REDACTED]",
    "accessToken=[REDACTED]",
    "signing_key=[REDACTED]",
    "[REDACTED]",
    '{"Cookie":"[REDACTED]","safe":true}',
  ].join("\n"));
  for (const line of source.split("\n")) assert.equal(containsLikelySecret(line), true);
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(once.value), false);
  assert.deepEqual(twice, { value: once.value, redacted: false });
});

test("well-formed terminal normalization alone stays non-secret and idempotent", () => {
  const source = [
    "safe\u001b]0;window title\u0007 prose",
    "safe\u001b]8;;https://example.test\u001b\\ link",
    "safe\u001bP1;2|device control\u001b\\ text",
    "safe\u009d0;c1 title\u009c text",
  ].join("\n");
  const normalized = ["safe prose", "safe link", "safe text", "safe text"].join("\n");

  assert.equal(containsLikelySecret(source), false);
  assert.deepEqual(redactSecrets(source), { value: normalized, redacted: true });
  assert.deepEqual(redactSecrets(normalized), { value: normalized, redacted: false });
});

test("unterminated and overlong terminal strings fail closed in linear scans", () => {
  const longPayload = "x".repeat(128 * 1024);
  const unterminated = `safe-prefix API\u001b]0;${longPayload}_KEY=buried-secret`;
  const overlong = `API\u001b]0;${longPayload}\u0007_KEY=overlong-secret`;
  const malformedCsi = "API\u001b[\u001b[X_KEY=malformed-csi-secret";

  const unterminatedResult = redactSecrets(unterminated);
  const overlongResult = redactSecrets(overlong);
  assert.deepEqual(unterminatedResult, { value: "[REDACTED TERMINAL DATA]", redacted: true });
  assert.deepEqual(overlongResult, { value: "[REDACTED TERMINAL DATA]", redacted: true });
  assert.deepEqual(redactSecrets(malformedCsi), { value: "[REDACTED TERMINAL DATA]", redacted: true });
  assert.equal(unterminatedResult.value.includes("buried-secret"), false);
  assert.equal(overlongResult.value.includes("overlong-secret"), false);
  assert.equal(containsLikelySecret(unterminated), true);
  assert.equal(containsLikelySecret(overlong), true);
  assert.equal(containsLikelySecret(malformedCsi), true);
  assert.deepEqual(redactSecrets(unterminatedResult.value), { value: unterminatedResult.value, redacted: false });
  assert.deepEqual(redactSecrets(overlongResult.value), { value: overlongResult.value, redacted: false });
});

test("terminal string length boundary is explicit and fail-closed", () => {
  const atLimit = `safe\u001b]${"x".repeat(8_189)}\u0007text`;
  const beyondLimit = `safe\u001b]${"x".repeat(8_190)}\u0007text`;

  assert.deepEqual(redactSecrets(atLimit), { value: "safetext", redacted: true });
  assert.equal(containsLikelySecret(atLimit), false);
  assert.deepEqual(redactSecrets(beyondLimit), { value: "[REDACTED TERMINAL DATA]", redacted: true });
  assert.equal(containsLikelySecret(beyondLimit), true);
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
    "Authorization: [REDACTED]",
    "Proxy-Authorization: [REDACTED]",
    "https://[REDACTED]:[REDACTED]@example.test/private?mode=safe",
  ].join("\n"));
  for (const line of source.split("\n")) assert.equal(containsLikelySecret(line), true);
});

test("redacts complete authorization header values independent of scheme or length", () => {
  const source = [
    "Authorization: Bearer abc123",
    "authorization:\tToken opaque-service-credential",
    "Authorization: Digest username=operator, response=tiny",
    "Authorization: [REDACTED] trailing-secret",
    "Proxy-Authorization: Custom x",
    "trace Authorization=Token equal-secret",
    "> Proxy-Authorization: Scheme prefixed-secret",
    "X-Authorization: extension-credential",
    "Authorization:",
    "next-line-safe",
  ].join("\n");

  const once = redactSecrets(source);
  const twice = redactSecrets(once.value);

  assert.equal(once.redacted, true);
  assert.equal(once.value, [
    "Authorization: [REDACTED]",
    "authorization:\t[REDACTED]",
    "Authorization: [REDACTED]",
    "Authorization: [REDACTED]",
    "Proxy-Authorization: [REDACTED]",
    "trace Authorization=[REDACTED]",
    "> Proxy-Authorization: [REDACTED]",
    "X-Authorization: [REDACTED]",
    "Authorization:",
    "next-line-safe",
  ].join("\n"));
  for (const secret of ["abc123", "opaque-service-credential", "response=tiny", "trailing-secret", "Custom x", "equal-secret", "prefixed-secret", "extension-credential"]) {
    assert.equal(once.value.includes(secret), false);
  }
  assert.deepEqual(twice, { value: once.value, redacted: false });
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

test("redacts complete cookie, credential URI, Google API key, and JWT containers", () => {
  const googleKey = ["AIza", "SyA12345678901234567890123456789012"].join("");
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "signature0123456789"].join(".");
  const source = [
    "Cookie: hermes_office_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; theme=light",
    "Set-Cookie: sessionid=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB; HttpOnly; Secure",
    "postgresql://alice:database-password@example.test/app",
    "redis://default:cache-password@example.test:6379/0",
    "rediss://:password-without-username@example.test:6380/0",
    googleKey,
    jwt,
    "hermes_office_session=office-session-value",
    "hermes.office.device: office device value",
  ].join("\n");

  const once = redactSecrets(source);
  const twice = redactSecrets(once.value);

  assert.equal(once.value, [
    "Cookie: [REDACTED]",
    "Set-Cookie: [REDACTED]",
    "postgresql://[REDACTED]:[REDACTED]@example.test/app",
    "redis://[REDACTED]:[REDACTED]@example.test:6379/0",
    "rediss://[REDACTED]:[REDACTED]@example.test:6380/0",
    "[REDACTED]",
    "[REDACTED]",
    "hermes_office_session=[REDACTED]",
    "hermes.office.device: [REDACTED]",
  ].join("\n"));
  for (const secret of [googleKey, jwt, "database-password", "cache-password", "password-without-username", "office-session-value", "office device value"]) {
    assert.equal(once.value.includes(secret), false);
  }
  assert.deepEqual(twice, { value: once.value, redacted: false });
});

test("redacts cookie headers at shell and browser log boundaries without consuming adjacent text", () => {
  const source = [
    "curl -H 'Cookie: session=quoted-secret; theme=light' https://example.test/safe",
    'curl -H "Set-Cookie: session=double-secret; HttpOnly" --verbose',
    "curl -H ' Cookie: session=spaced-secret' --next-safe",
    "> Cookie: browser-request-secret; theme=dark",
    "< Set-Cookie: browser-response-secret; Secure",
    "trace |Cookie: pipe-secret",
    "X-Cookie: visible-extension=value",
    "prefix-X-Cookie: also-visible=value",
  ].join("\r\n");

  const once = redactSecrets(source);
  const twice = redactSecrets(once.value);

  assert.equal(once.value, [
    "curl -H 'Cookie: [REDACTED]' https://example.test/safe",
    'curl -H "Set-Cookie: [REDACTED]" --verbose',
    "curl -H ' Cookie: [REDACTED]' --next-safe",
    "> Cookie: [REDACTED]",
    "< Set-Cookie: [REDACTED]",
    "trace |Cookie: [REDACTED]",
    "X-Cookie: visible-extension=value",
    "prefix-X-Cookie: also-visible=value",
  ].join("\r\n"));
  for (const secret of ["quoted-secret", "double-secret", "spaced-secret", "browser-request-secret", "browser-response-secret", "pipe-secret"]) {
    assert.equal(once.value.includes(secret), false);
  }
  for (const safe of ["https://example.test/safe", "--verbose", "--next-safe", "visible-extension=value", "also-visible=value"]) {
    assert.equal(once.value.includes(safe), true);
  }
  assert.deepEqual(twice, { value: once.value, redacted: false });
});

test("redacts quoted JSON cookie values without consuming adjacent fields", () => {
  const source = [
    '{"Cookie":"session=json-secret; theme=light","safe":"visible"}',
    '{"Set-Cookie": "session=escaped-\\\"secret; Secure", "count": 2}',
    '  "Cookie": "pretty-json-secret",',
    '{"X-Cookie":"extension-visible","Cookie":"[REDACTED]","after":true}',
  ].join("\n");

  const once = redactSecrets(source);
  const twice = redactSecrets(once.value);

  assert.equal(once.value, [
    '{"Cookie":"[REDACTED]","safe":"visible"}',
    '{"Set-Cookie": "[REDACTED]", "count": 2}',
    '  "Cookie": "[REDACTED]",',
    '{"X-Cookie":"extension-visible","Cookie":"[REDACTED]","after":true}',
  ].join("\n"));
  for (const secret of ["json-secret", "escaped-", "secret; Secure", "pretty-json-secret"]) assert.equal(once.value.includes(secret), false);
  for (const safe of ['"safe":"visible"', '"count": 2', '"X-Cookie":"extension-visible"', '"after":true']) {
    assert.equal(once.value.includes(safe), true);
  }
  assert.deepEqual(twice, { value: once.value, redacted: false });
});

test("redacts cookie values across valid pretty-JSON line breaks", () => {
  const source = [
    "{",
    '  "Cookie"',
    "  :",
    '  "session=multiline-cookie; theme=dark",',
    '  "safe": "visible",',
    '  "Set-Cookie"',
    "  :",
    '  "session=multiline-set-cookie; Secure",',
    '  "X-Cookie": "extension-visible"',
    "}",
  ].join("\r\n");

  assert.doesNotThrow(() => JSON.parse(source));
  const once = redactSecrets(source);
  const twice = redactSecrets(once.value);
  assert.deepEqual(JSON.parse(once.value), {
    Cookie: "[REDACTED]",
    safe: "visible",
    "Set-Cookie": "[REDACTED]",
    "X-Cookie": "extension-visible",
  });
  assert.equal(once.value.includes("multiline-cookie"), false);
  assert.equal(once.value.includes("multiline-set-cookie"), false);
  assert.deepEqual(twice, { value: once.value, redacted: false });
});

test("redacts complete line and YAML block scalars without consuming adjacent safe fields", () => {
  const source = [
    "password: correct horse battery staple",
    "safe_field: visible words",
    "nested:",
    "  api_key: >-",
    "    folded secret line",
    "    second secret line",
    "  safe: still visible",
    "signing_key: | # credential material",
    "  literal secret line",
    "safe_after: visible",
    "shell_secret=first-token remaining safe prose",
  ].join("\r\n");

  const once = redactSecrets(source);
  const twice = redactSecrets(once.value);

  assert.equal(once.value, [
    "password: [REDACTED]",
    "safe_field: visible words",
    "nested:",
    "  api_key: [REDACTED]",
    "  safe: still visible",
    "signing_key: [REDACTED]",
    "safe_after: visible",
    "shell_secret=[REDACTED] remaining safe prose",
  ].join("\r\n"));
  for (const secret of ["correct horse battery staple", "folded secret line", "second secret line", "literal secret line", "first-token"]) {
    assert.equal(once.value.includes(secret), false);
  }
  for (const safe of ["safe_field: visible words", "safe: still visible", "safe_after: visible", "remaining safe prose"]) {
    assert.equal(once.value.includes(safe), true);
  }
  assert.deepEqual(twice, { value: once.value, redacted: false });
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
    "X-Cookie: theme=light",
    "postgresql://alice@example.test/app",
    "examples = AIza-short eyJheader.payload",
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
    "Authorization: [REDACTED] trailing-secret-value",
  ].join("\n");

  const once = redactSecrets(source);
  const twice = redactSecrets(once.value);

  assert.equal(once.value, [
    "https://example.test/?token=[REDACTED]&mode=safe",
    "OPENAI_API_KEY=[REDACTED]",
    'clientSecret = "[REDACTED]"',
    "session_token=[REDACTED]",
    "Authorization: [REDACTED]",
  ].join("\n"));
  assert.equal(twice.value, once.value);
  assert.equal(twice.redacted, false);
});

test("long non-sensitive assignment chains remain unchanged with bounded header scanning", () => {
  const source = `${"note:".repeat(32_768)}safe-value`;
  assert.deepEqual(redactSecrets(source), { value: source, redacted: false });
  assert.equal(containsLikelySecret(source), false);
});
