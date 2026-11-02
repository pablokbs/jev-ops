#!/usr/bin/env bash
# =============================================================================
# trigger-fault.sh — inject (or clear) a fault in the demo app from the terminal.
#
#   ./scripts/trigger-fault.sh boom    # 500s + DB error logs
#   ./scripts/trigger-fault.sh crash   # process exits -> CrashLoopBackOff
#   ./scripts/trigger-fault.sh oom     # allocate until OOMKilled
#   ./scripts/trigger-fault.sh reset   # back to normal (deletes stuck pods if needed)
#   ./scripts/trigger-fault.sh status  # pod table
#
# Env: K8S_NAMESPACE, DEMO_APP_PORT, K8S_KUBECONFIG/K8S_CONTEXT (as usual).
# =============================================================================
set -euo pipefail

MODE="${1:-}"
NS="${K8S_NAMESPACE:-default}"
APP_PORT="${DEMO_APP_PORT:-3000}"

case "${MODE}" in
  boom|crash|oom)
    POD="$(kubectl get pods -l app=demo-app -n "${NS}" \
      -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' 2>/dev/null | awk '{print $1}')"
    if [[ -z "${POD}" ]]; then
      echo "No running pod to exec into (cluster may be degraded)." >&2
      echo "Recover with: kubectl delete pod -l app=demo-app -n ${NS}" >&2
      exit 1
    fi
    echo "Triggering /${MODE} in ${POD}"
    kubectl exec -n "${NS}" "${POD}" -- wget -qO- "http://localhost:${APP_PORT}/${MODE}"
    echo
    ;;
  reset)
    POD="$(kubectl get pods -l app=demo-app -n "${NS}" \
      -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' 2>/dev/null | awk '{print $1}')"
    if [[ -n "${POD}" ]]; then
      echo "Clearing fault in ${POD}"
      kubectl exec -n "${NS}" "${POD}" -- wget -qO- "http://localhost:${APP_PORT}/reset"
    else
      echo "No running pod — deleting demo-app pods so the Deployment recreates them."
      kubectl delete pod -l app=demo-app -n "${NS}" --wait=false
    fi
    echo
    ;;
  status)
    kubectl get pods -l app=demo-app -n "${NS}"
    ;;
  *)
    echo "Usage: trigger-fault.sh <boom|crash|oom|reset|status>" >&2
    exit 2
    ;;
esac