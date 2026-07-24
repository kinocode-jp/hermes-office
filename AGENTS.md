# AGENTS.md

## Local UI workflow

- Always develop against the Vite hot-reload surface, not a production static build.
- Preferred entrypoint: `npm run dev`
- Open the UI at `http://127.0.0.1:4173/` (or `http://localhost:4173/`).
- Treat `http://127.0.0.1:4317/` as the Office Server API / production static surface only. Do not use it for day-to-day UI iteration.
- After source UI changes, do not rebuild web assets (`npm run build:web`, desktop web bundle copy, packaged app resources) just to preview them.
- Rebuild / package only when the user explicitly asks for production, desktop packaging, or a release-like verification.

## Starting/restarting `npm run dev`

- Do not background `npm run dev` with `&`, `nohup`, or `disown` inside a plain exec/shell call. In this sandboxed exec environment those detachment methods do not reliably survive the parent shell exiting, and the server processes get silently reaped even though the launch log looks successful.
- Start (or restart) `npm run dev` in a **persistent PTY/session-backed shell call** and leave that session running instead of trying to detach it. Confirm both ports are actually serving before telling the user it's restarted:
  - `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/` should return `200`.
  - `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4317/api/v1/health` should return `200`.
- If both checks don't return `200`, the dev server is not actually up yet — do not report success from the log output alone.
