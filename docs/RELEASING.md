# Release policy

Hermes Office currently publishes source only. Building locally is supported
for development, but a local `.app` or DMG is not an official project release.

## Binary release gate

Before the first public binary release, maintainers must add and review a
protected release workflow that:

- triggers only from an approved immutable tag;
- separates untrusted pull-request CI from signing/notarization jobs;
- uses a protected GitHub environment with the minimum required permissions;
- pins every GitHub Action to a full commit SHA;
- builds from committed npm and Cargo lockfiles;
- fails on unresolved applicable dependency advisories; a Linux release remains
  blocked by the `glib` limitation documented in `DEPENDENCIES.md`;
- signs and notarizes macOS artifacts with an identified release authority;
- produces SHA-256 checksums, an SBOM, dependency license inventory, and full
  third-party notices;
- publishes GitHub artifact attestations/provenance where available;
- records the source commit, toolchain versions, and generated metadata.

Release credentials must never be available to fork pull requests, build
scripts from unreviewed commits, or a `pull_request_target` checkout.

## Repository settings after creation

For `main`, enable a ruleset requiring review and the CI checks in
`.github/workflows/ci.yml`; prohibit force pushes and deletion. Enable private
vulnerability reporting, Dependabot alerts/security updates, secret scanning,
and push protection where the organization plan supports them.

Do not advertise or upload an official binary until the binary release gate is
implemented. `THIRD_PARTY_NOTICES.md` describes the notice requirements.
