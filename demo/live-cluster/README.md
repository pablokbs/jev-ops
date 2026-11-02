# jev-ops · Live Cluster Demo

Conference demo (5–7 minutes, live): **jev-ops** reads real **application logs** and **Kubernetes signals** from a real cluster — local `kind` for development, a small cloud cluster on talk day — and returns **typed probabilistic decisions** from the live **TypeSafe Jev** model (`jev-latest`). Single dashboard page, zero frameworks, zero external assets.

```
Browser at localhost:8080
        │  poll /api/status + /api/logs · POST /api/analyze · POST /api/fault
        ▼
Node 22 + TypeScript server (node:http, no deps)
        │  1. collect:  kubectl logs -l app=demo-app --tail=100 · kubectl get pods · kubectl get events
        │  2. analyze:  jev-ops analyze demo-app | kubernetes --json  →  TypeSafe Jev live
        │  3. faults:   kubectl exec <pod> -- wget localhost:3000/boom|crash|oom|reset
        ▼
Real cluster: deployment demo-app, 3 pods, memory limit 128Mi
```

This is what an SRE actually does: when something breaks you reach for `kubectl logs` and `kubectl get events` — and instead of reading 200 lines by hand, Jev gives you a typed decision (`health`, `root_cause`, `severity 0–5`, `needs_attention`) with calibrated confidence that automation can branch on.

## What you'll see on screen

- **Pod squares** (polled every 2 s): green = running, yellow = starting, red pulsing = crash loop, purple = OOM-killed, grey = terminating.
- **Diagnostic input pane**: live app logs (JSON lines) and cluster warning events, tabbed.
- **Fault buttons**: `500s` · `Crash` · `OOM` · `Recover`, plus **⚡ Analyze now**.
- **Jev's typed decisions**: one card per pack (`demo-app`, `kubernetes`) — decision chips with confidence bars, input size, provider, and latency.
- **Shell footer**: the exact commands behind the last analysis (e.g. `kubectl logs -l app=demo-app --tail=100 | jev-ops analyze demo-app --json`).

## Requirements

- **Node 22+** (`node --version`) and npm.
- **kubectl** pointing at a cluster — local (kind/minikube/rancher-desktop) or external.
- **Docker** (to build the demo app image; not needed if you use a published image).
- **jev-ops binary** — install the prebuilt release (no Rust toolchain needed):

```bash
curl -fsSL -o ~/.local/bin/jev-ops \
  https://github.com/nemke82/jev-ops/releases/download/v2026.09.19/jev-ops-macos-arm64 && \
chmod +x ~/.local/bin/jev-ops
```

*(linux/musl/windows builds exist too — see the repo README. Or build from source with `cargo build --release`.)*

- **TYPESAFE_API_KEY** (typesafe.ai account) for the live model. Without it the dashboard still runs but `/api/analyze` returns a clear error (jev-ops exits 5); the automated smoke test uses the built-in offline `mock` provider and needs no key.

## Setup

```bash
cd demo/live-cluster
npm install

# 1. Cluster + app (creates a kind cluster if you have no reachable context):
./scripts/demo-up.sh

# 2. API key (live model):
export TYPESAFE_API_KEY="ts_live_..."

# 3. Dashboard:
npm run dev
# → http://localhost:8080  (terminal 2: kubectl get pods -l app=demo-app -w)
```

**No key / no network (rehearsal):** run the dashboard with the deterministic offline provider:

```bash
JEVOPS_PROVIDER=mock npm run dev
```

Same UI, same pipeline, zero API calls — perfect for practising the script.

## Fault modes (the demo app)

| Mode | What happens | Jev sees (kubernetes pack) |
| :--- | :--- | :--- |
| `500s` (`/boom`) | HTTP 500s + DB error logs every 5 s | cluster stays `healthy` — the app pack flags `errors_5xx` |
| `Crash` (`/crash`) | process exits → CrashLoopBackOff (persists across restarts) | `root_cause=crashloop`, `needs_attention=yes`, severity 4 |
| `OOM` (`/oom`) | allocates memory until the 128Mi limit kills it (exit 137) | `needs_attention=yes`, severity ≥ 4 (live model: `root_cause=resources`/`oom_killed`; the offline mock reports `crashloop` — an OOM-killed pod is also CrashLoopBackOff) |
| `Recover` (`/reset`) | clears the fault flag; deletes stuck pods if none is running | back to `healthy` |

Faults survive container restarts via a flag file in the pod, so crash/OOM loops are persistent until you recover. From the terminal: `./scripts/trigger-fault.sh boom|crash|oom|reset|status`.

## Talk script (5–7 min)

Narrative: *"when something breaks, an SRE doesn't read 200 log lines — they ask the same question every time: is this healthy, what's the root cause, how bad, do I need to act now? Jev answers with typed probabilities, not prose."*

Stage checklist (two terminals: dashboard + `kubectl get pods -l app=demo-app -w`):

1. **Opening** — show the cluster: 3 green pods, green `cluster OK` pill, live log lines flowing on the left.
2. **Baseline analyze** — press **⚡ Analyze now**; point at the two cards: `demo-app pack` → healthy/normal, `kubernetes pack` → healthy/severity 0, high confidence. Call out the footer: *"these are the real commands — nothing is simulated."*
3. **500s** — press **500s**; wait for the red error lines in the log pane; **Analyze** again: pods still green (the app is failing, not the cluster) but the `demo-app` pack now flags the failure mode. *"Two packs, one cluster — the app pack speaks application, the kubernetes pack speaks infrastructure."*
4. **Crash** — press **Crash**; watch the squares turn red and pulse; wait for CrashLoopBackOff; **Analyze**: `root_cause=crashloop`, `needs_attention=yes`. *"Jev just told automation exactly what to branch on — at 95%+ confidence you could auto-restart safely."*
5. **Recover** — press **Recover**; behind the scenes the server deletes the stuck pods (no running pod to exec into) and the Deployment recreates them green.
6. **OOM (if time)** — press **OOM**; squares go purple; **Analyze**: `root_cause=resources`/`oom_killed`, severity ≥ 4 → *"the fix is a memory limit bump, decided in ~2 seconds."*
7. **Capper** — final **Analyze**: everything green. *"Unstructured logs in, typed probabilistic decisions out — that's Jev reading your cluster."*

## Talk day — cloud cluster checklist

The MacBook stays fast; the demo runs against a small cloud cluster.

1. **Publish the image** (the cloud cluster can't see locally built images):
   ```bash
   cd demo/live-cluster
   ./scripts/publish-image.sh <registry>/<owner>/jev-ops-demo-app:RELEASE_TAG
   ```
2. **Kubeconfig**: copy the cloud kubeconfig to this repo as `*.kubeconfig` (gitignored) and set `K8S_KUBECONFIG`. Or reuse your default context with `K8S_CONTEXT=<name>`.
3. **Deploy**: `./scripts/demo-up.sh` (uses the existing reachable context; set `DEMO_APP_IMAGE` to the published tag if you don't want to `kubectl set image`).
4. **Rehearse once against the cloud cluster**: full `./scripts/e2e-smoke.sh` (network + latency + RBAC sanity) and one live `Analyze` with a real key.
5. **On stage**: `export TYPESAFE_API_KEY=... && npm run dev`. The dashboard shows the cloud context in the header pill.

## Pointing at an external cluster

| Env | Purpose |
| :--- | :--- |
| `K8S_KUBECONFIG` | path to the cluster's kubeconfig (no `~/.kube/config` changes) |
| `K8S_CONTEXT` | context name inside that kubeconfig |
| `DEMO_APP_IMAGE` | image tag for `demo-up.sh`/`publish-image.sh` |

`kubectl exec` is used for fault injection — it works on any cluster you control (no Ingress/LoadBalancer needed).

## API

| Method | Route | What it does |
| :--- | :--- | :--- |
| `GET` | `/api/status` | deployment state, pod breakdown, cluster context |
| `GET` | `/api/logs?kind=app\|k8s` | latest app log lines / warning events + pod summary |
| `POST` | `/api/analyze` | collects both inputs and runs both packs against Jev |
| `POST` | `/api/fault` `{"mode":"boom\|crash\|oom\|reset"}` | injects/clears a fault via `kubectl exec` |
| `GET` | `/api/config` | binary/pack-dir/API-key presence |

Errors are typed: `400` bad request, `413` body too large, `502` jev-ops/exec failure, `503` kubectl unreachable — never a 500 because of Jev or kubectl.

## Configuration (all env vars)

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `8080` | dashboard port |
| `JEVOPS_BIN` | `jev-ops` | jev-ops binary path |
| `JEVOPS_PACK_DIR` | `<demo>/packs` | pack directory |
| `JEVOPS_PROVIDER` | `typesafe` | `typesafe` (live) or `mock` (offline rehearsal/tests) |
| `TYPESAFE_API_KEY` | — | required for live analyses |
| `K8S_KUBECONFIG` | — | external kubeconfig path |
| `K8S_CONTEXT` | — | context inside the kubeconfig |
| `K8S_NAMESPACE` | `default` | namespace of the deployment |
| `K8S_DEPLOYMENT` | `demo-app` | deployment name |
| `K8S_POD_SELECTOR` | `app=demo-app` | pod selector for logs/pods/events |
| `DEMO_APP_PORT` | `3000` | app port inside the container (exec target) |
| `ANALYZE_TAIL` | `100` | log lines fed to each analysis |
| `K8S_EVENTS_WINDOW` | `5` | drop warning events older than N minutes from the input |

## Testing

```bash
npm run typecheck   # strict TS
npm test            # unit tests (node:test) — no cluster, no API, no network
./scripts/e2e-smoke.sh  # full pipeline against a real cluster (mock provider)
```

The e2e (`e2e-smoke.sh`) deploys, injects every fault, and asserts the typed decisions from the real collected input: healthy → `health=healthy`; crash → `root_cause=crashloop`; oom → `needs_attention=yes` + severity ≥ 4 (the built-in mock, which cannot be edited, orders `crashloop` before `oom`; the live model discriminates OOM via the `lastReason: OOMKilled` signal — covered by the manual live check). It needs no API key and resets the cluster when done.

## Troubleshooting

- **`/api/analyze` says "TYPESAFE_API_KEY is not set"** → export it in the shell that runs `npm run dev` (the server only reads environment variables). Rehearse with `JEVOPS_PROVIDER=mock`.
- **Cluster pill red / 503s** → `kubectl cluster-info`; check `K8S_KUBECONFIG`/`K8S_CONTEXT`; the dashboard shows the context it's using.
- **"No running pod to exec into"** (fault button) → the cluster is mid-crash; press **Recover** (or run `kubectl delete pod -l app=demo-app`).
- **OOM square then everything green again** → expected: the pod restarted and the fault flag re-arms it; re-press **OOM** or **Analyze** while it cycles.
- **Jev slow or 429/529** → jev-ops retries automatically (3 retries, backoff); the UI shows `elapsed_ms` — on stage that's part of the demo.
- **Image pull at the venue** → local kind: `kind load` is done by `demo-up.sh`; cloud: `publish-image.sh` beforehand.

## Repo layout

```
demo/live-cluster/
├── app/            # demo web service (node:20-alpine) with 4 fault modes
├── k8s/            # Deployment manifest (3 replicas, 128Mi limit)
├── packs/demo-app/ # custom pack — the "packs are data" story, no Rust changes
├── server/         # Node backend: config, kubectl wrapper, collector, jevops runner, faults, HTTP
├── public/         # zero-dependency dashboard (index.html/app.js/style.css)
└── scripts/        # demo-up.sh · publish-image.sh · trigger-fault.sh · e2e-smoke.sh
```