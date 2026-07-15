# Security model

## Trust boundaries

Hermes can execute tools with the host user's authority, so a chat message is not merely text input. Hermes Office treats prompts, profile instructions, skills, memory, and Kanban-triggered runs as execution-adjacent data.

The primary trust boundaries are:

1. an untrusted UI process or browser to Office Server;
2. remote ingress to the host machine;
3. Office Server to the Hermes runtime and its tool processes;
4. stored application data to the OS credential store;
5. an installed skill or imported file to the runtime.

Authorization is enforced at Office Server for every request and every WebSocket subscription. Hiding a control in the UI is not authorization.

## Identity and device permissions

Each authenticated user session is bound to a registered device. Device records have one of four increasing tiers:

| Tier | Intended access |
| --- | --- |
| `viewer` | Redacted profiles, sessions, activity, and Kanban state |
| `operator` | Viewer plus chat, cancellation, card updates, and comments |
| `manager` | Operator plus profile, memory, and skill enablement after step-up |
| `owner` | Administration, device revocation, and eligible local-only actions |

The effective authority is the lower of user grant, device grant, deployment policy, and operation policy. Revocation invalidates active sessions and WebSocket tickets. Inactive remote devices expire; owners can inspect last-seen timestamps and revoke them.

Tailscale identity and OIDC establish who connected. They do not establish the permission tier. The first owner is enrolled locally; subsequent device grants are explicit and audited.

## Mutation boundaries

Roles and reachability are independent. Every operation is assigned one boundary in `@hermes-office/protocol`:

- `read-only`: permitted according to tier, with response redaction;
- `remote-safe`: available remotely at the required tier and rate-limited;
- `step-up-required`: requires recent reauthentication in addition to tier;
- `local-only`: requires an owner session and an unforgeable native/local presence proof.

Default high-risk decisions are:

| Action | Boundary | Reason |
| --- | --- | --- |
| Send/cancel chat, edit/comment on cards | Remote-safe | Core remote operation, still audited and rate-limited |
| Edit profile/memory, enable an installed skill | Step-up | Changes future agent behavior |
| Delete profiles, change global settings, revoke devices | Step-up | Broad or destructive impact |
| Install skill, configure/start/stop runtime | Local-only | May introduce or control executable code |
| Write provider secrets | Local-only | Prevent remote credential replacement and exfiltration paths |

Deployments may make a boundary stricter but never weaker without a protocol/security review. An owner connecting remotely cannot call a local-only operation.

Step-up state is short-lived, audience-bound to Office Server, and invalidated after account or device changes. Local presence is proven through a Tauri-issued, single-use challenge over native IPC; loopback source IP alone is insufficient because browsers and local malware can reach loopback.

## Secrets

Provider keys, OIDC client secrets, runtime environment values, refresh tokens, and tunnel credentials remain server-side. They are stored in the OS credential store when available, otherwise in an authenticated encrypted store whose key is outside the database.

The read API exposes only `SecretMetadata`: key name, configured state, and update time. It never returns plaintext, ciphertext, hashes, value length, prefixes, or raw environment variables. Logs, events, crash reports, audit records, exports, and backups use the same rule.

Secret entry is a native, local-only flow. The native shell passes the value to Office Server over a private one-shot channel, clears UI state, and receives only success plus updated metadata. Secret values are never placed in WebSocket events, URLs, command-line arguments, clipboard history, analytics, or persisted browser storage.

Hermes receives only the minimum credentials needed for a run. Child-process environments are constructed from an allowlist rather than inherited wholesale.

## Transport security

### Loopback

The server binds to `127.0.0.1` and `::1` only, preferably on an ephemeral port. Requests require a session even on loopback. Strict origin checks, a narrow CORS policy, CSRF tokens, and WebSocket origin validation prevent hostile websites from driving the service. Bootstrap capabilities are single use, short lived, and transmitted only through Tauri IPC.

### Tailscale

Prefer Tailscale Serve with tailnet TLS. Office Server trusts identity headers only from a configured local proxy or validates identity through the Tailscale local API. It ignores forwarded identity headers from all other peers. Funnel is considered public exposure and therefore requires the public-mode controls.

### Public OIDC

Public access requires TLS 1.2+, a fixed issuer allowlist, Authorization Code plus PKCE, exact redirect URIs, state and nonce checks, and signature/audience/expiry validation. Browser auth uses a backend-for-frontend session cookie; access or refresh tokens are not stored in `localStorage` or exposed to JavaScript.

WebSocket connections use a single-use short-lived ticket obtained through the authenticated HTTP session. Query strings contain no long-lived credentials. Reverse-proxy settings explicitly list trusted hops; arbitrary `Forwarded` or `X-Forwarded-*` values are ignored.

## Request and event protections

- Payload schemas reject unknown discriminants and enforce size limits before Hermes sees data.
- Chat, memory, comments, filenames, Markdown, and tool output are untrusted content. Rendering sanitizes HTML and blocks active URLs by default.
- Mutations use idempotency keys and optimistic revisions. Authorization is checked again when queued work begins.
- Per-device and per-operation rate limits protect prompts, cancellation, login, and step-up endpoints.
- Event subscriptions are filtered by current access. Permission downgrade or revocation closes the stream immediately.
- Tool output and Hermes process logs pass through redaction and bounded buffers before reaching a client.
- File access uses explicit grants and canonicalized paths. The server rejects traversal, symlink escape, device paths, and implicit home-directory access.

## Runtime and skill safety

Managed Hermes artifacts require a pinned version, cryptographic digest, trusted signing source, atomic installation, and rollback. Existing-runtime mode accepts only loopback endpoints and must show the detected version and compatibility result.

Skills are executable supply-chain inputs. Installation is local-only and presents source, version/commit, requested capabilities, integrity information, and changed files. Enabling a previously installed skill is separate from installing it. A global skill grant does not silently override a profile-level denial.

Office animation is derived from normalized activity events. It never parses or executes tool output as code.

## Audit and privacy

Audit records include actor subject, device, operation, target identifier, outcome, request ID, and timestamp. They exclude prompt bodies, chat bodies, memory contents, secret material, access tokens, and complete filesystem paths. Security denials and mutations are audited; high-volume reads and streaming deltas are not recorded by default.

Audit storage is append-oriented, access requires `owner`, and retention is configurable. Exports use the same redaction rules as the UI.

## Secure defaults and failure behavior

- Fresh installs expose loopback only and enroll one local owner.
- Public exposure is off until OIDC, TLS/proxy trust, and recovery settings validate.
- No authentication fallback activates when OIDC or Tailscale becomes unavailable.
- Runtime version mismatch disables writes and reports `runtime_incompatible`.
- Persistence or audit failure rejects security-sensitive mutations rather than continuing silently.
- Client disconnect does not automatically cancel an agent run; explicit cancellation remains authorized and auditable.
- A server restart invalidates transient bootstrap, step-up, and WebSocket tickets.

## Initial threat-review checklist

Before enabling remote access, verify:

- loopback and remote listeners expose only intended interfaces;
- a hostile browser origin cannot call HTTP or WebSocket endpoints;
- forged proxy/Tailscale headers are ignored;
- viewer/operator devices cannot mutate profile or global configuration;
- remote owners cannot invoke local-only commands;
- revocation terminates active HTTP and WebSocket sessions;
- snapshots, deltas, logs, audits, backups, and crash reports contain no secret values;
- duplicate/replayed mutations are idempotent;
- stale revisions cannot overwrite newer memory or settings;
- oversized chat/tool output cannot create unbounded memory use.
