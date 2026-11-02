#!/usr/bin/env bash
# =============================================================================
# publish-image.sh — build the demo app image and push it to a registry.
#
# Use this for the talk-day cloud cluster, which cannot see locally built
# images. Example:
#
#   ./scripts/publish-image.sh pablokbs/jev-ops-demo-app:2026.11
#   kubectl set image deployment/demo-app demo-app=pablokbs/jev-ops-demo-app:2026.11
#
# Requires docker login to the target registry beforehand.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DEMO_APP_IMAGE="${1:-}"
if [[ -z "${DEMO_APP_IMAGE}" ]]; then
  echo "Usage: publish-image.sh <registry>/<owner>/jev-ops-demo-app:<tag>" >&2
  echo "  e.g. ./scripts/publish-image.sh pablokbs/jev-ops-demo-app:2026.11" >&2
  exit 2
fi

echo "==> Building ${DEMO_APP_IMAGE}"
docker build -t "${DEMO_APP_IMAGE}" app/

echo "==> Pushing ${DEMO_APP_IMAGE}"
docker push "${DEMO_APP_IMAGE}"

echo
echo "Deploy on the cloud cluster with:"
echo "  kubectl set image deployment/demo-app demo-app=${DEMO_APP_IMAGE}"
echo "(and imagePullPolicy will pull it because the tag is versioned)"