# Project Conventions

## Architecture
- The project is **frontend/backend decoupled**.
- Frontend lives in `apps/web` and is a **Vue 3 + Vite** single-page app. It must not import agent/runtime logic directly; it communicates with the backend only through the JSON API under `/api`.
- Backend lives in `apps/server` (`@ezu/server`). It is a Node HTTP service that owns the agent, session reduction, runtime, and the workbench view model, and exposes the REST API consumed by the frontend.
- Shared domain types on the frontend are duplicated as plain DTOs in `apps/web/src/types.ts` to keep the frontend independent of backend runtime packages.

## Tooling
- `pnpm dev` runs the backend and frontend together via `concurrently`.
- Backend runs with `tsx` (dev and `start`) so workspace packages resolve from source via tsconfig `paths`.
- Frontend dev server proxies `/api` to the backend (`http://127.0.0.1:4175`).
