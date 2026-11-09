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
        │  4. act (autopilot, when armed): kubectl delete pod  →  escalate if it stays broken
        ▼
Real cluster: deployment demo-app, 3 pods, memory limit 128Mi
```

This is what an SRE actually does: when something breaks you reach for `kubectl logs` and `kubectl get events` — and instead of reading 200 lines by hand, Jev gives you a typed decision (`health`, `root_cause`, `severity 0–5`, `needs_attention`) with calibrated confidence that automation can branch on.

## What you'll see on screen

- **Pod squares** (polled every 2 s): green = running, yellow = starting, red pulsing = crash loop, purple = OOM-killed, grey = terminating.
- **Diagnostic input pane**: live app logs and cluster warning events, tabbed — app log lines are color-coded by level (info blue, warn orange, error red).
- **Fault buttons**: `500s` · `Crash` · `OOM` · `Recover`, plus **⚡ Analyze now**.
- **Jev's typed decisions**: one card per pack (`demo-app`, `kubernetes`) — decision chips with confidence bars, input size, provider, and latency.
- **🤖 Autopilot toggle + Automation feed**: armed, the server closes the loop — it restarts crash-looping/OOM pods itself when Jev is sure, verifies, and escalates (red 🚨) when it can't fix it.
- **Shell footer**: the exact commands behind the last analysis (e.g. `kubectl logs -l app=demo-app --tail=100 | jev-ops analyze demo-app --json`).

## How it works

### Where Jev's logic actually lives

- The brain is the stand-alone **`jev-ops` binary** (Rust; `JEVOPS_BIN`). The Node server never talks to the model directly — it shells out: `jev-ops analyze <pack> --pack-dir packs --provider <p> --json`, feeds the collected text on stdin, and reads typed JSON on stdout. Exit codes are typed too (`2` usage · `3` bad pack · `4` bad input · `5` provider/API · `6` model output violates the pack schema), so the UI can render precise errors instead of ever returning a 500.
- **Packs are data, not code**: `packs/demo-app/pack.yaml` declares the input type/size cap, the decision schema (`health`, `root_cause`, `severity 0–5`, `needs_attention` — with allowed values and ranges) and the model instructions. The `kubernetes` pack ships compiled into the binary (source at the repo root `packs/kubernetes/`). A new diagnosis is a new YAML — no Rust changes, no dashboard redeploy.
- **Providers**: `typesafe` calls the live TypeSafe Jev model (`jev-latest`, needs `TYPESAFE_API_KEY`; retries 429/5xx with backoff; validates the model's answer against the schema — a violation is exit 6). `mock` is a deterministic offline classifier built into the binary — what rehearsals and the e2e use, zero network.

### Where the options live

- Every server option is an **env var**, read once at boot and typed in `server/config.ts` — template in `.env.example` (`set -a; source .env; set +a`), full table under *Configuration* below. No config files, no CLI flags, no database.
- The diagnosis contract (what Jev must answer) lives in the pack YAMLs; the workload under observation is `k8s/deployment.yaml`.
- Exactly one setting changes at runtime: the autopilot's `armed` flag (the UI toggle / `POST /api/autopilot`) — in-memory, and it resets to disarmed on every boot.

### What happens when you press **⚡ Analyze now**

1. The browser `POST /api/analyze` (empty body) lands in `Autopilot.runOnce()` (`server/autopilot.ts`) — the *same* cycle the armed loop runs every 15 s, single-flight so a click can never overlap a loop tick.
2. **Collect** (`server/collector.ts`, via `kubectl`, in parallel): the app-pack input is the last 100 app log lines plus a per-pod status summary; the k8s-pack input is the `kubectl get pods` table plus Warning events from the last 5 minutes plus the same summary. A kubectl failure becomes a typed `503`, never a crash.
3. **Analyze** (`server/jevops.ts`): both inputs spawn `jev-ops analyze` in parallel (60 s timeout). stdout is validated (`schema_version: '1'`) into typed outcomes — per pack: the decisions with confidences, input bytes, provider, and latency; a failure becomes its own error card.
4. **Policy** (only when armed): the outcomes go through `evaluatePolicy` (`server/remediate.ts`) — maybe `kubectl delete pod`, maybe an escalation, maybe nothing. Either way the response's `automation` block says *why*.
5. **Render** (`public/app.js`): one verdict card per pack, the exact shell commands in the footer, the automation note — while pods and logs keep polling every 2 s on their own.

Armed, steps 2–5 run unattended every `AUTOPILOT_INTERVAL_MS` — the button just forces one cycle on demand.

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

Same UI, same pipeline, zero API calls — perfect for practising the script. That includes the **autopilot beat**: arm the toggle and press **Crash** — the mock drives the full detect → delete → recover loop offline (it's exactly what the e2e's last phase automates).

## Fault modes (the demo app)

| Mode | What happens | Jev sees (kubernetes pack) |
| :--- | :--- | :--- |
| `500s` (`/boom`) | HTTP 500s + DB error logs every 5 s | cluster stays `healthy` — the app pack flags `errors_5xx` |
| `Crash` (`/crash`) | process exits → CrashLoopBackOff (persists across restarts) | `root_cause=crashloop`, `needs_attention=yes`, severity 4 |
| `OOM` (`/oom`) | allocates memory until the 128Mi limit kills it (exit 137) | `needs_attention=yes`, severity ≥ 4 (live model: `root_cause=resources`/`oom_killed`; the offline mock reports `crashloop` — an OOM-killed pod is also CrashLoopBackOff) |
| `Recover` (`/reset`) | clears the fault flag; deletes stuck pods if none is running | back to `healthy` |

Faults survive container restarts via a flag file in the pod, so crash/OOM loops are persistent until you recover. From the terminal: `./scripts/trigger-fault.sh boom|crash|oom|reset|status`.

## Run the binary by hand

No cluster, no dashboard — one example line on stdin, typed JSON on stdout. The script prints the pipe and runs it:

```bash
./scripts/analyze.sh
# echo "error 500 de ejemplo" | jev-ops analyze demo-app --pack-dir packs --json

./scripts/analyze.sh crash
./scripts/analyze.sh healthy
./scripts/analyze.sh "tu linea"
JEVOPS_PROVIDER=mock ./scripts/analyze.sh crash   # rehearsal: no key, no network
```

`--pack-dir packs` is what makes the custom `demo-app` pack visible. The binary reads that one line on stdin and prints the decisions. The offline mock only reacts to a few markers (`CrashLoopBackOff`, `OOMKilled`, `status: Running`), so use those examples when rehearsing without a key.

## Autopilot — closing the loop

Manual mode shows Jev's typed decisions; the **autopilot** acts on them. Arm it with the big **🤖 Autopilot** button (`POST /api/autopilot {"armed":true}` from the terminal). Disarmed is the default and every server boot starts disarmed — arming is a deliberate stage move.

Armed, the server re-runs the same collect → analyze cycle every 15 s (configurable) and evaluates a small policy against the typed decisions:

| Signal (pack) | Gates | Outcome |
| :--- | :--- | :--- |
| `needs_attention=yes`, root_cause `crashloop`/`resources` (kubernetes) | severity ≥ 4 **and** confidence ≥ 85% | `kubectl delete pod -l app=demo-app` — restart the pods; max 1 attempt per incident |
| still `needs_attention` ~60 s after the attempt (kubernetes) | — | 🚨 escalate: *remediation ineffective — paging a human* |
| `needs_attention=yes`, e.g. root_cause `errors_5xx` (demo-app) | confidence ≥ 85% | 🚨 escalate: *no safe cluster action — a human owns the app* |
| both packs healthy | — | incident closed, back to watching |

Everything lands in the **Automation feed**: each action with the decision snapshot that triggered it (root cause, severity, confidence) and the exact kubectl line; each escalation with a Slack chip (`sent`/`off`/`failed`) when `SLACK_WEBHOOK_URL` is set. Incident state lives in memory only, alert dedup cooldown is 90 s, and the policy never acts on an errored analysis. The story: *automation knows its limits — it restarts what it provably can, and pages for what it can't.*

Stage details: see the [autopilot beat](#the-autopilot-beat-the-closer-2-min) in the talk script.

## Talk script (5–7 min)

Narrative: *"when something breaks, an SRE doesn't read 200 log lines — they ask the same question every time: is this healthy, what's the root cause, how bad, do I need to act now? Jev answers with typed probabilities, not prose."*

Stage checklist (two terminals: dashboard + `kubectl get pods -l app=demo-app -w`):

1. **Opening** — show the cluster: 3 green pods, green `cluster OK` pill, live log lines flowing on the left.
2. **Baseline analyze** — press **⚡ Analyze now**; point at the two cards: `demo-app pack` → healthy/normal, `kubernetes pack` → healthy/severity 0, high confidence. Call out the footer: *"these are the real commands — nothing is simulated."*
3. **500s** — press **500s**; wait for the red error lines in the log pane; **Analyze** again: pods still green (the app is failing, not the cluster) but the `demo-app` pack now flags the failure mode. *"Two packs, one cluster — the app pack speaks application, the kubernetes pack speaks infrastructure."*
4. **Crash** — press **Crash**; watch the squares turn red and pulse; wait for CrashLoopBackOff; **Analyze**: `root_cause=crashloop`, `needs_attention=yes`. *"Jev just told automation exactly what to branch on — at 95%+ confidence you could auto-restart safely."*
5. **Autopilot (the closer)** — the full beat is scripted below: arm → Crash → the cluster heals itself → 500s → 🚨 escalation.
6. **Recover** — press **Recover**; behind the scenes the server deletes the stuck pods (no running pod to exec into) and the Deployment recreates them green. (With the autopilot armed, this happens by itself.)
7. **OOM (if time)** — press **OOM**; squares go purple; **Analyze**: `root_cause=resources`/`oom_killed`, severity ≥ 4 → *"the fix is a memory limit bump, decided in ~2 seconds."* Armed, the autopilot restarts the OOMing pods too.
8. **Capper** — final **Analyze**: everything green. *"Unstructured logs in, typed probabilistic decisions out — and bounded automation on top — that's Jev running your cluster."*

### The autopilot beat (the closer, ~2 min)

This is the "typed decisions → bounded automation" payoff. Two beats: one it fixes, one it can't.

**Before the talk** (one-time, 30 s sanity):

- Nothing to configure: the server boots **disarmed** by default, gates are `severity ≥ 4 · confidence ≥ 85% · 1 attempt`. The policy pill next to the toggle shows it on screen.
- Optional: `export SLACK_WEBHOOK_URL=...` if you want the escalation to land on a real Slack channel (venue network must reach it; the dashboard feed works regardless).
- Rehearse offline first: `JEVOPS_PROVIDER=mock npm run dev` — the mock drives the whole loop with zero API calls.

**Beat 1 — crash → self-heal (~60–90 s):**

1. Press the **🤖 Autopilot** toggle: it goes red *ARMED* and the pulse makes the room notice. Line: *"so far you've seen decisions. Let's close the loop — same engine, now allowed to act."*
2. Press **Crash**. Squares turn red/pulsing as usual; **do not press Recover**.
3. Within one loop interval (≤ 15 s + model latency) the **Automation feed** lights up: 🤖 *"kubernetes pack: needs_attention=yes, severity 4/5, root_cause=crashloop at 96% confidence — deleting pods (attempt 1/1)"* with the exact `kubectl delete pod -l app=demo-app …` line underneath.
4. Squares go green on their own. Line: *"nobody pressed Recover. Jev saw the crash loop, was provably sure, and restarted the workload — that's the same JSON on the screen driving a kubectl action."*
5. Optional: one manual **⚡ Analyze** to show `needs_attention=no` — the incident is closed in the feed, verified by the same pipeline.

**Beat 2 — 500s → escalation (~30–45 s):**

1. With the autopilot still armed, press **500s**. Red error lines fill the log pane; squares stay green (the cluster *is* fine).
2. Within an interval, a red 🚨 entry hits the feed: *"demo-app pack: application failure (root_cause=errors_5xx …) has no safe cluster action — paging a human"* (+ `slack sent` chip if the webhook is set).
3. The line: *"restarting pods can't fix application bugs — so the automation does the honest thing: it pages you, with root cause, severity and confidence already attached. It restarts what it provably can, and pages for what it can't."*
4. Press **Recover** to stop the 500s and move on (the escalation closes on the next healthy analysis; cooldown avoids re-alert spam).

**Stage fallbacks:**

- *Model slow today?* The loop just takes one extra interval — narrate the `elapsed_ms` on the cards; it's part of the demo.
- *Forgot to arm?* Nothing happens and nothing breaks — disarmed means analysis-only by design; arm and press **Crash** again.
- *Escalation shows up right after a successful heal?* Expected if warning events are still in the 5-minute window — point at the green squares: *"conservative beats silent; a human closes it."* (`kubectl delete events --all` clears the footprint.)
- *Venue Slack unreachable?* The feed chip reads `slack failed` — the dashboard feed was the channel all along.

### Speaker backup — how one Analyze actually flows (Q&A ammo)

Keep these five bullets in your pocket for questions; full detail lives in *How it works* above.

1. One click runs **two `jev-ops` processes in parallel**: `jev-ops analyze demo-app --pack-dir demo/live-cluster/packs --provider typesafe --json` and the same with `kubernetes`. Input goes in over **stdin as plain text** (100 log lines + a pod status summary — no files, no JSON arguments).
2. The `kubernetes` pack is **not read from disk**: it's compiled into the binary. `--pack-dir` is what makes your custom `demo-app/pack.yaml` visible — that pack is the only thing we added. *"A new diagnosis is a new YAML, zero Rust"* — that's the *packs are data* story.
3. The binary is not a dumb proxy: it enforces the pack's `max_bytes`, builds the model request from the pack's `instructions`, calls TypeSafe with your key (3 retries, backoff on 429/5xx), and **validates the model's answer against the pack schema** — a violation exits 6 and renders as a typed error card, never a 500.
4. The Node server: disarmed → renders the outcomes, nothing else. Armed → `evaluatePolicy` post-processes them: `kubectl delete pod` when it provably can fix the root cause, a 🚨 escalation when it can't. **Slack fires on escalations only**, never on actions.
5. `JEVOPS_PROVIDER=mock` is the exact same pipeline minus the model call — the deterministic classifier ships in the binary, which is why rehearsals and the e2e need no API key and no network.

## Talk day — cloud cluster checklist

The MacBook stays fast; the demo runs against a small cloud cluster.

1. **Publish the image** (the cloud cluster can't see locally built images):
   ```bash
   cd demo/live-cluster
   ./scripts/publish-image.sh          # defaults to Docker Hub: pablokbs/jev-ops-demo-app:2026.11
   # or: ./scripts/publish-image.sh <registry>/<owner>/jev-ops-demo-app:RELEASE_TAG
   ```
2. **Kubeconfig**: copy the cloud kubeconfig to this repo as `*.kubeconfig` (gitignored) and set `K8S_KUBECONFIG`. Or reuse your default context with `K8S_CONTEXT=<name>`.
3. **Deploy**: `./scripts/demo-up.sh` (uses the existing reachable context). On a non-kind cluster it deploys the published image by default and verifies the tag exists in the registry first, so you get a clear error instead of `ImagePullBackOff` — no `kubectl set image` needed.
4. **Rehearse once against the cloud cluster**: full `./scripts/e2e-smoke.sh` (network + latency + RBAC sanity) and one live `Analyze` with a real key.
5. **On stage**: `export TYPESAFE_API_KEY=... && npm run dev`. The dashboard shows the cloud context in the header pill.

## Pointing at an external cluster

| Env | Purpose |
| :--- | :--- |
| `K8S_KUBECONFIG` | path to the cluster's kubeconfig (no `~/.kube/config` changes) |
| `K8S_CONTEXT` | context name inside that kubeconfig |
| `DEMO_APP_IMAGE` | image tag override for `demo-up.sh` (defaults: `demo-app:local` on kind, the published Docker Hub tag on external clusters) · `publish-image.sh` takes the tag as an argument |

`kubectl exec` is used for fault injection — it works on any cluster you control (no Ingress/LoadBalancer needed).

## API

| Method | Route | What it does |
| :--- | :--- | :--- |
| `GET` | `/api/status` | deployment state, pod breakdown, cluster context |
| `GET` | `/api/logs?kind=app\|k8s` | latest app log lines / warning events + pod summary |
| `POST` | `/api/analyze` | collects both inputs and runs both packs against Jev; response includes an `automation` block (armed flag + policy decision for the cycle) |
| `POST` | `/api/fault` `{"mode":"boom\|crash\|oom\|reset"}` | injects/clears a fault via `kubectl exec` |
| `GET` | `/api/autopilot` | armed flag, the policy in effect, and the automation feed |
| `POST` | `/api/autopilot` `{"armed":bool}` | arms/disarms the closed loop (starts/stops the periodic analysis) |
| `GET` | `/api/config` | binary/pack-dir/API-key/Slack-webhook presence |

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
| `AUTOPILOT_ARMED` | `false` | boot with the closed loop armed (the UI/API can arm it live) |
| `AUTOPILOT_INTERVAL_MS` | `15000` | analysis period while armed |
| `AUTOPILOT_MIN_CONFIDENCE` | `0.85` | confidence gate — every decision the policy branches on must beat it |
| `AUTOPILOT_MIN_SEVERITY` | `4` | severity gate (kubernetes pack) for the delete-pods action |
| `AUTOPILOT_MAX_ATTEMPTS` | `1` | remediation attempts per incident before escalating |
| `SLACK_WEBHOOK_URL` | — | optional incoming webhook for escalations (3 s timeout; silently off when unset) |

## Testing

```bash
npm run typecheck   # strict TS
npm test            # unit tests (node:test) — no cluster, no API, no network
./scripts/e2e-smoke.sh  # full pipeline against a real cluster (mock provider)
```

The e2e (`e2e-smoke.sh`) deploys, injects every fault, and asserts the typed decisions from the real collected input: healthy → `health=healthy`; crash → `root_cause=crashloop`; oom → `needs_attention=yes` + severity ≥ 4 (the built-in mock, which cannot be edited, orders `crashloop` before `oom`; the live model discriminates OOM via the `lastReason: OOMKilled` signal — covered by the manual live check). Its last phase arms the autopilot (mock provider, confidence/severity gates forced to 0 for determinism), injects a crash, and asserts the loop deletes the pods **by itself** — no manual reset — recording the action in its feed. It needs no API key and resets the cluster when done.

## Troubleshooting

- **`/api/analyze` says "TYPESAFE_API_KEY is not set"** → export it in the shell that runs `npm run dev` (the server only reads environment variables). Rehearse with `JEVOPS_PROVIDER=mock`.
- **Cluster pill red / 503s** → `kubectl cluster-info`; check `K8S_KUBECONFIG`/`K8S_CONTEXT`; the dashboard shows the context it's using.
- **"No running pod to exec into"** (fault button) → the cluster is mid-crash; press **Recover** (or run `kubectl delete pod -l app=demo-app`).
- **OOM square then everything green again** → expected: the pod restarted and the fault flag re-arms it; re-press **OOM** or **Analyze** while it cycles.
- **Jev slow or 429/529** → jev-ops retries automatically (3 retries, backoff); the UI shows `elapsed_ms` — on stage that's part of the demo.
- **Image pull at the venue** → local kind: `kind load` is done by `demo-up.sh`; cloud: `publish-image.sh` beforehand (builds a multi-arch `linux/amd64,linux/arm64` manifest, so it pulls on amd64 cloud nodes even when built on Apple Silicon).
- **`ImagePullBackOff` on a cloud cluster right after `set image`** → the image is arm64-only (built on a Mac with plain `docker build`). Re-run `publish-image.sh` (buildx multi-arch) and `kubectl delete pod -l app=demo-app` to force a fresh pull.
- **An escalation right after a successful autopilot remediation** → conservative by design: warning events linger in the namespace for the 5-minute input window, so the verification analysis may still report attention for a while once an incident was escalated; when pods are green the next healthy analysis closes the incident (and you can `kubectl delete events --all -n default` to clear the footprint).
- **Slack alerts never arrive** → the feed entry shows a `slack failed` chip; check `SLACK_WEBHOOK_URL` in the shell that runs the server (and the venue's egress). The dashboard feed is the primary channel by design.

## Repo layout

```
demo/live-cluster/
├── app/            # demo web service (node:20-alpine) with 4 fault modes
├── k8s/            # Deployment manifest (3 replicas, 128Mi limit)
├── packs/demo-app/ # custom pack — the "packs are data" story, no Rust changes
├── server/         # Node backend: config, kubectl wrapper, collector, jevops runner, faults, autopilot (policy + loop), HTTP
├── public/         # zero-dependency dashboard (index.html/app.js/style.css)
└── scripts/        # demo-up.sh · publish-image.sh · trigger-fault.sh · analyze.sh · e2e-smoke.sh
```