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

The local read-model/event server runs separately on `127.0.0.1:4317`:

```bash
npm run dev:server
```

Desktop development requires the Tauri prerequisites for the host OS:

```bash
npm run dev:desktop
```

The current local MVP supports multi-pane chat composition, Profile editing, per-Profile
Skills and Memory, Global inheritance settings, Kanban creation/assignment/status moves,
responsive mobile navigation, and an installable PWA. State is intentionally in-memory.

The server exposes bounded health, snapshot, and WebSocket event endpoints. The typed Hermes
adapter is ready, but the UI does not yet read or mutate an existing Hermes installation.
That last write path remains isolated so the demo cannot accidentally alter a live Profile.
