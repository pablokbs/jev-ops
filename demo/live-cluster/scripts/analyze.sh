#!/usr/bin/env bash
# =============================================================================
# analyze.sh — fire the jev-ops binary by hand with a one-line example.
#
# No cluster, no kubectl. Prints the pipe, then runs it, so a room can see
# the command and the typed JSON the binary returns.
#
#   ./scripts/analyze.sh
#   # echo "error 500 de ejemplo" | jev-ops analyze demo-app --pack-dir packs --json
#
#   ./scripts/analyze.sh crash
#   ./scripts/analyze.sh oom
#   ./scripts/analyze.sh healthy
#   ./scripts/analyze.sh "tu linea"
#   ./scripts/analyze.sh --summary          # human summary instead of JSON
#
# Rehearsal (no API key, no network). The offline mock only keys on a few
# markers (CrashLoopBackOff, OOMKilled, "status: Running") — use those examples:
#   JEVOPS_PROVIDER=mock ./scripts/analyze.sh crash
#
# Env: JEVOPS_BIN, JEVOPS_PROVIDER, JEVOPS_PACK_DIR, TYPESAFE_API_KEY.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

JEVOPS_BIN="${JEVOPS_BIN:-jev-ops}"
JEVOPS_PROVIDER="${JEVOPS_PROVIDER:-typesafe}"
JEVOPS_PACK_DIR="${JEVOPS_PACK_DIR:-packs}"
PACK="demo-app"
JSON=1
EXAMPLE=""

usage() {
  cat <<EOF
Usage: analyze.sh [500|crash|oom|healthy|<line>] [--summary]

  Prints and runs a one-line pipe into the jev-ops binary. No kubectl.

    echo "error 500 de ejemplo" | ${JEVOPS_BIN} analyze demo-app --pack-dir ${JEVOPS_PACK_DIR} --provider ${JEVOPS_PROVIDER} --json

  500|boom     error 500 de ejemplo          (default; live model)
  crash        CrashLoopBackOff line    (mock keys on this)
  oom          OOMKilled line           (mock keys on this)
  healthy      status: Running line     (mock keys on this)
  <line>       whatever you type

  --summary    human summary instead of --json
  --pack NAME  pack to analyze (default: demo-app)

  Offline: JEVOPS_PROVIDER=mock ./scripts/analyze.sh crash
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --json) JSON=1 ;;
    --summary) JSON=0 ;;
    --pack)
      shift
      PACK="${1:-}"
      if [[ -z "${PACK}" ]]; then
        echo "ERROR: --pack needs a pack name." >&2
        exit 2
      fi
      ;;
    --pack=*) PACK="${1#*=}" ;;
    *)
      if [[ -n "${EXAMPLE}" ]]; then
        echo "ERROR: unexpected argument '${1}'." >&2
        usage >&2
        exit 2
      fi
      EXAMPLE="$1"
      ;;
  esac
  shift
done

case "${EXAMPLE}" in
  ""|500|boom) LINE="error 500 de ejemplo" ;;
  crash) LINE="CrashLoopBackOff: Back-off restarting failed container demo-app" ;;
  oom) LINE="OOMKilled: container exceeded its memory limit" ;;
  healthy) LINE="status: Running heartbeat ok" ;;
  *) LINE="${EXAMPLE}" ;;
esac

if ! command -v "${JEVOPS_BIN}" >/dev/null 2>&1; then
  echo "ERROR: jev-ops binary not found ('${JEVOPS_BIN}')." >&2
  echo "  Install the prebuilt release, see README.md 'Requirements', or set JEVOPS_BIN." >&2
  exit 1
fi

if [[ "${JEVOPS_PROVIDER}" == "typesafe" && -z "${TYPESAFE_API_KEY:-}" ]]; then
  echo "ERROR: TYPESAFE_API_KEY is not set — jev-ops exits 5 without it." >&2
  echo "  export TYPESAFE_API_KEY=ts_live_..." >&2
  echo "  or rehearse offline: JEVOPS_PROVIDER=mock ./scripts/analyze.sh crash" >&2
  exit 5
fi

# Print the exact pipe, then run it. No eval: the line goes in on stdin.
json_flag=""
if [[ "${JSON}" -eq 1 ]]; then
  json_flag=" --json"
fi
echo "\$ echo \"${LINE}\" | ${JEVOPS_BIN} analyze ${PACK} --pack-dir ${JEVOPS_PACK_DIR} --provider ${JEVOPS_PROVIDER}${json_flag}"
echo

set -- analyze "${PACK}" --pack-dir "${JEVOPS_PACK_DIR}" --provider "${JEVOPS_PROVIDER}"
if [[ "${JSON}" -eq 1 ]]; then
  set -- "$@" --json
fi
printf '%s\n' "${LINE}" | "${JEVOPS_BIN}" "$@"
