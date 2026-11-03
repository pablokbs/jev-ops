#!/usr/bin/env bash
# =============================================================================
# demo-up.sh — bring up the jev-ops live-cluster demo.
#
#   - Uses kubectl's current context if a cluster is already reachable
#     (local kind, minikube, or an external cloud cluster via K8S_KUBECONFIG).
#   - Otherwise creates a local kind cluster named $KIND_CLUSTER.
#   - On kind: builds demo-app:local and loads it into the cluster.
#   - On any other (external) cluster: deploys the published registry image
#     (PUBLISHED_IMAGE below) — a local build is useless there because the
#     nodes cannot see your Docker daemon. Also verifies the tag exists in
#     the registry before deploying, so you get a clear error instead of
#     ImagePullBackOff.
#   - Applies the Deployment and waits for the rollout.
#
# Env:
#   DEMO_APP_IMAGE   override the image tag (default: demo-app:local on kind,
#                    PUBLISHED_IMAGE on external clusters)
#   KIND_CLUSTER     kind cluster name (default: jev-ops-demo)
#   K8S_NAMESPACE    namespace to deploy into (default: default)
#   K8S_KUBECONFIG   external kubeconfig (skips kind creation entirely)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# Keep in sync with DEFAULT_IMAGE in publish-image.sh.
PUBLISHED_IMAGE="pablokbs/jev-ops-demo-app:2026.11"
DEMO_APP_IMAGE="${DEMO_APP_IMAGE:-}"
KIND_CLUSTER="${KIND_CLUSTER:-jev-ops-demo}"
K8S_NAMESPACE="${K8S_NAMESPACE:-default}"
JEVOPS_BIN="${JEVOPS_BIN:-jev-ops}"

step() { echo; echo "==> $*"; }

if ! command -v "${JEVOPS_BIN}" >/dev/null 2>&1; then
  echo "ERROR: jev-ops binary not found ('${JEVOPS_BIN}')." >&2
  echo "  Install the prebuilt release, see README.md 'Requirements'." >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "ERROR: kubectl not found on PATH." >&2
  exit 1
fi

step "Checking cluster reachability"
if kubectl cluster-info >/dev/null 2>&1; then
  echo "Using existing cluster: $(kubectl config current-context 2>/dev/null || echo 'unknown')"
else
  if [[ -n "${K8S_KUBECONFIG:-}" ]]; then
    echo "ERROR: K8S_KUBECONFIG=${K8S_KUBECONFIG} is set but the cluster is not reachable." >&2
    echo "  Check the kubeconfig and that kubectl works: kubectl cluster-info" >&2
    exit 1
  fi
  step "Creating kind cluster '${KIND_CLUSTER}'"
  if ! kind get clusters 2>/dev/null | grep -qx "${KIND_CLUSTER}"; then
    kind create cluster --name "${KIND_CLUSTER}"
  else
    echo "kind cluster '${KIND_CLUSTER}' already exists; using it."
    kubectl cluster-info --context "kind-${KIND_CLUSTER}" >/dev/null 2>&1 || true
    kubectl config use-context "kind-${KIND_CLUSTER}" >/dev/null
  fi
fi

# Pick the image strategy for the cluster we are actually talking to.
if kubectl config current-context 2>/dev/null | grep -q "kind-"; then
  IS_KIND=1
else
  IS_KIND=0
fi

if [[ -z "${DEMO_APP_IMAGE}" ]]; then
  if [[ "${IS_KIND}" == 1 ]]; then
    DEMO_APP_IMAGE="demo-app:local"
  else
    DEMO_APP_IMAGE="${PUBLISHED_IMAGE}"
  fi
fi

if [[ "${IS_KIND}" == 1 ]]; then
  step "Building demo app image '${DEMO_APP_IMAGE}'"
  docker build -q -t "${DEMO_APP_IMAGE}" app/ >/dev/null
  echo "Image built."

  step "Loading image into kind"
  kind load docker-image "${DEMO_APP_IMAGE}" --name "${KIND_CLUSTER}"
else
  step "External cluster — using registry image '${DEMO_APP_IMAGE}'"
  echo "Skipping local build; external nodes pull from the registry."
  if ! docker buildx imagetools inspect "${DEMO_APP_IMAGE}" >/dev/null 2>&1; then
    echo "ERROR: '${DEMO_APP_IMAGE}' is not pullable (missing tag or registry auth)." >&2
    echo "  Publish it first: ./scripts/publish-image.sh ${DEMO_APP_IMAGE}" >&2
    exit 1
  fi
fi

step "Applying manifests (namespace '${K8S_NAMESPACE}')"
kubectl create namespace "${K8S_NAMESPACE}" >/dev/null 2>&1 || true
kubectl apply -f k8s/deployment.yaml -n "${K8S_NAMESPACE}"
kubectl set image deployment/demo-app demo-app="${DEMO_APP_IMAGE}" -n "${K8S_NAMESPACE}"

step "Waiting for rollout"
kubectl rollout status deployment/demo-app -n "${K8S_NAMESPACE}" --timeout=240s

echo
echo "Demo is up. Start the dashboard:"
echo "  cd demo/live-cluster && export TYPESAFE_API_KEY=... && npm run dev"
echo "  → http://localhost:8080"