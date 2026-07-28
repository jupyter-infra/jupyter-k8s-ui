# Image configuration
IMG ?= jk8s-application-web-app:latest
APPLICATION_IMAGE_PREFIX := jk8s-application
IMAGE_NAME := web-app
PLATFORM ?= linux/amd64

# CONTAINER_TOOL defines the container tool to be used for building images.
CONTAINER_TOOL ?= finch
BUILD_OPTS :=
CLOUD_PROVIDER :=

# Use Finch as the container provider for Kind when using Finch
ifeq ($(CONTAINER_TOOL),finch)
  export KIND_EXPERIMENTAL_PROVIDER=finch
  BUILD_OPTS := $(shell if [ -f /etc/os-release ]; then echo "--network host"; else echo ""; fi)
endif

# Remote cluster configuration
ifeq ($(CLOUD_PROVIDER),aws)
	AWS_REGION ?= us-west-2
	AWS_ACCOUNT_ID := $(shell aws sts get-caller-identity --query "Account" --output text)
	ECR_REGISTRY := $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com
	ECR_REPOSITORY := $(APPLICATION_IMAGE_PREFIX)-$(IMAGE_NAME)
	EKS_CLUSTER_NAME ?= jupyter-k8s-cluster
	EKS_CONTEXT := arn:aws:eks:$(AWS_REGION):$(AWS_ACCOUNT_ID):cluster/$(EKS_CLUSTER_NAME)
endif

# Kubernetes deployment configuration
NAMESPACE ?= jupyter-k8s-router
DEPLOYMENT ?= web-app
DEV_KIND_CLUSTER ?= jupyter-k8s-dev
SERVE_HOST_PORT ?= 8090

# `dev-sa-kubeconfig`: which ServiceAccount the local dev server should impersonate for
# namespace DISCOVERY (the per-pod listNamespace poll). In-cluster the web-app uses its own
# SA; locally there is none, so we mint a token for this SA and write a standalone kubeconfig
# the dev server points at via KUBECONFIG. The SA must have cluster-wide `list namespaces`.
WEBAPP_SA ?= web-app
WEBAPP_SA_NAMESPACE ?= jupyter-k8s-router
SA_TOKEN_DURATION ?= 24h
# Standalone kubeconfig written by `dev-sa-kubeconfig` (kept out of ~/.kube/config so your
# admin identity is untouched). Point the dev server at it: KUBECONFIG=<this> bun run dev:full
DEV_SA_KUBECONFIG ?= /tmp/jupyter-k8s-ui-dev-sa.kubeconfig
# Auto-exit for `serve-host`: it binds 0.0.0.0 with session auth off (anyone who can
# reach the URL acts as you), so cap the lifetime instead of leaving it up overnight.
# Override with SERVE_HOST_TIMEOUT=0 to disable, or e.g. SERVE_HOST_TIMEOUT=2h.
SERVE_HOST_TIMEOUT ?= 30m

SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -ec

KUBECTL ?= kubectl
KIND ?= kind

.PHONY: all
all: build

##@ General

.PHONY: help
help: ## Display this help.
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_0-9-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

.PHONY: deps
deps: ## Install dependencies.
	bun install

.PHONY: lint
lint: ## Run eslint linter.
	bun run lint

.PHONY: lint-fix
lint-fix: ## Run eslint linter and perform fixes.
	bun run lint --fix

.PHONY: format
format: ## Format code with prettier.
	bun run format

.PHONY: format-check
format-check: ## Check code formatting.
	bun run format:check

##@ Build

.PHONY: build
build: ## Build the frontend and server.
	bun run build:full

.PHONY: docker-build
docker-build: ## Build docker image with the web app.
	$(CONTAINER_TOOL) build $(BUILD_OPTS) --platform=$(PLATFORM) -t ${IMG} .

.PHONY: docker-push
docker-push: ## Push docker image with the web app.
	$(CONTAINER_TOOL) push ${IMG}

##@ Development

.PHONY: refresh-token
refresh-token: ## Fetch a fresh OIDC token and set up .env for local development.
	@if [ ! -f .env ]; then cp .env.example .env; echo "Created .env from .env.example"; fi
	@OIDC_ARGS=$$(kubectl config view --raw 2>/dev/null | grep -E -- '--(oidc-|listen-address)' | sed 's/^[[:space:]]*- //' | tr '\n' ' '); \
	if [ -z "$$OIDC_ARGS" ]; then \
		echo ""; \
		echo "ERROR: No OIDC configuration found in kubeconfig."; \
		echo ""; \
		echo "Your kubeconfig needs OIDC credentials for the cluster."; \
		echo "Ask your cluster admin for the set-kubeconfig.sh script and run it:"; \
		echo ""; \
		echo "  bash set-kubeconfig.sh"; \
		echo ""; \
		echo "Then retry: make refresh-token"; \
		exit 1; \
	fi; \
	echo "Fetching OIDC token (browser may open for auth)..."; \
	TMPFILE=$$(mktemp); \
	if ! kubectl oidc-login get-token $$OIDC_ARGS > "$$TMPFILE" 2>&1; then \
		echo ""; \
		echo "ERROR: OIDC token fetch failed. Common causes:"; \
		echo ""; \
		echo "  1. Stale client credentials - the Dex client secret in your kubeconfig"; \
		echo "     may have been rotated. Ask your cluster admin for an updated"; \
		echo "     set-kubeconfig.sh script and re-run it."; \
		echo ""; \
		echo "  2. Missing kubectl-oidc-login plugin - install with: brew install kubelogin"; \
		echo ""; \
		echo "  3. Network issue - ensure you can reach the OIDC issuer URL."; \
		echo ""; \
		cat "$$TMPFILE"; \
		rm -f "$$TMPFILE"; \
		exit 1; \
	fi; \
	TOKEN=$$(jq -r '.status.token' "$$TMPFILE"); \
	rm -f "$$TMPFILE"; \
	if [ -z "$$TOKEN" ] || [ "$$TOKEN" = "null" ]; then \
		echo ""; \
		echo "ERROR: Got a response but no token found."; \
		echo "Ensure kubectl-oidc-login plugin is installed: brew install kubelogin"; \
		exit 1; \
	fi; \
	TMPENV=$$(mktemp); \
	sed "s|^DEV_ACCESS_TOKEN=.*|DEV_ACCESS_TOKEN=$$TOKEN|" .env > "$$TMPENV" && mv "$$TMPENV" .env; \
	echo "DEV_ACCESS_TOKEN updated in .env"

.PHONY: dev-sa-kubeconfig
dev-sa-kubeconfig: ## Mint a web-app SA token + write a kubeconfig for local namespace DISCOVERY (needs admin kubeconfig).
	@# Assumes the CURRENT kubeconfig is an ADMIN context on the target cluster (e.g. after
	@# `jd cluster login`). Mints a token for the web-app SA and writes a standalone kubeconfig
	@# that authenticates AS that SA, reusing the current context's cluster server + CA. The
	@# dev server's namespace poll (loadKubeConfigBestEffort) then discovers namespaces with
	@# the SA — mirroring in-cluster behavior — while per-user requests still use the
	@# DEV_ACCESS_TOKEN from .env (createKubeConfig overrides only the user, not the cluster).
	@command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required."; exit 1; }
	@echo "Minting token for SA $(WEBAPP_SA_NAMESPACE)/$(WEBAPP_SA) (duration $(SA_TOKEN_DURATION))..."
	@SA_TOKEN=$$($(KUBECTL) create token $(WEBAPP_SA) -n $(WEBAPP_SA_NAMESPACE) --duration=$(SA_TOKEN_DURATION) 2>/dev/null) || \
		SA_TOKEN=$$($(KUBECTL) create token $(WEBAPP_SA) -n $(WEBAPP_SA_NAMESPACE)); \
	if [ -z "$$SA_TOKEN" ]; then \
		echo "ERROR: failed to mint SA token. Is the current kubeconfig an admin on the cluster, and does SA $(WEBAPP_SA_NAMESPACE)/$(WEBAPP_SA) exist?"; \
		exit 1; \
	fi; \
	CTX=$$($(KUBECTL) config current-context); \
	CLUSTER=$$($(KUBECTL) config view -o jsonpath="{.contexts[?(@.name==\"$$CTX\")].context.cluster}"); \
	SERVER=$$($(KUBECTL) config view --raw -o jsonpath="{.clusters[?(@.name==\"$$CLUSTER\")].cluster.server}"); \
	CA=$$($(KUBECTL) config view --raw -o jsonpath="{.clusters[?(@.name==\"$$CLUSTER\")].cluster.certificate-authority-data}"); \
	if [ -z "$$SERVER" ] || [ -z "$$CA" ]; then \
		echo "ERROR: could not read cluster server/CA from the current kubeconfig context ($$CTX)."; \
		exit 1; \
	fi; \
	umask 077; \
	printf 'apiVersion: v1\nkind: Config\nclusters:\n  - name: dev-sa\n    cluster:\n      server: %s\n      certificate-authority-data: %s\nusers:\n  - name: web-app-sa\n    user:\n      token: %s\ncontexts:\n  - name: web-app-sa@dev-sa\n    context:\n      cluster: dev-sa\n      user: web-app-sa\ncurrent-context: web-app-sa@dev-sa\n' \
		"$$SERVER" "$$CA" "$$SA_TOKEN" > "$(DEV_SA_KUBECONFIG)"; \
	echo "Wrote $(DEV_SA_KUBECONFIG)"; \
	WHO=$$(KUBECONFIG="$(DEV_SA_KUBECONFIG)" $(KUBECTL) auth whoami -o jsonpath='{.status.userInfo.username}' 2>/dev/null); \
	echo "  authenticates as: $$WHO"; \
	CANLIST=$$(KUBECONFIG="$(DEV_SA_KUBECONFIG)" $(KUBECTL) auth can-i list namespaces 2>/dev/null); \
	echo "  can list namespaces: $$CANLIST"; \
	if [ "$$CANLIST" != "yes" ]; then \
		echo "  WARNING: this SA cannot cluster-list namespaces — discovery will fall back to WORKSPACE_NAMESPACES."; \
		echo "  Grant it, e.g.: kubectl create clusterrole web-app-namespace-discovery --verb=get,list,watch --resource=namespaces && \\"; \
		echo "                  kubectl create clusterrolebinding web-app-namespace-discovery --clusterrole=web-app-namespace-discovery --serviceaccount=$(WEBAPP_SA_NAMESPACE):$(WEBAPP_SA)"; \
	fi; \
	echo ""; \
	echo "Now start the dev server pointed at this kubeconfig (per-user requests still use DEV_ACCESS_TOKEN from .env):"; \
	echo "  KUBECONFIG=$(DEV_SA_KUBECONFIG) bun run dev:full"

.PHONY: dev
dev: ## Run the frontend dev server (Vite).
	bun run dev

.PHONY: dev-server
dev-server: ## Run the backend dev server (Bun).
	bun run dev:server

.PHONY: dev-full
dev-full: ## Run both frontend and backend dev servers concurrently.
	bun run dev:full

.PHONY: start
start: build ## Build and start the production server.
	bun run start

.PHONY: serve-host
serve-host: build ## Build + serve the whole app (UI + API) on all interfaces
	@if [ ! -f .env ] || ! grep -q '^DEV_ACCESS_TOKEN=..' .env; then \
		echo "ERROR: no DEV_ACCESS_TOKEN in .env — run 'make refresh-token' first."; exit 1; \
	fi
	@echo "Serving at http://$$(hostname):$(SERVE_HOST_PORT)"
	@echo "Note: dev mode — requests use YOUR token from .env; anyone who can reach this URL acts as you."
	@if [ "$(SERVE_HOST_TIMEOUT)" != "0" ]; then \
		echo "Auto-exit after $(SERVE_HOST_TIMEOUT) (override with SERVE_HOST_TIMEOUT=0 to disable)."; \
	fi
	@set -a; . ./.env; set +a; \
		if [ "$(SERVE_HOST_TIMEOUT)" != "0" ] && command -v timeout >/dev/null 2>&1; then \
			NODE_ENV=development SESSION_ENABLED=false PORT=$(SERVE_HOST_PORT) timeout --foreground $(SERVE_HOST_TIMEOUT) bun run server/index.ts; \
		else \
			NODE_ENV=development SESSION_ENABLED=false PORT=$(SERVE_HOST_PORT) bun run server/index.ts; \
		fi

##@ Kind Deployment

.PHONY: kubectl-kind
kubectl-kind: ## Configure kubectl to use kind cluster.
	@echo "Setting kubectl context to kind-$(DEV_KIND_CLUSTER)..."
	@if kubectl config get-contexts | grep -q "kind-$(DEV_KIND_CLUSTER)"; then \
		kubectl config use-context kind-$(DEV_KIND_CLUSTER); \
		echo "kubectl configured to use kind cluster."; \
	else \
		echo "kind-$(DEV_KIND_CLUSTER) context not found. Try 'make setup-kind' in jupyter-k8s repo."; \
		exit 1; \
	fi
	@kubectl cluster-info || { echo "Cannot connect to kind cluster."; exit 1; }

.PHONY: load-image-kind
load-image-kind: docker-build ## Build and load image into the Kind cluster.
	@echo "Loading web-app image ${IMG} into kind cluster $(DEV_KIND_CLUSTER)..."
	@mkdir -p /tmp/kind-images
	$(CONTAINER_TOOL) save ${IMG} -o /tmp/kind-images/web-app.tar
	$(KIND) load image-archive /tmp/kind-images/web-app.tar --name $(DEV_KIND_CLUSTER)
	rm -f /tmp/kind-images/web-app.tar

.PHONY: deploy-kind
deploy-kind: load-image-kind kubectl-kind ## Build, load, and deploy web app to a kind cluster.
	$(KUBECTL) rollout restart deployment/$(DEPLOYMENT) -n $(NAMESPACE)
	@echo "Web app deployment restarted in kind cluster"

##@ AWS Deployment

.PHONY: kubectl-aws
kubectl-aws: ## Configure kubectl to use remote cluster.
	$(MAKE) kubectl-aws-internal CLOUD_PROVIDER=aws

kubectl-aws-internal:
	@echo "Setting up kubectl to use remote cluster..."
	@if kubectl config get-contexts | grep -q "$(EKS_CLUSTER_NAME)"; then \
		kubectl config use-context "$(EKS_CONTEXT)"; \
		echo "kubectl configured to use remote cluster."; \
	else \
		echo "EKS cluster context not found. Try 'make setup-aws' in jupyter-k8s repo."; \
		exit 1; \
	fi

.PHONY: load-image-aws
load-image-aws: ## Build and push web app image to ECR.
	$(MAKE) load-image-aws-internal CLOUD_PROVIDER=aws

load-image-aws-internal: docker-build
	@echo "Logging in to ECR..."
	aws ecr get-login-password --region $(AWS_REGION) | $(CONTAINER_TOOL) login --username AWS --password-stdin $(ECR_REGISTRY)
	@echo "Creating ECR repository if it doesn't exist..."
	aws ecr describe-repositories --repository-names $(ECR_REPOSITORY) --region $(AWS_REGION) > /dev/null || \
	aws ecr create-repository --repository-name $(ECR_REPOSITORY) --region $(AWS_REGION)
	@echo "Pushing web-app image to ECR..."
	$(CONTAINER_TOOL) tag ${IMG} $(ECR_REGISTRY)/$(ECR_REPOSITORY):latest
	$(CONTAINER_TOOL) push $(ECR_REGISTRY)/$(ECR_REPOSITORY):latest
	@echo "Web app image pushed successfully to $(ECR_REGISTRY)/$(ECR_REPOSITORY):latest"

.PHONY: deploy-aws
deploy-aws: ## Build, push, and deploy web app to AWS cluster.
	$(MAKE) deploy-aws-internal CLOUD_PROVIDER=aws

deploy-aws-internal: load-image-aws-internal
	@echo "Restarting web-app deployment to use new image..."
	$(KUBECTL) rollout restart deployment/$(DEPLOYMENT) -n $(NAMESPACE)
	@echo "Web app deployment restarted in AWS cluster"

##@ Unit Testing

.PHONY: test
test: ## Run all unit tests (server + client).
	bun run test

.PHONY: test-server
test-server: ## Run server unit tests.
	bun run test:server

.PHONY: test-client
test-client: ## Run client unit tests.
	bun run test:client

##@ E2E Testing

# Public GHCR images (no auth required)
E2E_CONTROLLER_REPO ?= ghcr.io/jupyter-infra/jupyter-k8s-controller
E2E_CONTROLLER_TAG ?= latest
E2E_CONTROLLER_IMAGE := $(E2E_CONTROLLER_REPO):$(E2E_CONTROLLER_TAG)
E2E_ROTATOR_IMAGE ?= ghcr.io/jupyter-infra/jupyter-k8s-rotator:latest
E2E_CHART_SOURCE ?= oci://ghcr.io/jupyter-infra/charts/jupyter-k8s
# Update when CRD contract changes
E2E_CHART_VERSION ?= 0.1.2
# Image for workspace pods is injected by the default WorkspaceTemplate fixture
# (e2e/fixtures/default-template.yaml). No need to pass it to the test.
E2E_WORKSPACE_IMAGE ?= nginx:latest
E2E_KIND_CLUSTER ?= jupyter-k8s-dev
E2E_SERVER_PORT ?= 8091
E2E_SERVER_PID_FILE := /tmp/jupyter-k8s-ui-e2e-server-$(E2E_SERVER_PORT).pid

.PHONY: test-e2e
test-e2e: setup-e2e load-images-e2e deploy-e2e ## Run Playwright E2E tests (sets up cluster + server automatically).
	@$(MAKE) _e2e-start-server
	@E2E_BASE_URL=http://localhost:$(E2E_SERVER_PORT) E2E_WORKSPACE_IMAGE=$(E2E_WORKSPACE_IMAGE) E2E_KIND_CLUSTER=$(E2E_KIND_CLUSTER) bunx playwright test; \
		EXIT_CODE=$$?; \
		$(MAKE) _e2e-stop-server; \
		exit $$EXIT_CODE

.PHONY: setup-e2e
setup-e2e: ## Create Kind cluster and install cert-manager.
	@if ! $(KIND) get clusters 2>/dev/null | grep -q "$(E2E_KIND_CLUSTER)"; then \
		echo "Creating Kind cluster '$(E2E_KIND_CLUSTER)'..."; \
		$(KIND) create cluster --name $(E2E_KIND_CLUSTER) --wait 60s; \
	else \
		echo "Kind cluster '$(E2E_KIND_CLUSTER)' already running."; \
	fi
	@# startupapicheck disabled: the post-install hook pulls an extra image from
	@# quay.io and hangs on GitHub Actions runners due to rate limiting. The
	@# operator helm install (next step) validates cert-manager readiness implicitly.
	@if ! kubectl --context kind-$(E2E_KIND_CLUSTER) get namespace cert-manager > /dev/null 2>&1; then \
		echo "Installing cert-manager..."; \
		helm repo add jetstack https://charts.jetstack.io --force-update; \
		helm install cert-manager jetstack/cert-manager \
			--namespace cert-manager --create-namespace \
			--set crds.enabled=true \
			--set startupapicheck.enabled=false \
			--kube-context kind-$(E2E_KIND_CLUSTER) \
			--wait --timeout 120s; \
	fi

# Pull a (possibly multi-arch) image and load it into the Kind node as a SINGLE-platform
# image. Why the flatten step: the E2E images on GHCR are multi-arch manifest lists, but
# kind v0.30's node-side import runs `ctr images import --all-platforms`, which demands
# every referenced platform's blobs — including arm64 ones we never pull on an amd64 host —
# and fails with "content digest ... not found". `finch save --platform` still embeds the
# multi-arch index, so it doesn't help. A FROM-only rebuild produces a fresh single-manifest
# image (no index), which `kind load image-archive` imports cleanly. (jk8s's e2e never hits
# this because it loads LOCALLY-BUILT single-platform images, not multi-arch pulls.)
# Args: $(1)=image ref  $(2)=short name for the tar file.
define load_image_e2e
	@$(CONTAINER_TOOL) pull --platform linux/amd64 $(1)
	@mkdir -p /tmp/kind-images/$(2)
	@printf 'FROM %s\n' "$(1)" > /tmp/kind-images/$(2)/Dockerfile
	$(CONTAINER_TOOL) build --platform=linux/amd64 -t $(1) -f /tmp/kind-images/$(2)/Dockerfile /tmp/kind-images/$(2)
	$(CONTAINER_TOOL) save $(1) -o /tmp/kind-images/$(2).tar
	$(KIND) load image-archive /tmp/kind-images/$(2).tar --name $(E2E_KIND_CLUSTER)
	@rm -rf /tmp/kind-images/$(2).tar /tmp/kind-images/$(2)
endef

.PHONY: load-images-e2e
load-images-e2e: ## Pull and load all E2E images into Kind (flattened to single-platform; see load_image_e2e).
	$(call load_image_e2e,$(E2E_CONTROLLER_IMAGE),controller)
	$(call load_image_e2e,$(E2E_ROTATOR_IMAGE),rotator)
	$(call load_image_e2e,$(E2E_WORKSPACE_IMAGE),workspace)

.PHONY: deploy-e2e
deploy-e2e: ## Install jupyter-k8s Helm chart into Kind cluster.
	@helm upgrade --install jupyter-k8s $(E2E_CHART_SOURCE) \
		--version $(E2E_CHART_VERSION) \
		--namespace jupyter-k8s-system --create-namespace \
		--set manager.image.repository=$(E2E_CONTROLLER_REPO) \
		--set manager.image.tag=$(E2E_CONTROLLER_TAG) \
		--kube-context kind-$(E2E_KIND_CLUSTER) \
		--wait --timeout 120s
	@echo "Waiting for webhook to accept connections..."
	@kubectl --context kind-$(E2E_KIND_CLUSTER) wait --for=condition=Available \
		deployment/jupyter-k8s-controller-manager -n jupyter-k8s-system --timeout=120s
	@echo "Verifying CRD API accepts writes..."
	@for i in $$(seq 1 45); do \
		RESULT=$$(echo '{"apiVersion":"workspace.jupyter.org/v1alpha1","kind":"Workspace","metadata":{"name":"e2e-readiness-check","namespace":"default"},"spec":{"desiredStatus":"Stopped"}}' | \
			kubectl --context kind-$(E2E_KIND_CLUSTER) create --dry-run=server -f - 2>&1 || true); \
		if echo "$$RESULT" | grep -q "created"; then \
			echo "  CRD API ready."; \
			break; \
		fi; \
		echo "  Attempt $$i: $$RESULT"; \
		if [ $$i -eq 45 ]; then echo "ERROR: CRD API not ready after 90s."; exit 1; fi; \
		sleep 2; \
	done
	@echo "Applying E2E fixtures (RBAC + test data)..."
	@kubectl --context kind-$(E2E_KIND_CLUSTER) apply -f e2e/fixtures/
	@kubectl --context kind-$(E2E_KIND_CLUSTER) auth can-i create workspaces.workspace.jupyter.org \
		--as=system:serviceaccount:default:e2e-test -n default | grep -q "yes" || \
		{ echo "ERROR: e2e-test SA lacks workspace create permission"; exit 1; }

.PHONY: _e2e-start-server
_e2e-start-server:
	@$(MAKE) _e2e-stop-server 2>/dev/null || true
	@echo "Building frontend..."
	@bun run build:full
	@E2E_TOKEN=$$(kubectl --context kind-$(E2E_KIND_CLUSTER) create token e2e-test -n default --duration=30m) && \
		NODE_ENV=development \
		DEV_ACCESS_TOKEN=$$E2E_TOKEN \
		NAMESPACE=default \
		WORKSPACE_NAMESPACES=default,e2e-team-b \
		SHARED_TEMPLATE_NAMESPACE=e2e-shared \
		NAMESPACE_CANDIDATE_CAP=5 \
		NAMESPACE_VISIBLE_PERSIST_CAP=8 \
		NAMESPACE_POLL_INTERVAL_SECS=5 \
		SESSION_ENABLED=false \
		PORT=$(E2E_SERVER_PORT) \
		bun run server/index.ts & echo $$! > $(E2E_SERVER_PID_FILE)
	@for i in $$(seq 1 30); do \
		if curl -sf http://localhost:$(E2E_SERVER_PORT)/api/v1/health > /dev/null 2>&1; then \
			echo "Server ready on port $(E2E_SERVER_PORT)."; \
			break; \
		fi; \
		if [ $$i -eq 30 ]; then echo "Server failed to start."; $(MAKE) _e2e-stop-server; exit 1; fi; \
		sleep 1; \
	done

.PHONY: _e2e-stop-server
_e2e-stop-server:
	@if [ -f $(E2E_SERVER_PID_FILE) ]; then \
		kill $$(cat $(E2E_SERVER_PID_FILE)) 2>/dev/null || true; \
		rm -f $(E2E_SERVER_PID_FILE); \
	fi

.PHONY: cleanup-e2e
cleanup-e2e: ## Delete the E2E Kind cluster.
	$(KIND) delete cluster --name $(E2E_KIND_CLUSTER)

##@ Code Review

.PHONY: review
review: ## AI review of the current branch vs main (roborev, runs locally, no daemon)
	@command -v roborev >/dev/null 2>&1 || { echo "roborev not found. Install it from https://roborev.io, then optionally run 'make review-setup'."; exit 1; }
	roborev review --branch --local --wait

.PHONY: review-setup
review-setup: ## Opt-in: install the roborev post-commit hook for continuous local review
	@command -v roborev >/dev/null 2>&1 || { echo "roborev not found. Install it from https://roborev.io first."; exit 1; }
	roborev init --agent claude-code

##@ Cleanup

.PHONY: clean
clean: ## Remove built artifacts and docker images.
	rm -rf dist node_modules/.tmp
	$(CONTAINER_TOOL) rmi ${IMG} || true

.PHONY: info
info: ## Show current configuration.
	@echo "Image: $(IMG)"
	@echo "Platform: $(PLATFORM)"
	@echo "Container Tool: $(CONTAINER_TOOL)"
	@echo "Kind Cluster: $(DEV_KIND_CLUSTER)"
	@echo "Namespace: $(NAMESPACE)"
	@echo "Deployment: $(DEPLOYMENT)"
	@if [ "$(CLOUD_PROVIDER)" = "aws" ]; then \
		echo "AWS Configuration:"; \
		echo "  ECR Registry: $(ECR_REGISTRY)"; \
		echo "  ECR Repository: $(ECR_REPOSITORY)"; \
		echo "  AWS Region: $(AWS_REGION)"; \
		echo "  EKS Cluster: $(EKS_CLUSTER_NAME)"; \
	fi
