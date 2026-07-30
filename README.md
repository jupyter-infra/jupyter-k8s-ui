# jupyter-k8s-ui

Web UI for [jupyter-k8s](https://github.com/jupyter-infra/jupyter-k8s). A self-service interface where users can create, manage, and access their Jupyter workspaces through a browser instead of using `kubectl`.

Built with React + Vite (frontend) and Bun + TypeScript (backend). The backend talks directly to the Kubernetes API server using the user's OIDC token — there is no compile-time or runtime dependency on the Go controller. The only shared contract is the `workspace.jupyter.org/v1alpha1` CRD API.

## Architecture

```
Browser → Traefik → OAuth2 Proxy → Web App (Bun) → K8s API Server
```

The web app is deployed as a Kubernetes Deployment in the routing namespace. OAuth2 Proxy handles authentication via Dex (GitHub OAuth), and the backend proxies workspace CRUD operations to the K8s API using the authenticated user's OIDC token.

## Prerequisites

- [Bun](https://bun.sh/docs/installation) v1.0.0+
- `kubectl` configured with cluster access
- A Kubernetes cluster with the [jupyter-k8s](https://github.com/jupyter-infra/jupyter-k8s) operator installed
- [kubectl-oidc-login](https://github.com/int128/kubelogin) plugin (`brew install kubelogin`)
- [Finch](https://github.com/runfinch/finch) or Docker for container builds

## Getting Started

### 1. Configure kubeconfig (one-time)

Your kubeconfig needs OIDC credentials for the cluster. Run the `set-kubeconfig.sh` script provided by your cluster admin:

```sh
bash set-kubeconfig.sh
```

This script is generated during `make deploy-aws-traefik-dex` in the main jupyter-k8s repo. It runs `kubectl config set-cluster/set-credentials/set-context` to configure your local kubeconfig. Once done, there's no ongoing dependency on the main repo.

> **Note:** If the Dex client secret rotates (happens on redeployment), you'll need an updated script from your cluster admin.

### 2. Install dependencies

```sh
make deps
```

### 3. Get a development token

```sh
make refresh-token
```

This extracts OIDC args from your kubeconfig and fetches a token via browser auth. It creates `.env` from `.env.example` if it doesn't exist, then updates `DEV_ACCESS_TOKEN`.

Tokens expire. If API calls return 401, re-run `make refresh-token`.

### 4. Start development servers

```sh
make dev-full
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:8090
- Health check: http://localhost:8090/api/v1/health

Run `make help` for all available targets.

## Deploying

### Kind (local)

Requires a Kind cluster with the jupyter-k8s operator already deployed.

```sh
make deploy-kind
```

### AWS (EKS)

Builds the image, pushes to ECR, and restarts the deployment. Requires AWS CLI configured and `kubectl` context set to the EKS cluster.

```sh
make deploy-aws
```

By default, `finch` is used as the container tool. To use Docker:

```sh
make deploy-aws CONTAINER_TOOL=docker
```

## Project Structure

```
jupyter-k8s-ui/
├── src/                  # Frontend (React + Vite)
│   ├── api/              # API client & React Query hooks
│   ├── components/       # React components
│   ├── context/          # React context providers
│   ├── pages/            # Page components (routes)
│   ├── constants/        # UI strings, config
│   └── styles/           # Global styles
├── server/               # Backend (Bun + TypeScript)
│   ├── index.ts          # Server entry point
│   ├── k8s.ts            # Kubernetes client
│   └── types.ts          # CRD type definitions
├── Makefile              # Build, dev, deploy targets
├── Dockerfile            # Production container image
└── .env.example          # Environment template
```

## RBAC

**The user's K8s token is the sole access enforcement**: every list/read/write runs under it and is rejected by the K8s API server if RBAC doesn't allow it.

However for namespace _discovery_, the web-app i/ attempts to decide which namespaces to _offer_ using it own SA, then ii/ filters them down by performing a `SelfSubjectAccessReview` with the user's K8s token. This SSAR verifies that the user has RBAC permission to `list workspaces` in such a namespace. If i/ above fails because the web-app SA does not have RBAC permission to list namespaces cluster-wide, the web-app falls back to a static list.

Either way, the web-app only offers a namespace to a user **only if** such user has permission to `list` on `workspaces` for such a namespace.

### ServiceAccount RBAC

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: jupyter-k8s-ui-namespace-lister
rules:
  - apiGroups: ['']
    resources: ['namespaces']
    verbs: ['list', 'watch']
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: jupyter-k8s-ui-namespace-lister
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: jupyter-k8s-ui-namespace-lister
subjects:
  - kind: ServiceAccount
    name: <web-app-service-account>
    namespace: <web-app-namespace>
```

## Web-App configuration

| Env var                              | Default                                    | Purpose                                                                                         |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `NAMESPACE`                          | `default`                                  | The default namespace; SSAR-exempt                                                              |
| `SHARED_TEMPLATE_NAMESPACE`          | `jupyter-k8s-shared`                       | Cross-namespace template / access-strategy source                                               |
| `WORKSPACE_NAMESPACES`               | `["default"]`                              | Static candidate list (fallback)                                                                |
| `WORKSPACE_NAMESPACE_LABEL`          | `workspace.jupyter.org/workspaces-enabled` | Label key marking discoverable namespaces                                                       |
| `WORKSPACE_NAMESPACE_LABEL_SELECTOR` | _(derived `<label>=true`)_                 | Full label selector override                                                                    |
| `NAMESPACE_CANDIDATE_CAP`            | `20`                                       | SSAR fan-out page size (candidates checked per `/namespaces` page)                              |
| `NAMESPACE_VISIBLE_PERSIST_CAP`      | `100`                                      | Max visible namespaces stored in the preference cookie (further pages served live, client-only) |
| `NAMESPACE_POLL_INTERVAL_SECS`       | `60`                                       | Universe re-LIST poll interval                                                                  |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines. Pull requests get an automated AI code review, and you can run the same review locally before pushing with `make review`.

## License

MIT License — see [LICENSE](LICENSE) for details.
