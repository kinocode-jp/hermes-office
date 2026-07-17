export interface SecretRedaction {
  value: string;
  redacted: boolean;
}

const ESCAPE = 0x1b;
const STRING_TERMINATOR = 0x9c;
const MAX_TERMINAL_SEQUENCE_LENGTH = 8_192;
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/gu;
const REDACTED_UNICODE_DATA = "[REDACTED UNICODE DATA]";
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const AUTHORIZATION_HEADER_PATTERN = /^([ \t]*(?:Authorization|Proxy-Authorization)[ \t]*:[ \t]*)([^\r\n]*)/gim;
const JSON_COOKIE_HEADER_PATTERN = /(^[ \t]*|[{,]\s*)(["'])((?:Cookie|Set-Cookie))\2(\s*:\s*)(["'])/gim;
const COOKIE_HEADER_PATTERN = /(^|[ \t"'`<>|])((?:Cookie|Set-Cookie)[ \t]*:[ \t]*)/gim;
const URL_USERINFO_PATTERN = /((?:https?|postgres(?:ql)?|rediss?|mysql|mariadb|mongodb(?:\+srv)?|amqps?|ftps?|smtps?|imaps?|ldaps?):\/\/)[^/?#\s@:]*:[^/?#\s@]+@/gi;
const QUERY_SECRET_PATTERN = /([?&](?:access_token|api_?key|password|secret|token)=)[^&#\s]+/gi;
const GOOGLE_API_KEY_PATTERN = /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;
const KNOWN_CREDENTIAL_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[a-z]-[A-Za-z0-9-]{20,}|sk_live_[A-Za-z0-9]{16,})\b/g;
const ASSIGNMENT_HEADER_PATTERN = /(^|[^A-Za-z0-9_])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2([ \t]*[:=][ \t]*)/gim;
const BENIGN_METADATA_SEGMENTS = new Set([
  "age", "configured", "count", "enabled", "expires", "expiry", "kind",
  "length", "limit", "name", "present", "set", "size", "status", "ttl", "type",
]);

/** Redact credential-shaped text before it crosses an Office trust boundary. */
export function redactSecrets(value: string): SecretRedaction {
  const normalized = normalizeTerminalText(value);
  if (normalized.malformed) {
    // A malformed or deliberately overlong terminal sequence has ambiguous
    // display boundaries. Drop the complete field rather than risk exposing
    // credential text that a terminal could hide or reinterpret.
    return { value: "[REDACTED TERMINAL DATA]", redacted: value !== "[REDACTED TERMINAL DATA]" };
  }
  const shadow = unicodeIgnorableShadow(normalized.value);
  if (shadow !== undefined && redactCredentialMaterial(shadow) !== shadow) {
    // Unicode default-ignorable characters include zero-width joiners, bidi
    // controls, variation selectors, and tag characters. They are legitimate
    // in normal prose, so preserve them unless removing them reveals credential
    // material. In that case index mapping is intentionally avoided: dropping
    // the complete field is safer than returning an obfuscated secret.
    return { value: REDACTED_UNICODE_DATA, redacted: value !== REDACTED_UNICODE_DATA };
  }
  const output = redactCredentialMaterial(normalized.value);
  return { value: output, redacted: output !== value };
}

interface TerminalNormalization {
  value: string;
  malformed: boolean;
}

interface TerminalSequence {
  end: number;
  malformed: boolean;
}

function normalizeTerminalText(value: string): TerminalNormalization {
  const chunks: string[] = [];
  let copiedUntil = 0;
  let cursor = 0;
  let malformed = false;
  while (cursor < value.length) {
    const sequence = terminalSequenceAt(value, cursor);
    if (sequence === undefined) { cursor += 1; continue; }
    if (copiedUntil < cursor) chunks.push(value.slice(copiedUntil, cursor));
    malformed ||= sequence.malformed;
    cursor = Math.max(cursor + 1, sequence.end);
    copiedUntil = cursor;
  }
  if (copiedUntil < value.length) chunks.push(value.slice(copiedUntil));
  return { value: chunks.join(""), malformed };
}

function terminalSequenceAt(value: string, start: number): TerminalSequence | undefined {
  const code = value.charCodeAt(start);
  if (code === ESCAPE) return escapeSequenceEnd(value, start);
  if (code === 0x9b) return controlSequenceEnd(value, start, start + 1);
  if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
    return terminalStringEnd(value, start, start + 1, code === 0x9d);
  }
  if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
    return { end: start + 1, malformed: false };
  }
  return undefined;
}

function escapeSequenceEnd(value: string, start: number): TerminalSequence {
  const next = value.charCodeAt(start + 1);
  if (!Number.isFinite(next)) return { end: start + 1, malformed: true };
  if (next === 0x5b) return controlSequenceEnd(value, start, start + 2);
  if ([0x50, 0x58, 0x5d, 0x5e, 0x5f].includes(next)) {
    return terminalStringEnd(value, start, start + 2, next === 0x5d);
  }
  if (next === 0x5c) return { end: start + 2, malformed: false };
  if (next >= 0x30 && next <= 0x7e) return { end: start + 2, malformed: false };
  if (next >= 0x20 && next <= 0x2f) {
    let cursor = start + 2;
    while (cursor < value.length && value.charCodeAt(cursor) >= 0x20 && value.charCodeAt(cursor) <= 0x2f) {
      if (cursor - start >= MAX_TERMINAL_SEQUENCE_LENGTH) return { end: value.length, malformed: true };
      cursor += 1;
    }
    const final = value.charCodeAt(cursor);
    return Number.isFinite(final) && final >= 0x30 && final <= 0x7e
      ? { end: cursor + 1, malformed: cursor + 1 - start > MAX_TERMINAL_SEQUENCE_LENGTH }
      : { end: cursor, malformed: true };
  }
  return { end: start + 1, malformed: true };
}

function controlSequenceEnd(value: string, sequenceStart: number, contentStart: number): TerminalSequence {
  let cursor = contentStart;
  let intermediate = false;
  let malformed = false;
  while (cursor < value.length) {
    if (cursor - sequenceStart >= MAX_TERMINAL_SEQUENCE_LENGTH) return { end: value.length, malformed: true };
    const code = value.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) {
      const end = cursor + 1;
      return { end, malformed: malformed || end - sequenceStart > MAX_TERMINAL_SEQUENCE_LENGTH };
    }
    if (code >= 0x20 && code <= 0x2f) intermediate = true;
    else if (code < 0x30 || code > 0x3f || intermediate) malformed = true;
    cursor += 1;
  }
  return { end: value.length, malformed: true };
}

function terminalStringEnd(value: string, sequenceStart: number, contentStart: number, belTerminates: boolean): TerminalSequence {
  let cursor = contentStart;
  while (cursor < value.length) {
    if (cursor - sequenceStart >= MAX_TERMINAL_SEQUENCE_LENGTH) return { end: value.length, malformed: true };
    const code = value.charCodeAt(cursor);
    if ((belTerminates && code === 0x07) || code === STRING_TERMINATOR) {
      const end = cursor + 1;
      return { end, malformed: end - sequenceStart > MAX_TERMINAL_SEQUENCE_LENGTH };
    }
    if (code === ESCAPE && value.charCodeAt(cursor + 1) === 0x5c) {
      const end = cursor + 2;
      return { end, malformed: end - sequenceStart > MAX_TERMINAL_SEQUENCE_LENGTH };
    }
    cursor += 1;
  }
  return { end: value.length, malformed: true };
}

function redactCredentialMaterial(value: string): string {
  let output = value
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]")
    .replace(AUTHORIZATION_HEADER_PATTERN, (line: string, prefix: string, headerValue: string) =>
      headerValue.length === 0 ? line : `${prefix}[REDACTED]`)
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(URL_USERINFO_PATTERN, "$1[REDACTED]:[REDACTED]@")
    .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]")
    .replace(GOOGLE_API_KEY_PATTERN, "[REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED]")
    .replace(KNOWN_CREDENTIAL_PATTERN, "[REDACTED]");
  output = redactJsonCookieHeaders(output);
  output = redactCookieHeaders(output);
  output = redactSensitiveAssignments(output);
  return output;
}

function redactJsonCookieHeaders(value: string): string {
  let copiedUntil = 0;
  let output = "";
  JSON_COOKIE_HEADER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_COOKIE_HEADER_PATTERN.exec(value)) !== null) {
    const openingQuote = match[5]!;
    const valueStart = match.index + match[0].length;
    const valueEnd = cookieHeaderValueEnd(value, valueStart, openingQuote);
    if (valueEnd === valueStart) continue;
    output += value.slice(copiedUntil, valueStart);
    output += "[REDACTED]";
    copiedUntil = valueEnd;
    JSON_COOKIE_HEADER_PATTERN.lastIndex = valueEnd;
  }
  JSON_COOKIE_HEADER_PATTERN.lastIndex = 0;
  return `${output}${value.slice(copiedUntil)}`;
}

function redactCookieHeaders(value: string): string {
  let copiedUntil = 0;
  let output = "";
  COOKIE_HEADER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COOKIE_HEADER_PATTERN.exec(value)) !== null) {
    const [whole, boundary = ""] = match;
    const valueStart = match.index + whole.length;
    const valueEnd = cookieHeaderValueEnd(value, valueStart, cookieHeaderQuote(value, match.index, boundary));
    if (valueEnd === valueStart) continue;
    output += value.slice(copiedUntil, valueStart);
    output += "[REDACTED]";
    copiedUntil = valueEnd;
    COOKIE_HEADER_PATTERN.lastIndex = valueEnd;
  }
  COOKIE_HEADER_PATTERN.lastIndex = 0;
  return `${output}${value.slice(copiedUntil)}`;
}

function cookieHeaderQuote(value: string, boundaryIndex: number, boundary: string): string | undefined {
  if (boundary === "\"" || boundary === "'" || boundary === "`") return boundary;
  if (boundary !== " " && boundary !== "\t") return undefined;
  let cursor = boundaryIndex;
  while (cursor >= 0 && (value[cursor] === " " || value[cursor] === "\t")) cursor -= 1;
  const candidate = value[cursor];
  return candidate === "\"" || candidate === "'" || candidate === "`" ? candidate : undefined;
}

function cookieHeaderValueEnd(value: string, start: number, quote: string | undefined): number {
  let end = start;
  while (end < value.length && value[end] !== "\r" && value[end] !== "\n") {
    if (quote !== undefined && value[end] === "\\" && end + 1 < value.length) { end += 2; continue; }
    if (quote !== undefined && value[end] === quote) break;
    end += 1;
  }
  return end;
}

/** Detect secret material on input surfaces that must reject rather than redact. */
export function containsLikelySecret(value: string): boolean {
  const normalized = normalizeTerminalText(value);
  if (normalized.malformed || redactCredentialMaterial(normalized.value) !== normalized.value) return true;
  const shadow = unicodeIgnorableShadow(normalized.value);
  return shadow !== undefined && redactCredentialMaterial(shadow) !== shadow;
}

function unicodeIgnorableShadow(value: string): string | undefined {
  // One non-backtracking Unicode property replacement keeps this scan linear
  // in the UTF-16 input length and allocates no shadow for ordinary text.
  const shadow = value.replace(DEFAULT_IGNORABLE_PATTERN, "");
  return shadow === value ? undefined : shadow;
}

export function isLikelySecretIdentifier(identifier: string): boolean {
  const segments = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_.-]+/)
    .filter(Boolean);
  if (["hermes_office_device", "hermes_office_session"].includes(segments.join("_"))) return true;
  return segments.some((segment, index) => {
    const next = segments[index + 1];
    const sensitiveLength = next === "key" && ["access", "api", "encryption", "private", "session", "signing"].includes(segment)
      ? 2
      : ["apikey", "authorization", "credential", "credentials", "password", "secret", "token"].includes(segment) ? 1 : 0;
    if (sensitiveLength === 0) return false;
    const trailing = segments.slice(index + sensitiveLength);
    return trailing.length === 0 || !trailing.every((item) => BENIGN_METADATA_SEGMENTS.has(item));
  });
}

function redactSensitiveAssignments(value: string): string {
  let copiedUntil = 0;
  let output = "";
  let lineStart = 0;
  let lineScanOffset = 0;
  let lineHasOnlyIndent = true;
  ASSIGNMENT_HEADER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ASSIGNMENT_HEADER_PATTERN.exec(value)) !== null) {
    const [whole, leading = "", , identifier = "", separator = ""] = match;
    if (!isLikelySecretIdentifier(identifier)) {
      // Restart at the one-character operator so an immediately nested key in
      // `status=clientSecret=...` still sees a non-identifier prefix. Only the
      // small header is revisited; long values are never repeatedly consumed.
      const operatorOffset = separator.search(/[:=]/);
      ASSIGNMENT_HEADER_PATTERN.lastIndex = match.index + whole.length - separator.length
        + Math.max(0, operatorOffset);
      continue;
    }
    const keyStart = match.index + leading.length;
    while (lineScanOffset < keyStart) {
      const character = value[lineScanOffset];
      if (character === "\r" || character === "\n") {
        lineStart = lineScanOffset + 1;
        lineHasOnlyIndent = true;
      } else if (character !== " " && character !== "\t") {
        lineHasOnlyIndent = false;
      }
      lineScanOffset += 1;
    }
    const lineIndent = separator.includes(":") && lineHasOnlyIndent ? keyStart - lineStart : undefined;
    const assigned = assignedValueRange(
      value,
      match.index + whole.length,
      isAuthorizationIdentifier(identifier),
      lineIndent,
    );
    if (assigned === undefined) continue;
    ASSIGNMENT_HEADER_PATTERN.lastIndex = assigned.end;
    if (assigned.canonical) continue;
    output += value.slice(copiedUntil, assigned.start);
    output += "[REDACTED]";
    copiedUntil = assigned.end;
  }
  ASSIGNMENT_HEADER_PATTERN.lastIndex = 0;
  return `${output}${value.slice(copiedUntil)}`;
}

function assignedValueRange(
  value: string,
  start: number,
  consumeLine = false,
  lineIndent: number | undefined = undefined,
): { start: number; end: number; canonical: boolean } | undefined {
  const quote = value[start];
  if (quote === '"' || quote === "'") {
    let end = start + 1;
    while (end < value.length && value[end] !== "\r" && value[end] !== "\n") {
      if (value[end] === "\\" && end + 1 < value.length) { end += 2; continue; }
      if (value[end] === quote) break;
      end += 1;
    }
    const contentStart = start + 1;
    if (end === contentStart) return undefined;
    const content = value.slice(contentStart, end);
    return {
      start: contentStart,
      end,
      canonical: content === "[REDACTED]" || content === "[REDACTED PRIVATE KEY]",
    };
  }
  if (consumeLine || lineIndent !== undefined) {
    let end = start;
    while (end < value.length && value[end] !== "\r" && value[end] !== "\n") end += 1;
    if (end === start) return undefined;
    if (lineIndent !== undefined && isYamlBlockMarker(value.slice(start, end))) {
      end = yamlBlockValueEnd(value, end, lineIndent);
    }
    const content = value.slice(start, end);
    return {
      start,
      end,
      canonical: ["[REDACTED]", "[REDACTED PRIVATE KEY]"].includes(content.trimEnd()),
    };
  }
  for (const placeholder of ["Bearer [REDACTED]", "Basic [REDACTED]"]) {
    if (value.startsWith(placeholder, start)) {
      const placeholderEnd = start + placeholder.length;
      if (isAssignedValueBoundary(value[placeholderEnd])) {
        return { start, end: placeholderEnd, canonical: true };
      }
    }
  }
  for (const placeholder of ["[REDACTED]", "[REDACTED PRIVATE KEY]"]) {
    if (value.startsWith(placeholder, start)) {
      const placeholderEnd = start + placeholder.length;
      if (isAssignedValueBoundary(value[placeholderEnd])) {
        return { start, end: placeholderEnd, canonical: true };
      }
      // A placeholder is canonical only when it is the complete value. Treat
      // `[REDACTED]actual-secret` as one non-canonical value rather than letting
      // the visible marker become a prefix-based bypass.
      let end = placeholderEnd;
      while (end < value.length && !/[\s,;&#}"']/.test(value[end] ?? "")) end += 1;
      return { start, end, canonical: false };
    }
  }
  let end = start;
  while (end < value.length && !/[\s,;&#}\]"']/.test(value[end] ?? "")) end += 1;
  if (end === start) return undefined;
  return { start, end, canonical: false };
}

function isYamlBlockMarker(value: string): boolean {
  return /^[>|](?:(?:[1-9][+-]?)|(?:[+-][1-9]?))?[ \t]*(?:#.*)?$/.test(value);
}

function yamlBlockValueEnd(value: string, markerEnd: number, keyIndent: number): number {
  let cursor = skipLineEnding(value, markerEnd);
  let end = markerEnd;
  while (cursor < value.length) {
    let lineEnd = cursor;
    while (lineEnd < value.length && value[lineEnd] !== "\r" && value[lineEnd] !== "\n") lineEnd += 1;
    const line = value.slice(cursor, lineEnd);
    const indentation = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (line.trim().length > 0 && indentation <= keyIndent) break;
    end = lineEnd;
    cursor = skipLineEnding(value, lineEnd);
  }
  return end;
}

function skipLineEnding(value: string, index: number): number {
  if (value[index] === "\r" && value[index + 1] === "\n") return index + 2;
  if (value[index] === "\r" || value[index] === "\n") return index + 1;
  return index;
}

function isAuthorizationIdentifier(identifier: string): boolean {
  const normalized = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[.-]+/g, "_");
  return normalized === "authorization" || normalized === "proxy_authorization";
}

function isAssignedValueBoundary(value: string | undefined): boolean {
  return value === undefined || /[\s,;&#}\]"']/.test(value);
}
