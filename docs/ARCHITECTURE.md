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
                                         └── bounded in-memory auth/audit state
```

### Web interface

`apps/web` contains the shared Preact/Vite UI and PWA shell. It renders an
office/profile roster, chat workspaces, Kanban, settings, and responsive mobile
navigation. The character atlas contains six base characters and directional
frames; profile order selects the base character and later profile groups use a
deterministic hue shift. A profile can override its portrait with browser-local
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

Authentication sessions, enrolled devices, rate-limit windows, one-time-token
consumption state, and the bounded authentication audit feed are currently in
memory and reset with the server. The project does not currently implement a
general multi-user identity provider, persistent device registry, or
public-internet deployment mode.

### Hermes adapter and runtime

The Office adapter deliberately uses a small part of the stock `hermes serve`
REST/WebSocket surface. Hermes Profiles remain separate Hermes home directories.
Chat can use an explicitly selected Profile. Settings endpoints that are
process-scoped are routed through a lazily created Profile-pinned backend.

Managed mode starts a user-installed Hermes executable and supervises it. The
desktop shell starts the bundled Office Server JavaScript using a Node runtime
available on the machine. These are local runtime integrations, not bundled,
signed Hermes or Node distributions.

The exact upstream research and known compatibility uncertainties are in
[`HERMES-INTEGRATION.md`](HERMES-INTEGRATION.md).

### Desktop shell

`apps/desktop` is a small Tauri 2 wrapper. Production builds bundle the generated
Office Server module and web assets. At launch, the shell generates a random
capability, starts Office Server on loopback, and makes that capability available
to its WebView through Tauri IPC. Development uses an explicit fixed local-only
capability from the Tauri development command.

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
configured token once to enroll one in-memory `operator` device, then uses a
separate device cookie and short-lived HttpOnly session cookie. Cookie mutations
require CSRF. A local owner can list/revoke the device and active sockets close.
The server restart boundary resets all of this state. This is not durable device
administration, general multi-user identity, or a tenant boundary.

### Public internet (unsupported)

OIDC, trusted proxy identity, durable device grants/revocation, recovery, and a
reviewed public exposure mode are roadmap items. Do not interpret their mention
in design documents as an implemented feature.

## Roadmap architecture (not implemented contract)

Possible future work includes:

- persistent device identities and configurable viewer/operator/manager/owner
  grants (the current remote enrollment always creates an `operator`);
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
