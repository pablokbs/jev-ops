#!/usr/bin/env bash
# =============================================================================
# e2e-smoke.sh — end-to-end smoke test of the full demo stack.
#
# Runs the REAL pipeline (kubectl collection -> jev-ops -> typed decisions)
# against a real cluster (kind recommended), but with the OFFLINE mock
# provider so it needs zero API calls and zero TYPESAFE_API_KEY.
#
# What it validates, per fault mode (kubernetes pack, mock provider):
#   healthy -> health=healthy · boom (500s, no pod change) -> still healthy,
#              demo-app pack returns a structurally valid analysis
#   crash   -> root_cause=crashloop, needs_attention=yes
#   oom     -> needs_attention=yes + severity>=4 (the mock, which cannot be
#              modified, orders crashloop before oom — an OOM-killed pod IS in
#              CrashLoopBackOff; the live model discriminates via the
#              lastReason: OOMKilled signal, validated in the manual live check)
#   reset   -> back to healthy
#
# The semantic (live-model) expectations per fault are validated manually on
# talk day — the mock is plumbing-only by design.
#
# Usage: ./scripts/e2e-smoke.sh      (needs: kubectl, docker, jev-ops, jq, node)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

NS="${K8S_NAMESPACE:-default}"
JEVOPS_BIN="${JEVOPS_BIN:-jev-ops}"
SERVER_PORT="${E2E_SERVER_PORT:-8099}"
PROVIDER="mock"

PASS=0
FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS + 1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

require() {
  for tool in "$@"; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      echo "ERROR: '${tool}' is required but not found on PATH." >&2
      exit 1
    fi
  done
}

# wait_for <description> <timeout-secs> <command...>
wait_for() {
  local desc="$1" timeout="$2"
  shift 2
  local waited=0
  while ! "$@" >/dev/null 2>&1; do
    sleep 2
    waited=$((waited + 2))
    if [[ "${waited}" -ge "${timeout}" ]]; then
      echo "  ⏱ timed out waiting for: ${desc}" >&2
      return 1
    fi
  done
}

api() { # api <method> <path> [body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "${body}" ]]; then
    curl -s -X "${method}" "http://localhost:${SERVER_PORT}${path}" \
      -H 'Content-Type: application/json' -d "${body}"
  else
    curl -s -X "${method}" "http://localhost:${SERVER_PORT}${path}"
  fi
}

require jq node npm kubectl docker "${JEVOPS_BIN}"

# Deterministic isolation: Warning events accumulate in the namespace and would
# leak from one fault phase into the next (and the mock keys on their wording).
clear_events() {
  kubectl delete events -n "${NS}" --all >/dev/null 2>&1 || true
}
clear_events

echo "======================================================================"
echo " jev-ops live-cluster demo — e2e smoke test (provider: ${PROVIDER})"
echo "======================================================================"

# ---- 0. build the server --------------------------------------------------
echo "==> Building the dashboard server"
npm run build >/dev/null

# ---- 1. deploy ------------------------------------------------------------
echo "==> Deploying the demo app"
./scripts/demo-up.sh

# ---- 2. start the server (mock provider; cleans up on exit) ---------------
echo "==> Starting dashboard server on :${SERVER_PORT} (JEVOPS_PROVIDER=${PROVIDER})"
PORT="${SERVER_PORT}" JEVOPS_PROVIDER="${PROVIDER}" node dist/server.js >/tmp/jev-ops-e2e-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "${SERVER_PID}" 2>/dev/null || true' EXIT
wait_for "server up" 20 sh -c "curl -sf http://localhost:${SERVER_PORT}/api/config >/dev/null"
# The server must be OUR process (a leftover on the same port would answer too).
if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
  echo "ERROR: dashboard server died (port ${SERVER_PORT} busy?)" >&2
  tail -5 /tmp/jev-ops-e2e-server.log >&2 || true
  exit 1
fi

# ---- 3. healthy baseline --------------------------------------------------
echo "==> Healthy baseline"
wait_for "deployment ready" 240 kubectl rollout status deployment/demo-app -n "${NS}" --timeout=30s

STATUS="$(api GET /api/status)"
check_status() {
  echo "${STATUS}" | jq -e '.pods.running == 3' >/dev/null
}
if check_status; then ok "3 pods running"; else bad "expected 3 running pods, got: $(echo "${STATUS}" | jq -c '.pods')"; fi

LOGS="$(api GET '/api/logs?kind=app')"
if echo "${LOGS}" | jq -e '.lines | length > 0' >/dev/null; then ok "app log lines flowing"; else bad "no app log lines"; fi

ANALYZE="$(api POST /api/analyze '{}')"
K8S_HEALTH="$(echo "${ANALYZE}" | jq -r '.analyses[] | select(.pack=="kubernetes") | .decisions.health.value // "missing"')"
if [[ "${K8S_HEALTH}" == "healthy" ]]; then ok "kubernetes pack: health=healthy"; else bad "expected healthy, got: ${K8S_HEALTH}"; fi
DEMO_APP_OK="$(echo "${ANALYZE}" | jq -r '.analyses[] | select(.pack=="demo-app") | .ok')"
if [[ "${DEMO_APP_OK}" == "true" ]]; then ok "demo-app pack: valid analysis"; else bad "demo-app pack failed: $(echo "${ANALYZE}" | jq -c '.analyses[] | select(.pack=="demo-app")')"; fi

# ---- 4. boom (500s — no pod state change) ----------------------------------
echo "==> Boom mode (HTTP 500s + DB error logs)"
FAULT_RESP="$(api POST /api/fault '{"mode":"boom"}')"
if echo "${FAULT_RESP}" | jq -e '.ok == true' >/dev/null; then ok "boom: fault injected"; else bad "boom: fault POST failed: ${FAULT_RESP}"; fi
sleep 6
ANALYZE="$(api POST /api/analyze '{}')"
K8S_HEALTH="$(echo "${ANALYZE}" | jq -r '.analyses[] | select(.pack=="kubernetes") | .decisions.health.value // "missing"')"
if [[ "${K8S_HEALTH}" == "healthy" ]]; then ok "boom: cluster still healthy (expected — 500s don't change pod state)"; else bad "boom: expected healthy, got ${K8S_HEALTH}"; fi
if echo "${ANALYZE}" | jq -e '.analyses[] | select(.pack=="demo-app") | .ok' >/dev/null; then ok "boom: demo-app analysis structurally valid"; else bad "boom: demo-app analysis failed"; fi
api POST /api/fault '{"mode":"reset"}' >/dev/null
sleep 2

# ---- 5. crash loop ---------------------------------------------------------
echo "==> Crash loop"
FAULT_RESP="$(api POST /api/fault '{"mode":"crash"}')"
if echo "${FAULT_RESP}" | jq -e '.ok == true' >/dev/null; then ok "crash: fault injected"; else bad "crash: fault POST failed: ${FAULT_RESP}"; fi
# No `grep -q` in a pipe under pipefail: SIGPIPE would silently kill the script.
wait_crashloop() {
  local waited=0
  until ( set +o pipefail; kubectl get pods -l app=demo-app -n "${NS}" -o json \
    | jq -e 'any(.items[]; .status.containerStatuses[0].state.waiting.reason == "CrashLoopBackOff")' >/dev/null ); do
    sleep 2; waited=$((waited + 2))
    if [[ "${waited}" -ge 90 ]]; then echo "  ⏱ timed out waiting for CrashLoopBackOff" >&2; return 1; fi
  done
}
wait_crashloop
ANALYZE="$(api POST /api/analyze '{}')"
CRASH_CAUSE="$(echo "${ANALYZE}" | jq -r '.analyses[] | select(.pack=="kubernetes") | .decisions.root_cause.value // "missing"')"
CRASH_ATTN="$(echo "${ANALYZE}" | jq -r '.analyses[] | select(.pack=="kubernetes") | .decisions.needs_attention.value')"
if [[ "${CRASH_CAUSE}" == "crashloop" ]]; then ok "crash: root_cause=crashloop"; else bad "crash: expected crashloop, got: ${CRASH_CAUSE}"; fi
if [[ "${CRASH_ATTN}" == "true" ]]; then ok "crash: needs_attention=yes"; else bad "crash: expected attention, got: ${CRASH_ATTN}"; fi

# recover (server must clear running pods AND delete stuck crash-loop pods)
api POST /api/fault '{"mode":"reset"}' >/dev/null
wait_for "deployment recovered after crash" 240 kubectl wait --for=condition=Ready pod -l app=demo-app -n "${NS}" --timeout=30s
ok "crash: recovered via reset (pod deletion fallback)"
clear_events

# ---- 6. OOM ----------------------------------------------------------------
echo "==> OOM"
FAULT_RESP="$(api POST /api/fault '{"mode":"oom"}')"
if echo "${FAULT_RESP}" | jq -e '.ok == true' >/dev/null; then ok "oom: fault injected"; else bad "oom: fault POST failed: ${FAULT_RESP}"; fi
wait_oom() {
  local waited=0
  until ( set +o pipefail; kubectl get pods -l app=demo-app -n "${NS}" -o json \
    | jq -e 'any(.items[]; .status.containerStatuses[0].lastState.terminated.reason == "OOMKilled")' >/dev/null ); do
    sleep 2; waited=$((waited + 2))
    if [[ "${waited}" -ge 120 ]]; then echo "  ⏱ timed out waiting for OOMKilled" >&2; return 1; fi
  done
}
wait_oom
ANALYZE="$(api POST /api/analyze '{}')"
OOM_ATTN="$(echo "${ANALYZE}" | jq -r '.analyses[] | select(.pack=="kubernetes") | .decisions.needs_attention.value')"
OOM_SEV="$(echo "${ANALYZE}" | jq -r '.analyses[] | select(.pack=="kubernetes") | .decisions.severity.value')"
if [[ "${OOM_ATTN}" == "true" ]]; then ok "oom: needs_attention=yes"; else bad "oom: expected attention, got: ${OOM_ATTN}"; fi
if [[ "${OOM_SEV}" -ge 4 ]]; then ok "oom: severity>=$OOM_SEV"; else bad "oom: expected severity>=4, got: ${OOM_SEV}"; fi

api POST /api/fault '{"mode":"reset"}' >/dev/null
wait_for "deployment recovered after oom" 240 kubectl wait --for=condition=Ready pod -l app=demo-app -n "${NS}" --timeout=30s
ok "oom: recovered via reset (pod deletion fallback)"
clear_events

# ---- 7. final healthy check ------------------------------------------------
clear_events
ANALYZE="$(api POST /api/analyze '{}')"
K8S_HEALTH="$(echo "${ANALYZE}" | jq -r '.analyses[] | select(.pack=="kubernetes") | .decisions.health.value // "missing"')"
if [[ "${K8S_HEALTH}" == "healthy" ]]; then ok "final state: healthy"; else bad "final state: expected healthy, got ${K8S_HEALTH}"; fi

echo
echo "======================================================================"
echo " e2e smoke: ${PASS} passed, ${FAIL} failed"
echo "======================================================================"
[[ "${FAIL}" -eq 0 ]]