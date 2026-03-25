# AGENTS.md — AI Agent Instructions for jupyter-k8s-ui

## Project Overview

This is the web UI for [jupyter-k8s](https://github.com/jupyter-infra/jupyter-k8s). It's a standalone repo with a React + Vite frontend and a Bun TypeScript backend that talks to the Kubernetes API server using the user's OIDC token.

The only coupling to the main repo is the `workspace.jupyter.org/v1alpha1` CRD API contract. There is no compile-time or runtime dependency on the Go controller.

## Tech Stack

- Frontend: React 19, Vite, MUI, React Query, React Router, CSS Modules
- Backend: Bun, TypeScript, @kubernetes/client-node
- Build: `bun run build:full` (tsc + vite build)
- Lint: `bun run lint` (eslint)
- Container: `make docker-build` (finch/docker)

## Local Development Setup

1. `make refresh-token` (creates `.env` and fetches a fresh OIDC token via browser auth)
2. `bun install`
3. `bun run dev:full` (starts both Vite on :5173 and Bun server on :8090)

### Getting a DEV_ACCESS_TOKEN

The backend needs a valid OIDC JWT to authenticate against the Kubernetes API. In development mode, it reads `DEV_ACCESS_TOKEN` from `.env`.

Tokens expire. If API calls return 401, the token needs to be refreshed.

**Prerequisites (one-time):**

Your kubeconfig must be configured with the cluster's OIDC credentials. This is typically done by running the `set-kubeconfig.sh` script provided by your cluster admin (generated during `make deploy-aws-traefik-dex` in the jupyter-k8s repo). This script just runs `kubectl config set-cluster/set-credentials/set-context` — once done, there's no ongoing dependency on the main repo.

If the Dex client secret rotates (happens on redeployment), you'll need an updated script from the cluster admin.

**Refreshing the token:**

```bash
make refresh-token
```

This extracts all OIDC args (issuer URL, client ID, client secret, listen address, scopes) from your kubeconfig and runs `kubectl oidc-login get-token`. A browser window will open for authentication.

## Deployment

- Kind: `make deploy-kind` — builds image, loads into kind, restarts deployment
- AWS: `make deploy-aws` — builds image, pushes to ECR, restarts deployment
- The Makefile follows the same patterns as the main jupyter-k8s repo (finch default, CLOUD_PROVIDER gating, *-internal targets)

## Key Conventions

- All server code lives in `server/`, all frontend code in `src/`
- TypeScript strict mode everywhere
- CSS Modules for component styles (`.module.css`)
- React Query for server state, React Context for UI state
- K8s types in `server/types.ts` mirror the CRD spec — update these if the CRD changes
- Never log tokens or sensitive data
- `.env` is gitignored and must never be committed
