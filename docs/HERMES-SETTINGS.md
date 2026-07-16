# Hermes settings adapter contract

> **Document status:** This describes the currently implemented settings
> adapter and its deliberate exclusions. Broader device tiers, step-up flows,
> secret entry, and Skill installation are not claimed by this document.

Validated against the locally installed Hermes Agent 0.18.2 source on
2026-07-16. `apps/server/src/hermes-settings.ts` is the Office-facing boundary.

## Profile routing

Hermes profiles are separate `HERMES_HOME` directories. Skills endpoints accept
an optional `profile`, but the memory status/provider/reset endpoints do not.
Office therefore resolves a loopback `hermes --profile <name> serve` backend for
the selected profile and sends all profile settings calls to that process. The
resolver may pool these processes with an idle TTL. It must not pass a primary
profile's memory call through `?profile=` and assume it was scoped.

The backend token remains inside Office Server. Browsers receive normalized DTOs
only; they never receive the Hermes origin, token, filesystem paths, raw provider
objects, or backend exception details.

## Official endpoints used

| Feature | Read | Write | Notes |
| --- | --- | --- | --- |
| Skills list | `GET /api/skills` | — | Profile-pinned backend |
| Skill enablement | — | `PUT /api/skills/toggle` | `{name, enabled}` |
| Skill document | `GET /api/skills/content?name=...` | `PUT /api/skills/content` | Response `path` is discarded |
| Memory status | `GET /api/memory` | — | Process-scoped; file sizes only |
| Active memory provider | — | `PUT /api/memory/provider` | Empty provider selects built-in memory |
| Provider settings | `GET /api/memory/providers/{name}/config?surface=declared` | matching `PUT` | Secret fields are write-only in Hermes and rejected by this general adapter; use a future one-shot secret channel |
| Built-in memory reset | — | `POST /api/memory/reset` | Explicit `all`, `memory`, or `user`; destructive |
| Profile identity | `GET /api/profiles/{name}/soul` | matching `PUT` | Official `SOUL.md` surface |

Hermes 0.18.2 has no stable dashboard API for reading or editing raw
`MEMORY.md` and `USER.md`. Office does not read those files directly. The safe
surface is provider status/selection/configuration and explicit reset. A rich
memory editor requires a versioned Office contract, backups, and upstream
compatibility work.

## Office global layer

Hermes has no global profile. `OfficeGlobalSettingsStore` owns shared skill
selection and shared context separately from every Hermes home. It uses:

- atomic replacement with a mode-0600 temporary file;
- optimistic `expectedRevision` concurrency control;
- serialized in-process writes;
- bounded content and strict skill names;
- rejection of likely credentials in shared context.

`GlobalInheritanceCoordinator` materializes the selected global skills through
the official profile-pinned skills API. It records the exact profile/skill pairs
that Office changed from disabled to enabled. A later global removal disables
only those pairs; skills that were already enabled by the Profile are never
claimed. A Profile-scoped toggle permanently relinquishes Office ownership for
that pair, so a later global save cannot overwrite the user's Profile choice.
Ownership progress is checkpointed during synchronization and survives process
restart. Do not point several profiles at one writable `SKILL.md` directory.

Global writes are staged with `skillSync.state = "pending"`. Full success changes
the state to `ready`; partial upstream failure returns HTTP 502 while retaining a
bounded, secret-free failure list for an explicit retry. Revision conflicts return
HTTP 409. This avoids presenting a partially materialized update as complete.

When shared context is enabled, Office injects it as one internal Hermes system
message only on a new `session.create` request. It is never injected on
`session.resume`, and browser requests cannot provide `messages` or use the
internal seed channel.

## Office HTTP surface

Every route below requires an Office session. `PUT`/`PATCH` additionally require
the session's `X-CSRF-Token`. Request bodies are bounded JSON objects and unknown
fields fail closed.

- `GET/PATCH /api/v1/settings/global`
- `GET /api/v1/profiles/{profile}/settings`
- `GET /api/v1/profiles/{profile}/skills`
- `PATCH /api/v1/profiles/{profile}/skills/{skill}`
- `GET/PUT /api/v1/profiles/{profile}/skills/{skill}/content`
- `GET/PUT /api/v1/profiles/{profile}/soul`
- `GET /api/v1/profiles/{profile}/memory`
- `GET/PATCH /api/v1/profiles/{profile}/memory/providers/{provider}`
- `PUT /api/v1/profiles/{profile}/memory/provider`

Global writes carry an integer `expectedRevision`. Skill/SOUL/provider document
writes carry a SHA-256 `expectedRevision`; toggles/provider selection carry the
previous effective value. Stale writes return HTTP 409. These checks prevent
ordinary lost updates, although Hermes' upstream read and write calls are not a
single transaction.

## Deliberate exclusions

- Memory-provider secret values: require a dedicated local one-shot secret
  transfer rather than ordinary JSON DTOs.
- Provider setup/install commands: execution-adjacent and require explicit
  step-up authorization.
- Skill hub installation and deletion: require source verification and audit.
- Raw workspace paths, skill paths, profile directories, and Hermes error
  messages: never copied to Office DTOs.
