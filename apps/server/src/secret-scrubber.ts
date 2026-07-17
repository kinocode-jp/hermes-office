export interface SecretRedaction {
  value: string;
  redacted: boolean;
}

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const QUERY_SECRET_PATTERN = /([?&](?:access_token|api_?key|password|secret|token)=)[^&#\s]+/gi;
const ASSIGNMENT_PATTERN = /(^|[^A-Za-z0-9_])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*[:=]\s*)("(?:\\.|[^"\\\r\n]){8,}"?|'(?:\\.|[^'\\\r\n]){8,}'?|[^\s,;}\]"']{8,})/gim;

/** Redact credential-shaped text before it crosses an Office trust boundary. */
export function redactSecrets(value: string): SecretRedaction {
  let output = value.replace(ANSI_ESCAPE_PATTERN, "");
  output = output
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]")
    .replace(ASSIGNMENT_PATTERN, (match, prefix: string, keyQuote: string, identifier: string, separator: string, assignedValue: string) => {
      if (!isSensitiveIdentifier(identifier)) return match;
      const valueQuote = assignedValue[0] === '"' || assignedValue[0] === "'" ? assignedValue[0] : "";
      const closingQuote = valueQuote !== "" && assignedValue.at(-1) === valueQuote ? valueQuote : "";
      return `${prefix}${keyQuote}${identifier}${keyQuote}${separator}${valueQuote}[REDACTED]${closingQuote}`;
    });
  return { value: output, redacted: output !== value };
}

/** Detect secret material on input surfaces that must reject rather than redact. */
export function containsLikelySecret(value: string): boolean {
  return redactSecrets(value).redacted;
}

function isSensitiveIdentifier(identifier: string): boolean {
  const segments = identifier.toLowerCase().split(/[_.-]+/).filter(Boolean);
  const sensitiveSuffixes = ["token", "password", "secret", "apikey"];
  if (segments.some((segment) => sensitiveSuffixes.some((suffix) => segment === suffix || segment.endsWith(suffix)))) return true;
  return segments.some((segment, index) => segment === "api" && segments[index + 1] === "key");
}
