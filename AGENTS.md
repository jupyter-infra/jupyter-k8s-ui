# AGENTS.md — Instructions for AI coding agents (Claude Code, Cursor, aider, etc.)

> `CLAUDE.md` is a symlink to this file. Keep this as the canonical source.

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

## Automated code review

Open PRs are reviewed automatically in CI by [roborev](https://roborev.io) (policy in [`.roborev.toml`](.roborev.toml)). Run the same review locally with `make review`; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Makefile Targets

```bash
make build               # Build frontend + server (bun run build:full)
make docker-build        # Build container image
make docker-push         # Push container image
make deploy-kind         # Build + load image into Kind cluster + restart
make deploy-aws          # Build + push to ECR + restart deployment
make load-image-aws      # Build + push to ECR (no restart)
make kubectl-aws         # Switch kubectl to EKS context
make refresh-token       # Fetch fresh OIDC token for local dev
make test-e2e            # Run Playwright E2E tests (sets up cluster + server automatically)
make cleanup-e2e         # Delete the E2E Kind cluster
make clean               # Remove build artifacts
make info                # Show current configuration
make help                # Show all targets
```

## Project Structure

```
server/                    # Backend (Bun + TypeScript)
  __tests__/               # Server unit tests
  handlers/                # Route handlers (workspaces, templates, me)
  index.ts                 # Server entry point
  router.ts                # Route dispatcher
  auth.ts                  # JWT extraction, session cookie auth
  k8s.ts                   # K8s client factory, response mappers
  session.ts               # Session cookie create/validate
  crypto.ts                # AES-256-GCM encryption, HMAC signing, HKDF key derivation
  secret-watcher.ts        # K8s secret informer for key rotation
  types.ts                 # CRD type definitions
  responses.ts             # JSON response helpers, K8s error mapping

src/                       # Frontend (React + Vite)
  api/                     # API client, React Query hooks, auth interceptor
  components/              # UI components (layout, workspace cards, dialogs)
  context/                 # React contexts (auth, theme)
  pages/                   # Route pages (list, create, detail)
  constants/               # UI strings, resource bounds
  types/                   # Frontend TypeScript types
  utils/                   # Status helpers, validation, K8s quantity parsing
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

### Commands

```bash
bun run test             # Full unit suite (server + client)
bun run test:server      # Server tests only
bun run test:client      # Frontend tests only
```

### Two environments, two bunfigs

The repo deliberately splits test environments:

- **`bunfig.toml`** (root) — no preload. Server tests use Bun's native `Request`/`Response`. happy-dom strips forbidden headers like `Origin` and `Referer`, which the CSRF layer depends on, so we do **not** register happy-dom for server tests.
- **`src/bunfig.toml`** — preloads `src/test-dom-setup.ts`, which registers happy-dom globals so React components can render. `screen` from `@testing-library/react` binds to `document.body` at module-load time, so the preload must run before any test imports.

When adding a new test:

- Server test → put it in `server/__tests__/` — no DOM, no React imports
- Frontend test → colocate next to the source (`src/**/*.test.ts` or `*.test.tsx`) — DOM is auto-available via preload
- E2E test → goes in `e2e/` (Playwright, see E2E section below)

### Writing tests that earn their keep

**Rule: each test should fail for a distinct reason.** If two tests would fail from the same bug, one is redundant. Aim for breadth across failure modes, not depth on one.

- Test each branch of a lookup table / status-code mapping (each is a separate contract)
- Test defensive defaults where `undefined` would cause a runtime `TypeError` downstream
- Test suffix-matching, ordering, and timing invariants (non-obvious logic)
- Use `test.each` for parameterized cases that truly differ in input
- Don't test `JSON.stringify` / `new Response` — that's testing the stdlib
- Don't write "accepts X" + "accepts Y" + "accepts Z" if they all hit the same branch
- Don't test presentational components (layout, static text, icons) — E2E covers these
- Don't add a test that would still pass if you deleted the body of the function being tested

**For React component tests:** always call `cleanup()` in `beforeEach` — happy-dom's `document.body` persists across tests and `screen.getBy*` will find duplicate elements otherwise. `renderHook` doesn't need this; `render` does.

### What to test when making changes

- Server handler → distinct error paths + response shape
- Pure utility (`parseQuantity`, `getWorkspaceState`, etc.) → the new branch you just added
- React Query hook → optimistic update + rollback on error
- Auth/session/CSRF logic → these are the highest-value tests; cover failure modes, not just happy path
- CRD type in `server/types.ts` → update `server/__tests__/k8s.test.ts` mappers

### What NOT to bother testing

- Layout/presentational React components (`Layout`, `ThemeSwitcher`, `ConfirmDialog`, `TemplateCard`)
- Thin wrappers over framework primitives
- Getters that return a field directly
- Code paths the type system already guarantees

## E2E Testing (Playwright)

E2E tests use Playwright against a real K8s cluster (Kind) with the jupyter-k8s operator. Tests interact with the actual UI and verify workspace CRUD against the real K8s API.

### Prerequisites

Same as local development: a Kind cluster with the operator deployed. If the cluster doesn't exist, `test-e2e` will create one automatically using the public GHCR images (no controller source checkout needed).

### Running

```bash
make test-e2e             # Sets up cluster (if needed), starts server, runs Playwright, stops server
make cleanup-e2e          # Delete the Kind cluster when done
```

### Writing E2E tests

- Files go in `e2e/` with `.spec.ts` suffix
- Tests run serially (CRUD tests share workspace state within a describe block)
- Use accessibility selectors: `getByRole`, `getByText`, `getByLabel` — never CSS selectors
- Each test run uses a unique name prefix (`e2e-<timestamp>`) to avoid collisions
- Use 30s timeouts for K8s assertions — the operator reconciles in seconds

### What to E2E test

- Full user flows: create workspace, wait for Running, stop, start, delete
- Form validation visible in the UI
- Status badge transitions (Starting -> Running, Stopped)
- Button visibility based on workspace state

### What NOT to E2E test

- API payload shapes (unit tests cover this)
- Auth/OAuth flows (bypassed with dev token in E2E)
- Operator internals (tested in jupyter-k8s repo)

## Project Links

- GitHub Project Board: https://github.com/orgs/jupyter-infra/projects/3

## Local Development Setup

1. `make refresh-token` (creates `.env` and fetches a fresh OIDC token via browser auth)
2. `bun install`
3. `bun run dev:full` (starts both Vite on :5173 and Bun server on :8090)

If API calls return 401, the token has expired — re-run `make refresh-token`.
