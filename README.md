# Hermes Office

Hermes Office is an experimental, standalone visual interface for
[Hermes Agent](https://github.com/NousResearch/hermes-agent). A Hermes Profile
appears as an office character whose chats, settings, and assigned Kanban work
can be opened from one responsive interface.

> [!IMPORTANT]
> Hermes Office is an independent community project. It is not an official
> Nous Research product, is not affiliated with or endorsed by Nous Research,
> and does not replace the official Hermes Agent interface.

The project is pre-1.0 and currently intended for source builds by a single
trusted operator. Do not expose it directly to the public internet. See
[Security status](#security-status) before enabling remote access.

## What is implemented

- Discovery of installed Hermes Profiles and stored sessions.
- An animated pixel-office Profile roster. Six base characters include
  front/side/back walking frames; profiles seven and later reuse the roster
  with deterministic hue variants.
- Per-Profile custom portrait uploads stored in the browser.
- Up to four simultaneous chat panes with resume, streaming, steering,
  interruption, reconnect, and normalized tool events.
- Hermes Kanban viewing and mutations, Profile assignment, comments, live
  refresh, and task cables on the office floor.
- Profile-scoped installed Skills, SOUL, and Memory-provider settings through
  Profile-pinned Hermes backends.
- An Office-owned global selected-skill/shared-context layer with explicit
  inheritance synchronization.
- English/Japanese UI, adjustable text size, light/dark themes, responsive
  phone navigation, and an installable PWA shell.
- Loopback browser sessions, Tauri launch capabilities, origin/Host checks,
  CSRF checks for cookie-authenticated writes, bounded request bodies, and an
  experimental one-time remote-device enrollment/revocation flow.

Deliberate exclusions include raw Memory-file editing, destructive Memory
reset, provider-secret entry, Skill installation/deletion, arbitrary Hermes
RPC, and public multi-user administration.

> [!NOTE]
> A steering message shown as **Hermes queue accepted** means stock Hermes
> returned `status: "queued"`; it does not prove that the running turn applied
> the message. In the pinned Hermes version, guidance accepted as a turn is
> finishing can be returned as `pending_steer` by the turn finalizer, but the
> TUI gateway does not forward that leftover into another turn. Hermes Office
> therefore cannot guarantee delivery at that boundary without forking Hermes,
> and it deliberately does not retry automatically because doing so could apply
> the same instruction twice.

## Repository layout

```text
apps/web                 Shared responsive Preact/Vite interface and PWA
apps/desktop             Tauri 2 desktop shell
apps/server              Local HTTP/WebSocket control-plane server
packages/hermes-client   Hermes transport boundary
packages/protocol        Shared DTO contract
packages/ui-tokens       Visual tokens
docs                     Design and integration documentation
```

## Requirements

- Node.js/npm versions from `.node-version` and `package.json`
- Hermes Agent 0.18.2-compatible `hermes serve` installation
- Rust toolchain from `rust-toolchain.toml` and the Tauri host prerequisites
  when developing the desktop shell

## Development

Install exactly from the committed lockfile:

```bash
npm ci
npm run dev
```

This starts the PWA on port `4173` and Office Server on port `4317`. By default,
Office Server starts a managed stock `hermes serve` process on an OS-selected
loopback port. The development command explicitly allows the two Vite origins;
production does not trust port `4173`. The Hermes backend credential stays in
Office Server.

Run surfaces individually with:

```bash
npm run dev:server
npm run dev:web
npm run dev:desktop
```

Runtime modes:

```bash
# Default: start and supervise a loopback Hermes backend
HERMES_OFFICE_HERMES_MODE=managed npm run dev

# UI/server demonstration without reading or starting Hermes
HERMES_OFFICE_HERMES_MODE=demo npm run dev

# Connect to an explicitly managed loopback-only Hermes backend
HERMES_OFFICE_HERMES_MODE=existing \
HERMES_OFFICE_HERMES_URL=http://127.0.0.1:12345 \
HERMES_OFFICE_HERMES_TOKEN=replace-me npm run dev
```

Do not commit environment files, tokens, Hermes home data, or generated build
output.

## Local production build

Build and serve the web/server surface locally:

```bash
npm run build:production
npm start
```

The default listener is `127.0.0.1:4317`. Build desktop assets and the local
Tauri application with:

```bash
npm run build --workspace @hermes-office/desktop
```

This is a developer build, not an official signed release. No project binary is
currently published. The release requirements are tracked in
[`docs/RELEASING.md`](docs/RELEASING.md).

## Security status

The supported trust model is one trusted operator on one machine. The safest
deployment keeps both Office and Hermes on loopback.

Remote-device access exists for the same operator, but remains experimental. If
you use it, keep Office bound to loopback and place an authenticated HTTPS
private-network proxy such as Tailscale Serve in front of it. Configure one
unique random, one-time enrollment token of at least 32 characters, one exact
HTTPS origin, and the exact number of trusted loopback proxy hops:

```bash
HERMES_OFFICE_REMOTE_TOKEN='replace-with-a-random-32+-character-token' \
HERMES_OFFICE_ALLOWED_ORIGINS='https://your-device.your-tailnet.ts.net' \
HERMES_OFFICE_TRUSTED_PROXY_HOPS=1 \
npm start
```

Configured remote origins are added to, rather than substituted for, the
server's actual loopback listener origin. This keeps the local production UI at
`http://127.0.0.1:4317` available for owner-only device review and revocation;
unrelated local development origins remain denied.

The first remote browser exchanges the enrollment token over the configured
HTTPS proxy for a separate device credential and HttpOnly session cookie. The
one-time enrollment state and device credential digest are persisted in
`~/.hermes-office/devices.json` by default; plaintext credentials are not stored
there. Restarting with the same enrollment token preserves that device, which
can renew its short-lived session from its device cookie.

A remote device receives the `operator` tier. It can use the shared
single-operator chat/session namespace and update Kanban, but cannot change
Profile/global settings or invoke step-up/local-only operations. Capabilities in
the snapshot are calculated for the authenticated client. Approval replies are
bound to the requesting device and chat socket; permanent approvals remain
local-only. Audit records and audit events are owner-only.

A verified local owner can list/revoke an enrolled device. Remote **Log out**
also revokes that device, clears both cookies, and closes its active sockets. A
revoked or lost device cannot be replaced with an already-consumed token. To
recover, generate a different random enrollment token, update
`HERMES_OFFICE_REMOTE_TOKEN`, and restart Office. The token-generation change
invalidates every previously enrolled remote device and opens one replacement
enrollment. Enroll the replacement browser using the new token. Token rotation
is therefore a global remote-device reset, not a per-device operation.

An unreadable or malformed registry fails closed: stored devices are not
accepted and enrollment is not reopened. To recover as the local host owner,
stop Office, move the damaged registry out of the way, configure a different
random enrollment token, restart, and enroll again. Do not edit a live registry;
this recovery intentionally invalidates every old remote-device credential.

This is not OIDC, general multi-user device administration, tenant isolation,
or a claim that an untrusted remote user can safely share the host. Direct
public-internet and direct non-loopback exposure are unsupported; Office must
remain on loopback behind the configured private HTTPS proxy.

Read [`docs/SECURITY.md`](docs/SECURITY.md) for implemented controls, known
limitations, and roadmap boundaries. Report suspected vulnerabilities through
[`SECURITY.md`](SECURITY.md), not a public issue.

## Documentation

- [`docs/HERMES-INTEGRATION.md`](docs/HERMES-INTEGRATION.md) — pinned upstream
  API research and the adapter boundary
- [`docs/HERMES-SETTINGS.md`](docs/HERMES-SETTINGS.md) — current settings
  adapter contract and exclusions
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current architecture and
  explicitly separated roadmap
- [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) — toolchain pins, update policy,
  and known dependency limitations
- [`docs/DESIGN.md`](docs/DESIGN.md) — product/design direction, not an
  implementation guarantee
- [`ASSETS.md`](ASSETS.md) — original asset provenance and license
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — dependency notice and
  binary distribution policy

## License

Hermes Office source and original project assets are available under the
[MIT License](LICENSE). Third-party dependencies and Hermes Agent remain under
their respective licenses. See [ASSETS.md](ASSETS.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
