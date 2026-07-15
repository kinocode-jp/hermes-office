# Hermes Office

Hermes Office is a lightweight, standalone visual control plane for Hermes Agent.
Each Hermes profile is a character with its own sessions, skills, memory, and work queue.

## Product shape

- A Preact/Vite interface shared by desktop and the installable web app.
- A Tauri 2 shell for local runtime supervision and privileged administration.
- A thin typed adapter over the official `hermes serve` API.
- A responsive PWA for remote chat, approvals, and Kanban work.
- An optional native Expo client can be added later without changing the server contract.

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

The current local MVP supports live Hermes Profile and stored Session discovery,
multi-pane chat composition, Profile editing, per-Profile
Skills and Memory, Global inheritance settings, Kanban creation/assignment/status moves,
responsive mobile navigation, and an installable PWA. State is intentionally in-memory.

The server exposes bounded health, snapshot, and WebSocket event endpoints and reads
live Profile, stored Session, and Kanban summaries through an authenticated managed
Hermes backend. Chat history, prompt submission, and settings mutations remain read-only
until the Office device-auth and audit boundary is connected.

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
