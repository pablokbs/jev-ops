#!/usr/bin/env bash
# =============================================================================
# publish-image.sh — build the demo app image and push it to a registry.
#
# Use this for the talk-day cloud cluster, which cannot see locally built
# images. Builds multi-arch (PLATFORMS, default linux/amd64,linux/arm64) so
# the image runs both on Apple Silicon and on amd64 cloud nodes — a plain
# `docker build` here produces arm64-only, which amd64 nodes cannot pull.
#
# With no argument it pushes to Docker Hub (DEFAULT_IMAGE below):
#
#   ./scripts/publish-image.sh
#   kubectl set image deployment/demo-app demo-app=pablokbs/jev-ops-demo-app:2026.11
#
# Override with an explicit tag:
#   ./scripts/publish-image.sh <registry>/<owner>/jev-ops-demo-app:<tag>
#
# Requires docker login to the target registry beforehand.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DEFAULT_IMAGE="pablokbs/jev-ops-demo-app:2026.11"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
DEMO_APP_IMAGE="${1:-${DEFAULT_IMAGE}}"

# buildx builds both platforms and pushes a manifest list in one step.
echo "==> Building+pushing ${DEMO_APP_IMAGE} (${PLATFORMS})"
if ! docker buildx build --platform "${PLATFORMS}" -t "${DEMO_APP_IMAGE}" --push app/; then
  echo "ERROR: build/push failed. Are you logged in to the registry?" >&2
  echo "  Docker Hub: docker login" >&2
  exit 1
fi

echo
echo "Deploy on the cloud cluster with:"
echo "  kubectl set image deployment/demo-app demo-app=${DEMO_APP_IMAGE}"
echo "(and imagePullPolicy will pull it because the tag is versioned)"