# Hermes Office architecture

## Document status

This document separates the current pre-1.0 implementation from future design
goals. It is not a claim that every roadmap security control exists.

## Current system

```text
Tauri WebView ─┐
Browser / PWA ─┼── HTTP + WebSocket ── Office Server ── loopback ── Hermes Agent
               │                         │
               └── same Preact UI        ├── global settings state
                                         ├── Profile backend pool
                                         ├── durable remote-device registry
                                         └── bounded in-memory sessions/audit
```

### Web interface

`apps/web` contains the shared Preact/Vite UI and PWA shell. It renders an
office/profile roster, chat workspaces, Kanban, settings, and responsive mobile
navigation. The character atlas contains six base characters and directional
frames. The browser assigns each current Profile a persisted roster slot: slots
1–6 use the original atlas colors and slot 7 onward reuses those characters with
a deterministic hue shift. Inventory reorder does not change an existing
assignment. Only a complete authoritative inventory may remove deleted Profile
slots and compact the remaining relative order; partial/truncated reads never
prune assignments. Malformed stored slot data is compacted before use.
A profile can override its portrait with browser-local
image data.

The interface talks to Office Server, not directly to Hermes. Hermes backend
tokens and backend URLs are not part of the public browser DTOs.

### Office Server

`apps/server` is a Node.js HTTP/WebSocket process. It:

1. serves the production web assets;
2. authenticates local/Tauri or optional remote-token sessions;
3. validates and bounds Office HTTP/WebSocket input;
4. translates supported Profile, chat, settings, and Kanban operations;
5. supervises a managed loopback Hermes backend or adopts an explicitly
   configured loopback backend;
6. starts Profile-pinned Hermes processes for process-scoped settings calls;
7. stores the Office-owned global skill/shared-context state.

The remote-device credential digest, fixed `operator` tier, expiry, revocation,
enrollment-token generation digest, and one-time consumption state are persisted
in the device registry (by default `~/.hermes-office/devices.json`). The three
Office remote environment variables (`HERMES_OFFICE_REMOTE_TOKEN`,
`HERMES_OFFICE_ALLOWED_ORIGINS`, `HERMES_OFFICE_TRUSTED_PROXY_HOPS`) are owned
by the host environment and inherited only by the Office server child via the
desktop launcher; they are not forwarded to the managed Hermes Agent runtime. The
server exposes an owner-only `/api/v1/host/remote` endpoint that reports the
canonical configured HTTPS origin(s), trusted proxy-hop count, and device metadata
without returning the enrollment token, device digest, or any credential. The web
UI renders a desktop-host administration panel only for sessions authenticated with
the Tauri desktop capability. Session cookies, rate-limit windows, socket
bindings, pending approvals, and the bounded audit feed remain in memory and reset
with the server. The project does not implement a general multi-user identity
provider or public-internet mode.

Hermes stored chat sessions are intentionally shared across the single trusted
operator namespace rather than owned by one remote device. An authenticated
remote operator may open/resume a session shown in its snapshot. Approval
responses are different: pending approval state is ephemeral and bound to the
device and chat WebSocket that received it, preventing a second socket/device
from answering that prompt.

Snapshot capabilities are derived from the authenticated principal, exposure,
and operation policies at response time. Audit HTTP data and audit-derived
events are delivered only to owner-authorized clients.

### Hermes adapter and runtime

The Office adapter deliberately uses a small part of the stock `hermes serve`
REST/WebSocket surface. Hermes Profiles remain separate Hermes home directories.
Chat can use an explicitly selected Profile. Settings endpoints that are
process-scoped are routed through a lazily created Profile-pinned backend.

Managed mode starts a user-installed Hermes executable and supervises it. The
desktop shell starts the bundled Office Server JavaScript using a Node runtime
available on the machine. These are local runtime integrations, not bundled,
signed Hermes or Node distributions.

After a managed child exits unexpectedly, Office invalidates that generation's
origin and token immediately, publishes `runtime.status`, and performs one
single-flight recovery sequence with bounded attempts and backoff. Exhausted
recovery enters the explicit `error` state. Server shutdown suppresses recovery
and waits for any in-flight attempt before terminating the current child, so a
managed process is never respawned after shutdown begins.

The desktop launcher canonicalizes and validates executable ownership/mode and
requires Node 22.x/Hermes 0.18.x. A source `npm run dev` launch uses the explicit
Hermes executable value; its default bare `hermes` name is resolved through the
allowlisted `PATH` and does not receive the desktop path ownership/mode check.

The exact upstream research and known compatibility uncertainties are in
[`HERMES-INTEGRATION.md`](HERMES-INTEGRATION.md).

### Desktop shell

`apps/desktop` is a small Tauri 2 wrapper. Production builds bundle the generated
Office Server module and web assets. At launch, the desktop shell probes the
configured loopback port. If the port is free, release and development launches
both generate a launch-scoped random desktop capability, start an owned Office
Server child, verify its health and capability, and stop only that child on exit.
The capability is available to the WebView through Tauri IPC.

If a compatible Office Server is already listening and serves the bundled
Hermes Office Web UI from `/`, the optional desktop launcher does not generate
a capability or start a child. It opens the fixed
loopback Web UI in the default system browser and exits. This remains compatible
with older protocol-v1 web bundles because the page never enters a Tauri WebView
or uses Tauri IPC. Desktop-only host administration is unavailable in this mode,
and the external server remains unowned and is never stopped or killed by the
launcher. Remote clients require only a browser, not the desktop app.
Incompatible, malformed, timing-out, or non-Hermes listeners fail closed. A
self-contained startup notice remains in the desktop window when the existing
server has no Web UI, a probe times out, or the fixed Web UI URL cannot be
opened in the system browser. Its fixed recovery steps are cause-specific:
listener ownership, compatibility/update, response/log/restart, Web UI assets,
or manual browser opening as appropriate. Failures while starting an owned
server distinguish managed runtime, bundled resources, child launch, readiness,
and internal state. These paths do not crash the shell and never stop, replace,
or take ownership of an existing listener.
The health-only `npm run dev:server` process is therefore not attachable unless
the Web UI is also served from the same listener.

Local builds are developer artifacts. A signed/notarized project release and
release provenance pipeline do not exist yet; see [`RELEASING.md`](RELEASING.md).

## Current data model

```text
Office global layer
  ├── selected installed skills
  └── shared context for new sessions
          ↓ explicit synchronization
Hermes Profile (one office character)
  ├── installed skills / SOUL / memory provider
  ├── live and stored chat sessions
  └── assigned shared Kanban cards
```

The Office global layer is not a Hermes “global profile”. It is Office-owned
state synchronized through the supported Profile endpoints with recorded
ownership so a later global change does not claim an independently enabled
Profile skill. Shared context is injected only when Office creates a new chat
session.

## Current deployment modes

### Local desktop or browser

Loopback is the supported default. Local browser bootstrap is restricted by
socket address, Host, Origin, and forwarded-header checks. The Tauri path also
requires its launch-scoped capability.

### Private-network remote access (experimental)

The same trusted operator may put the loopback listener behind an authenticated
HTTPS private-network proxy with an exact trusted-hop count. Office can spend a
configured token once to enroll one durable `operator` device, then uses a
separate device cookie and short-lived HttpOnly session cookie. Cookie mutations
require CSRF. A restart with the same token reloads the device registry. A local
owner revoke or remote logout durably revokes the device and closes active
sockets.

Replacement enrollment is deliberately global: change the configured random
enrollment token and restart Office. A token-generation mismatch clears all
previous remote-device grants and reopens one enrollment. This is not general
multi-user identity or a tenant boundary.

Malformed, unreadable, wrong-version, or invalid-digest registry data fails
closed without reopening enrollment. Local-host recovery is to stop Office,
move the damaged registry aside, change the random token, restart, and enroll a
replacement; all previous device credentials are invalid after that recovery.

### Public internet (unsupported)

OIDC, trusted proxy identity, multiple independently granted remote devices,
account recovery, and a reviewed public exposure mode are roadmap items. Do not
interpret their mention in design documents as an implemented feature.

## Roadmap architecture (not implemented contract)

Possible future work includes:

- configurable multiple-device viewer/operator/manager/owner grants (the current
  durable enrollment permits one fixed `operator` per token generation);
- reauthentication/step-up and native local-presence proof for high-risk work;
- persistent, append-oriented audit storage;
- OIDC Authorization Code with PKCE and explicit trusted-proxy identity;
- version/integrity verification for managed Hermes and Node runtimes;
- operating-system credential-store integration and local one-shot secret entry;
- resumable ordered event journals with permission-filtered subscriptions;
- signed/notarized releases, checksums, SBOMs, and attestations;
- a separate native mobile client if the responsive PWA becomes insufficient.

Roadmap controls must fail closed and receive a security review before README or
release notes describe them as supported.
