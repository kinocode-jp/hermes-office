# Host application installation

Hermes Studio can detect and install a small, explicitly allowlisted set of
applications on the Mac that runs Studio Server. The first supported host app
is Obsidian.

## Obsidian

Open **Settings → Desktop Host Administration → App integrations**. Studio
shows one of these states:

- **Ready to install** — Homebrew is present and Obsidian is not installed.
- **Installing** — the fixed Homebrew cask install is running.
- **Installed** — `/Applications/Obsidian.app` or
  `~/Applications/Obsidian.app` exists.
- **Setup required / failed** — Homebrew is missing, the platform is not macOS,
  the install failed, or the 20-minute timeout expired.

The install action runs the official Homebrew cask command with a fixed
executable and argument list:

```text
brew install --cask obsidian
```

The browser cannot provide an executable, package name, shell fragment, path,
or extra argument. Studio does not create an Obsidian vault, open an app, or
modify any Markdown data as part of installation.

## Authorization boundary

The status endpoint requires an authenticated Studio session. Installation is
the auditable `host-app.install` operation and requires an **owner** session.

- A local owner may install.
- A Tailnet-enrolled owner may install only when
  `HERMES_STUDIO_REMOTE_PRIVILEGED=true`; `npm run start:tailnet` enables this
  intentionally.
- Managers, operators, viewers, and ordinary remote deployments are denied.
- Browser mutations still require the normal CSRF token.

This operation shares the remote-privileged deployment gate used by privileged
configuration and secret transfer, but it never receives or returns a secret.

## HTTP surface

- `GET /api/v1/host/apps/obsidian` — bounded status metadata.
- `POST /api/v1/host/apps/obsidian/install` — starts the fixed install and
  returns immediately with `installing`; request bodies are rejected.

Clients poll the status endpoint while installation is running. Installer
stdout and stderr are discarded rather than copied into HTTP responses or
Studio logs.
