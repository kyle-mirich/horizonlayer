# Desktop App Source Map

This app is an Electron desktop console for running or connecting to HorizonLayer and inspecting workspaces, sessions, memory, tasks, and runs.

## Start Here

- `src/main/main.ts`: Electron main process, window creation, IPC handlers, API proxy, and quit cleanup.
- `src/main/serverManager.ts`: managed local server process lifecycle and external-server status behavior.
- `src/main/settingsStore.ts`: persisted desktop settings.
- `src/preload/index.ts`: safe renderer bridge exposed as `window.horizon`.
- `src/shared/apiClient.ts`: API client used by the renderer, with Electron bridge and fetch modes.
- `src/shared/types.ts`: shared DTOs for dashboard data, server status, and settings.
- `src/renderer/main.tsx`: React UI for dashboard, memory, tasks, runs, and settings.
- `src/renderer/styles.css`: desktop UI styling.

## Agent Rules

- Keep the Electron boundary explicit: main process owns Node/Electron APIs, preload exposes a narrow bridge, renderer stays browser-safe.
- Update this file when adding desktop subsystems, IPC channels, settings fields, routes, or renderer sections.
- Pair behavior changes with focused tests in the nearest package. Use `npm test -- apps/desktop/src/...` from the repo root for root Vitest coverage, or `cd apps/desktop && npm test` for the desktop package.
- Keep dashboard API changes aligned with `src/dashboardApi.ts`, `src/dashboardApi.test.ts`, `src/shared/types.ts`, and `src/renderer/main.tsx`.
- A fresh-context agent should be able to use this file to decide where a desktop bug or feature belongs before editing code.

## Commands

Run from `apps/desktop` unless noted:

- `npm run build`: build Electron main/preload code and renderer assets.
- `npm run build:main`: typecheck/build the Electron main and preload bundle.
- `npm run build:renderer`: build the Vite renderer.
- `npm run dev`: build main/preload and start Vite on `127.0.0.1:5174`.
- `npm run test`: run desktop Vitest tests.
- `npm run typecheck`: typecheck renderer and main process projects.
