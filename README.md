# Hermes Office

Hermes Office is a standalone visual control plane for Hermes Agent. Each real
Hermes Profile appears as a character with its own sessions, skills, memory
provider, identity, and work queue. It is a separate application from Pilon.

## Product shape

- A Preact/Vite interface shared by desktop and the installable web app.
- A Tauri 2 shell that supervises the bundled Office Server.
- A narrow, secret-safe adapter over the official `hermes serve` API.
- A responsive PWA for remote chat, approvals, and Kanban work.
- The responsive Web/PWA is the phone client; Expo is not required for this version.

## Repository

```text
apps/web                 Shared responsive interface and PWA
apps/desktop             Tauri desktop shell
apps/server              Bounded local HTTP/WebSocket control-plane server
packages/hermes-client   Official Hermes transport adapter
packages/protocol        Public DTO and authorization contract
packages/ui-tokens       Visual system
docs                     Product, architecture, security, and integration notes
```

## Development

```bash
npm install
npm run dev
```

This starts the Web/PWA interface on `4173`, the Office Server on `4317`, and a
managed stock `hermes serve` backend on an OS-assigned loopback port. The
Hermes session token remains inside the Office Server process.

To run each surface separately:

```bash
npm run dev:server
npm run dev:web
```

Desktop development requires the Tauri prerequisites for the host OS:

```bash
npm run dev:desktop
```

Implemented runtime features include:

- real Profile and stored Session discovery;
- up to four simultaneous chat panes, stored history, streaming prompts, steering,
  interruption, reconnect, and tool-event display;
- the real Hermes Kanban board with card creation, status changes, Profile
  assignment, comments, live refresh, and Office-floor task cables;
- Profile-scoped Skills, SOUL, and Memory provider settings through a pool of
  Profile-pinned Hermes backends;
- revisioned Office Global Skills and shared context;
- local and remote device sessions, CSRF protection, rate limiting, and a bounded
  audit feed;
- responsive phone navigation and an installable offline application shell.

Raw Memory files, destructive Memory reset, provider secrets, Skill installation,
and arbitrary Hermes RPC are deliberately not exposed by the remote-safe GUI.

Runtime modes:

```bash
# Default: Office starts and owns a loopback Hermes backend
HERMES_OFFICE_HERMES_MODE=managed npm run dev

# UI/server demo without touching Hermes
HERMES_OFFICE_HERMES_MODE=demo npm run dev

# Adopt an explicitly managed loopback backend
HERMES_OFFICE_HERMES_MODE=existing \
HERMES_OFFICE_HERMES_URL=http://127.0.0.1:12345 \
HERMES_OFFICE_HERMES_TOKEN=... npm run dev
```

## Production Web/PWA

```bash
npm run build:production
npm start
```

This serves the built PWA and API together from `http://127.0.0.1:4317`. The
default listener is loopback-only. Static files have traversal/symlink protection,
strict CSP, immutable hashed assets, and a non-cached app shell.

For access away from home, keep Office bound to loopback and put an authenticated
HTTPS private-network proxy such as Tailscale Serve in front of it. Configure a
unique HTTPS origin and a random token of at least 32 characters:

```bash
HERMES_OFFICE_REMOTE_TOKEN='replace-with-a-random-32+-character-token' \
HERMES_OFFICE_ALLOWED_ORIGINS='https://your-device.your-tailnet.ts.net' \
npm start
```

Open the HTTPS URL on the phone and use the Remote Airlock screen once per browser
session. The access token is submitted directly to the device-auth endpoint and is
not stored in URL state, browser storage, logs, audit records, or application state.
The resulting credential is an HttpOnly, SameSite cookie; writes also require the
in-memory CSRF token. Direct non-loopback binding additionally requires
`HERMES_OFFICE_ALLOW_NON_LOOPBACK=true`, but an HTTPS loopback proxy is preferred.

## Desktop release

```bash
npm run build --workspace @hermes-office/desktop
```

The macOS build produces the Hermes Office application and DMG. In release mode the
Tauri shell starts the bundled Office Server module automatically, using the Node
runtime installed with Hermes Agent when available, and terminates it when the app
exits. Development mode continues to use the root `npm run dev` processes.

## Security boundary

- Hermes and Office tokens never cross into browser DTOs.
- Local bootstrap requires a loopback socket plus an exact local/Tauri Origin and
  Host, and rejects forwarded requests.
- Remote authentication is disabled unless a valid token is configured, compares
  only digests in constant time, and limits attempts per peer.
- Every JSON body, WebSocket frame, response, identifier, and allowed method is
  bounded and validated.
- The Office Server binds to loopback unless both remote-token configuration and
  explicit non-loopback consent are present.

The exact Profile settings contract and deliberate exclusions are documented in
[`docs/HERMES-SETTINGS.md`](docs/HERMES-SETTINGS.md).
