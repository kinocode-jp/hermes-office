# AGENTS.md

## Local UI workflow

- Always develop against the Vite hot-reload surface, not a production static build.
- Preferred entrypoint: `npm run dev`
- Open the UI at `http://127.0.0.1:4173/` (or `http://localhost:4173/`).
- Treat `http://127.0.0.1:4317/` as the Office Server API / production static surface only. Do not use it for day-to-day UI iteration.
- After source UI changes, do not rebuild web assets (`npm run build:web`, desktop web bundle copy, packaged app resources) just to preview them.
- Rebuild / package only when the user explicitly asks for production, desktop packaging, or a release-like verification.
