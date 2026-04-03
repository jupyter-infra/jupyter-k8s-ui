# Contributing to jupyter-k8s-ui

Thank you for your interest in contributing! This guide will help you get started.

## Getting Started

### Prerequisites

- **Bun** v1.0.0+ ([installation guide](https://bun.sh/docs/installation))
- **kubectl** configured with cluster access
- **kubectl-oidc-login** plugin (`brew install kubelogin`)
- **Finch** or **Docker** for container builds
- **A Kubernetes cluster** with [jupyter-k8s](https://github.com/jupyter-infra/jupyter-k8s) operator installed

### Development Setup

1. **Fork and clone**:

   ```bash
   git clone https://github.com/YOUR_USERNAME/jupyter-k8s-ui.git
   cd jupyter-k8s-ui
   ```

2. **Configure kubeconfig** (one-time):

   Your kubeconfig needs OIDC credentials for the cluster. Run the `set-kubeconfig.sh` script from your cluster admin:

   ```bash
   bash set-kubeconfig.sh
   ```

   See [README.md](README.md#1-configure-kubeconfig-one-time) for details.

3. **Install dependencies**:

   ```bash
   make deps
   ```

4. **Get a development token**:

   ```bash
   make refresh-token
   ```

   A browser window opens for GitHub OAuth. The token is saved to `.env` automatically.

5. **Start development servers**:

   ```bash
   make dev-full
   ```

   - Frontend: http://localhost:5173
   - Backend: http://localhost:8090

6. **Verify**:
   - http://localhost:8090/api/v1/health should return `{"status":"ok"}`
   - http://localhost:5173 should show the workspace list

> **Token expiry:** If API calls return 401, re-run `make refresh-token`.

Run `make help` to see all available targets.

## Project Structure

```
jupyter-k8s-ui/
├── src/                      # Frontend source
│   ├── api/                  # API client & React Query hooks
│   ├── components/           # React components
│   │   ├── ui/               # Reusable UI components
│   │   ├── workspace/        # Workspace-specific components
│   │   └── layout/           # Layout components
│   ├── pages/                # Page components (routes)
│   ├── context/              # React context providers
│   ├── constants/            # UI strings, config
│   ├── styles/               # Global styles & CSS modules
│   └── types/                # TypeScript type definitions
├── server/                   # Backend server
│   ├── index.ts              # Server entry point
│   ├── k8s.ts                # Kubernetes client
│   └── types.ts              # CRD type definitions
├── Makefile                  # Build, dev, deploy targets
└── Dockerfile                # Production container image
```

## How to Contribute

### 1. Find an Issue

- Browse [open issues](https://github.com/jupyter-infra/jupyter-k8s-ui/issues)
- Look for `good first issue` or `help wanted` labels
- Or open an issue to propose a new feature

### 2. Create a Branch

```bash
git checkout -b feature/your-feature-name
```

Branch naming: `feature/`, `fix/`, `docs/`, `refactor/`

### 3. Make Your Changes

Follow the coding guidelines below.

### 4. Validate

```bash
make lint        # Run eslint
make build       # Verify build succeeds
make dev-full    # Test locally
```

### 5. Commit and Push

```bash
git commit -m "feat: add workspace filtering by status"
git push origin feature/your-feature-name
```

Commit prefixes: `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`

### 6. Open a Pull Request

Include:

- Clear title describing the change
- Description of what changed and why
- Link to related issues
- Screenshots for UI changes

## Coding Guidelines

### TypeScript

- TypeScript strict mode everywhere
- Define types for all props, state, and API responses
- Avoid `any` — use proper types or `unknown`
- Export shared types from `src/types/`

### React Components

- Functional components with hooks (no class components)
- Small, focused components with single responsibility
- CSS Modules for component styles (`.module.css`)
- Use existing MUI components where possible

### State Management

- **React Query** for server state (API data)
- **React Context** for global UI state (theme, auth)
- **useState** for component-local state

### Styling

- CSS Modules for component styles
- CSS variables for theming (see `src/styles/`)
- Responsive design
- Accessibility: proper ARIA labels, keyboard navigation, focus indicators

### Backend

- All server code in `server/`
- Error handling with proper HTTP status codes
- Never log tokens or sensitive data
- JSDoc comments for public functions

## Testing Checklist

Before submitting a PR:

- [ ] `make lint` passes
- [ ] `make build` succeeds
- [ ] All pages load without errors
- [ ] Workspace CRUD operations work
- [ ] Loading and error states display correctly
- [ ] Dark/light theme switching works
- [ ] No console errors or warnings
- [ ] No secrets or tokens committed

## Security

- Never commit tokens or secrets
- `.env` is gitignored — use `.env.example` for documentation
- Validate user input on both frontend and backend
- Use React's built-in XSS escaping

## Deploying Changes

### Kind (local cluster)

```bash
make deploy-kind
```

### AWS (EKS)

```bash
make deploy-aws
```

By default, `finch` is used. Override with `CONTAINER_TOOL=docker`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
