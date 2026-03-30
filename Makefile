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
