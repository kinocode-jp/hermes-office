# Security model and implementation status

## Scope and trust model

Hermes Agent can execute tools with the host user's authority. Prompts, Profile
instructions, Skills, Memory, and Kanban-triggered activity are therefore
execution-adjacent input rather than ordinary low-risk application data.

Hermes Office is experimental, pre-1.0 software. Its currently supported model
is one trusted operator on one machine, with Office and Hermes on loopback.
Private-network remote access by that same operator is experimental. Direct
public-internet exposure, untrusted multi-user use, and tenant isolation are not
supported.

This document describes controls visible in the current source. It is not an
independent audit, certification, or warranty.

## Implemented controls

### Listener and request boundary

- Office Server binds to loopback by default.
- Non-loopback binding requires an explicit opt-in plus valid remote-token and
  allowed-origin configuration.
- Local bootstrap checks the peer address, exact Host/Origin allowlists, and
  rejects forwarded requests rather than trusting proxy headers.
- CORS and WebSocket upgrades validate exact configured origins.
- HTTP methods, content types, JSON shapes, identifiers, request bodies,
  WebSocket frames, outbound responses, and event buffers are bounded.
- Static web serving rejects traversal and symlink escape and sets a restrictive
  CSP plus cache policies.

These controls reduce accidental exposure and cross-site drive-by requests.
They do not make direct public binding a supported deployment.

### Sessions and mutations

- Local browser sessions and optional remote-token sessions use random HttpOnly,
  SameSite cookies with a bounded lifetime.
- Cookie-authenticated mutations require a matching CSRF token.
- The Tauri path requires an exact Tauri origin and a random launch-scoped
  desktop capability supplied to the WebView through Tauri IPC.
- A remote enrollment token can be spent once per server process through a
  configured loopback HTTPS proxy. The comparison uses a digest and
  constant-time equality; attempts are rate-limited globally, per client, and
  per credential digest in bounded maps.
- Enrollment creates a separate long-lived device credential and an `operator`
  session. A local owner can list or revoke in-memory devices; revocation
  invalidates sessions and closes matching event/chat sockets.
- Per-operation policy checks enforce minimum tiers and distinguish remote-safe,
  step-up-required, and local-only operations. No remote step-up flow exists, so
  step-up operations fail closed for remote devices.
- WebSocket authentication uses the existing Office session/capability boundary,
  origin checks, frame bounds, and connection cleanup.
- Authentication events are kept in a bounded in-memory audit feed.

The current enrollment flow is not a complete multi-user authorization system.
Device, session, enrollment-consumed, rate-limit, and audit state is not durable;
a restart invalidates devices and permits fresh use of the configured enrollment
token.

### Hermes boundary

- Browsers receive normalized Office DTOs rather than the Hermes token, Hermes
  backend URL, Profile filesystem paths, or raw provider-secret objects.
- Managed and adopted Hermes endpoints are restricted to loopback.
- Hermes child processes receive a constructed environment allowlist rather
  than Office Server's complete environment; Office auth/proxy configuration
  and unrelated provider credentials are not inherited.
- Profile settings that Hermes scopes to a process are routed to a
  Profile-pinned Hermes backend.
- General provider-secret entry, Skill installation/deletion, destructive
  Memory reset, raw Memory-file editing, and arbitrary Hermes RPC are excluded
  from the GUI/API.
- Office global context rejects likely credentials and is injected only into a
  newly created session through an internal server path.

The desktop shell canonicalizes local Node/Hermes executable paths, rejects
group/world-writable or unexpected-owner files on Unix, bounds version probes,
and requires Node 22.x plus Hermes Agent 0.18.x. These executables are not yet
verified against a project-signed digest manifest. Treat the local installation
and user account as part of the trusted computing base.

### Browser content and storage

- The UI renders structured text/event data rather than injecting raw tool HTML.
- Access credentials are not intentionally stored in URLs or local storage.
- Custom Profile portraits and appearance preferences are browser-local and
  should be treated as ordinary local application data, not secret storage.

## Remote access guidance

If remote access is necessary:

1. keep Office bound to loopback;
2. use an authenticated HTTPS private-network proxy such as Tailscale Serve;
3. configure the exact number of trusted loopback proxy hops and one exact HTTPS
   origin rather than a wildcard;
4. generate a unique random one-time Office enrollment token of at least 32
   characters and do not
   reuse a Hermes/provider credential;
5. restrict the private network to devices controlled by the same trusted
   operator;
6. rotate the token and restart Office if a browser/device is lost;
7. never expose stock `hermes serve` directly.

TLS and proxy authentication are provided by the proxy; Office's loopback HTTP
listener does not itself terminate TLS or validate Tailscale/OIDC identity.

## Known limitations

The following are not implemented or not claimed as complete:

- durable device enrollment and configurable per-device grants;
- RBAC, recovery, and tenant boundaries suitable for untrusted users (the
  current fixed remote `operator` tier and local revocation are defense-in-depth
  for the single-operator model);
- remote reauthentication/step-up (step-up operations currently fail closed)
  and an unforgeable native presence flow beyond the Tauri capability;
- OIDC, PKCE, trusted proxy identity, public recovery, or public-internet mode;
- persistent tamper-evident audit storage and export;
- OS credential-store backed provider-secret entry;
- project-signed Node/Hermes runtime version and digest verification;
- signed/notarized project binaries, checksums, SBOM, and provenance;
- a formal external penetration test.

Some of these controls appear as design targets in historical/product documents.
They must not be described as implemented until code, tests, and a security
review support that statement.

## Security invariants for changes

- Never return Office, Hermes, provider, tunnel, or identity-provider secrets in
  browser DTOs, logs, audit records, errors, URLs, or WebSocket events.
- Construct child-process environments from an explicit minimum allowlist; do
  not inherit the entire Office Server environment.
- Keep Hermes endpoints on loopback and reject redirects or alternate addresses
  that escape that boundary.
- Apply authorization on the server for every request and socket operation;
  hiding UI controls is not authorization.
- Treat Skill content, SOUL, shared context, prompts, Kanban comments, tool
  output, filenames, and Markdown as untrusted input.
- Use revision/idempotency checks for mutation paths and re-check authorization
  when queued work begins.
- Do not introduce a permissive fallback when a remote identity, proxy, audit,
  persistence, or compatibility check fails.

## Reporting

Use the private process in the root [`SECURITY.md`](../SECURITY.md). Do not
publish exploit details in a GitHub issue.
