# Hermes Office architecture

## Product boundary

Hermes Office is a standalone control plane and user interface for Hermes Agent. A profile is represented by one office character; a profile may own many concurrent chat sessions. The office scene is navigation and status visualization, while chat, settings, memory, skills, and Kanban use accessible DOM-based views.

The first-class clients are:

- Tauri 2 desktop, including native lifecycle and local runtime integration;
- a responsive web/PWA client served by the same Office Server;
- a future Expo mobile client using the same protocol, not shared desktop layouts.

## System shape

```text
Tauri desktop ─┐
Web / PWA ─────┼── HTTPS + WebSocket ── Office Server ── Hermes adapter ── Hermes
Future Expo ───┘                         │                  runtime
                                        ├── profile/global config
                                        ├── auth, devices, policy
                                        ├── event journal
                                        └── audit log
```

Clients never connect directly to Hermes. Office Server owns protocol normalization, redaction, authorization, concurrency control, and audit. This keeps the UI independent of the installed Hermes version and applies an identical policy to desktop and remote clients.

## Components

### UI clients

The UI consumes snapshot endpoints for initial state and a resumable WebSocket event stream for changes. It keeps the office renderer separate from feature views:

- Canvas renders low-frequency character/activity animation and pauses when hidden.
- DOM renders virtualized chat history, split panes, settings, memory, skills, and Kanban.
- The mobile layout replaces the large scene with a profile list when space or power is constrained.

The UI contains no provider credentials, Hermes environment variables, OIDC client secrets, runtime filesystem paths, or raw process output. Read models contain only redacted secret metadata.

### Office Server

One native Office Server process is the authoritative boundary. It may be embedded in the desktop installation, but remains a separately testable service. Its responsibilities are:

1. authenticate browser, desktop, and mobile connections;
2. calculate device permissions and enforce operation policies;
3. expose versioned HTTP DTOs and ordered WebSocket events;
4. adapt Hermes concepts into profiles, sessions, skills, memory, and Kanban;
5. serialize conflicting writes with revisions and idempotency keys;
6. store secrets using the operating-system credential store or an encrypted server-side store;
7. journal security-relevant mutations without recording prompts, memory bodies, or secrets.

The protocol starts at version 1. API additions should be backward compatible within a major version. Unknown event topics and fields are ignored by clients. A server reports capabilities before feature routes are enabled.

### Hermes adapter and runtime manager

The adapter is the only component coupled to Hermes transport or file formats. It performs a startup compatibility handshake and converts Hermes output into stable Office events. Unsupported Hermes versions enter `incompatible`; the server does not guess at write semantics.

Two local runtime modes are supported:

- `managed-sidecar`: Office Server launches a pinned, integrity-checked Hermes runtime, supplies a private data directory and environment, captures output, and stops the child process on shutdown. Platform packaging may bundle it or download a signed release through a native updater.
- `existing-local`: Office Server connects to a user-installed Hermes endpoint. The endpoint must resolve to loopback, pass the compatibility handshake, and be protected from accidental use by other local users. Office Server never forwards the Hermes endpoint to clients.

Only one runtime manager owns a managed runtime. A lock file with process identity prevents duplicate launch. Crash restart uses bounded exponential backoff and surfaces the terminal state to the UI.

A remote client connects to a remote Office Server, not to a remote raw Hermes runtime. This preserves profiles, policy, event order, and auditing at the machine where tools execute.

## Data model and inheritance

```text
Global settings
  ├── defaults and shared context
  └── shared skill registry
          ↓ explicit inherit / override / disable
Profile (one character)
  ├── profile settings, memory, skills
  ├── chat session 1
  ├── chat session 2
  └── assigned Kanban cards
```

Global and profile memory are separate documents. They are composed into a session context by the server; multiple profiles never concurrently rewrite one shared Hermes memory file. Every UI field identifies whether its effective value is inherited or overridden.

Kanban is server-owned shared state. Assigning a card to a profile and posting a comment are normal operations; an automation that starts agent work is a distinct explicit command so drag-and-drop cannot accidentally execute tools.

## API behavior

HTTP handles snapshots and commands. WebSocket handles deltas only. Every mutation has:

- a client-generated request ID and idempotency key;
- an explicit operation name;
- an optional expected aggregate revision;
- a server-derived actor, device, network exposure, and permission tier.

The server rejects stale writes with the current revision. Chat sends use a stable client message ID to prevent duplicate prompts after reconnect. Events have a monotonically increasing server sequence. A client reconnects with its last sequence; if retention has elapsed, it receives `resync.required` and reloads snapshots.

Hermes streaming chunks are coalesced before broadcast to avoid rendering and network pressure. Slow clients receive a resync marker instead of an unbounded queue.

## Deployment modes

### Local desktop

Office Server listens on an ephemeral loopback port. Tauri starts it and obtains a single-use bootstrap capability over native IPC. The browser view exchanges that capability for a short-lived, HttpOnly session; it does not persist bearer tokens in local storage. Local-only operations additionally require a verified Tauri/native channel.

### Tailnet

The server remains loopback-only behind Tailscale Serve where possible. HTTPS terminates on the tailnet and Tailscale identity is verified server-side. Tailnet membership identifies a subject but does not automatically grant `owner`; the subject and device receive an explicit tier.

### Public internet

Prefer an outbound server tunnel or a hardened reverse proxy so the workstation has no open inbound port. Public mode requires HTTPS and OIDC Authorization Code with PKCE. Office Server validates issuer, audience, signature, nonce/state, and redirect URI. Browser sessions use Secure, HttpOnly, SameSite cookies and CSRF protection. Public mode refuses to start when OIDC or trusted-proxy configuration is incomplete.

## Repository direction

Recommended ownership boundaries are:

```text
apps/desktop       Tauri shell only
apps/web           shared desktop/PWA UI
apps/mobile        future Expo client
apps/server        Office Server and persistence
packages/protocol  dependency-free wire contracts
packages/domain    client-safe state and use cases
packages/ui        shared DOM UI where form factor permits
```

The Tauri shell remains small. Process control, credential-store access, filesystem grants, updater behavior, and local-only proof live in native code. Product behavior remains in the server so remote clients observe the same state.
