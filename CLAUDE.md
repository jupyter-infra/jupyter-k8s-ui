# CLAUDE.md — Instructions for Claude Code

## Project Overview

This is the web UI for [jupyter-k8s](https://github.com/jupyter-infra/jupyter-k8s). It's a standalone repo with a React + Vite frontend and a Bun TypeScript backend that talks to the Kubernetes API server using the user's OIDC token.

The only coupling to the main repo is the `workspace.jupyter.org/v1alpha1` CRD API contract. There is no compile-time or runtime dependency on the Go controller.

## Tech Stack

- Frontend: React 19, Vite, MUI v7, React Query (TanStack), React Router v7, CSS Modules
- Backend: Bun, TypeScript, @kubernetes/client-node
- Build: `bun run build:full` (tsc + vite build)
- Lint: `bun run lint` (eslint)
- Format: `bun run format` (prettier)
- Container: `make docker-build` (finch/docker)
- Pre-commit: husky + lint-staged (auto-formats and lints staged files)

## Common Commands

```bash
bun install              # Install dependencies
bun run dev:full         # Start both frontend (:5173) and backend (:8090)
bun run dev              # Frontend only (Vite)
bun run dev:server       # Backend only (Bun --watch)
bun run build:full       # Full build (tsc + vite)
bun run lint             # ESLint
bun run format           # Prettier (write)
bun run format:check     # Prettier (check only)
make refresh-token       # Fetch OIDC token for local dev (creates .env)
make deploy-kind         # Build + deploy to local Kind cluster
make deploy-aws          # Build + push to ECR + deploy to EKS
make help                # Show all Makefile targets
```

## Project Structure

```
server/                    # Backend (Bun + TypeScript)
  index.ts                 # Server entry point, graceful shutdown
  router.ts                # Route dispatcher, all endpoint definitions
  auth.ts                  # JWT extraction and decoding
  k8s.ts                   # K8s client factory with caching, response mappers
  types.ts                 # CRD type definitions (K8sWorkspace, K8sWorkspaceTemplate)
  logger.ts                # Level-based logging
  responses.ts             # JSON response helpers, K8s error mapping
  static.ts                # Static file serving with SPA fallback
  handlers/
    workspaces.ts          # CRUD operations on workspace CRDs
    templates.ts           # List workspace templates from K8s
    me.ts                  # Current user endpoint (JWT decode)

src/                       # Frontend (React + Vite)
  main.tsx                 # React root mount
  App.tsx                  # Providers (QueryClient, Theme, Auth) + routing
  theme.ts                 # MUI light/dark theme definitions
  api/
    client.ts              # ApiClient singleton (fetch-based)
    hooks.ts               # React Query hooks with polling & optimistic updates
  components/
    layout/Layout.tsx      # AppBar, user avatar, theme switcher, Outlet
    ui/ThemeSwitcher.tsx   # Light/dark toggle
    ui/ConfirmDialog.tsx   # Reusable delete confirmation
    ui/ErrorBoundary.tsx   # Error boundary with reset
    workspace/WorkspaceCard.tsx   # Workspace card with status + actions
    workspace/TemplateCard.tsx    # Template selection card
  context/
    AuthContext.tsx         # User auth state from /api/v1/me
    ThemeContext.tsx        # Theme state with localStorage persistence
  pages/
    WorkspaceList.tsx      # List page with filtering, search, pagination
    WorkspaceCreate.tsx    # Multi-section creation form
    WorkspaceDetail.tsx    # Detail page with conditions and resources
  constants/strings.ts     # All UI strings, resource bounds, defaults
  types/workspace.ts       # Frontend TypeScript types
  utils/workspace.ts       # Status helpers, K8s quantity parsing, validation
  styles/variables.css     # CSS custom properties for theming
```

## API Endpoints

| Method    | Path                     | Auth | Description                |
| --------- | ------------------------ | ---- | -------------------------- |
| GET       | /api/v1/health           | No   | Health check               |
| GET       | /api/v1/me               | No   | Current user info from JWT |
| GET       | /api/v1/workspaces       | Yes  | List user's workspaces     |
| POST      | /api/v1/workspaces       | Yes  | Create workspace           |
| GET       | /api/v1/workspaces/:name | Yes  | Get workspace details      |
| PUT/PATCH | /api/v1/workspaces/:name | Yes  | Update workspace           |
| DELETE    | /api/v1/workspaces/:name | Yes  | Delete workspace           |
| GET       | /api/v1/templates        | Yes  | List available templates   |

## Key Conventions

- All server code lives in `server/`, all frontend code in `src/`
- TypeScript strict mode everywhere — avoid `any`, use proper types
- CSS Modules for component styles (`.module.css`)
- React Query for server state, React Context for UI state (auth, theme)
- K8s types in `server/types.ts` mirror the CRD spec — update these if the CRD changes
- Frontend types in `src/types/workspace.ts` — keep in sync with server types
- UI strings centralized in `src/constants/strings.ts`
- Never log tokens or sensitive data
- `.env` is gitignored and must never be committed
- K8s resource names: lowercase alphanumeric + hyphens, 1-253 chars
- Commit prefixes: `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`
- Branch naming: `feature/`, `fix/`, `docs/`, `refactor/`

## Architecture Notes

- Auth flow: Browser -> Traefik -> OAuth2 Proxy -> Web App (Bun) -> K8s API Server
- In dev mode, backend reads `DEV_ACCESS_TOKEN` from `.env` instead of OAuth2 Proxy header
- K8s clients are cached per JWT hash (10min TTL, max 100 clients)
- React Query polls workspace list every 60s; detail polls every 3s while transitioning
- Workspace ownership tracked via `workspace.jupyter.org/created-by` annotation
- Vite proxies `/api` to `http://localhost:8090` in dev mode

## Testing

```bash
bun test                 # Run all tests (bun built-in test runner)
bun test --watch         # Watch mode
```

Test files use the `*.test.tsx` / `*.test.ts` convention and live next to the code they test.

## Project Links

- GitHub Project Board: https://github.com/orgs/jupyter-infra/projects/3

## Local Development Setup

1. `make refresh-token` (creates `.env` and fetches a fresh OIDC token via browser auth)
2. `bun install`
3. `bun run dev:full` (starts both Vite on :5173 and Bun server on :8090)

If API calls return 401, the token has expired — re-run `make refresh-token`.
