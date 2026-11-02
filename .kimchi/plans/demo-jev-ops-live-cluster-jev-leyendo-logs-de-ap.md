<!-- kimchi-work-id: c6b1e0e2-883e-4829-8974-a313c8088190 -->
# Demo "jev-ops Live Cluster" — jev leyendo logs de aplicación y de Kubernetes en un cluster real

## Goal

Demo visual (sin voz) para una charla: **jev-ops** (binario + packs, con el modelo real **TypeSafe Jev** vía `TYPESAFE_API_KEY`) lee logs de aplicación y señales de Kubernetes de un cluster **real** — kind en desarrollo, cluster pequeño en la nube el día de la charla — y devuelve decisiones tipadas (health, root_cause, severity 0–5, needs_attention) con confianza, en una UI de browser.

Lo que se ve en pantalla (`http://localhost:8080`):
- Panel de **pods cuadrados** del deployment demo (poll cada 2 s: running / starting / crashloop / oom / terminating).
- Panel de **logs en vivo**: logs de la app + eventos del cluster (Warning, BackOff, OOMKilled, Failed).
- Botones de **fallo** (500s, crash loop, OOM, volver a normal) y botón **"Analyze"**.
- **Tarjetas de veredicto** de Jev: decisión + barra de confianza + latencia, por cada pack (`kubernetes` y `demo-app`).
- **Footer terminal** con el comando exacto que se ejecutó (ej. `kubectl logs -l app=demo-app --tail=100 | jev-ops analyze demo-app --json`) — transparencia para la audiencia.

Narrativa: "esto es lo que un SRE haría: cuando algo truena, `kubectl logs` + `kubectl get events` y en vez de leer 200 líneas, Jev te da una decisión tipada con probabilidades en las que la automatización puede ramificar."

## Constraints

- **Solo visual**: sin Web Speech API ni TTS (decisión del usuario; el repo anterior `jev-kubectl-voice` cubre la voz).
- **Modelo real solo** (`typesafe`): la charla usa `TYPESAFE_API_KEY`. El provider `mock` se usa **únicamente** en tests automatizados y ensayo dev (es parte del binario, no requiere red — plan B implícito).
- **Cluster**: local por ahora (kind), pero todo el stack debe funcionar contra cualquier contexto/kubeconfig externo (`K8S_KUBECONFIG` + `K8S_CONTEXT`, mismo patrón que jev-kubectl-voice).
- **Sin frameworks**: server Node 22 + TypeScript con `node:http` (patrón probado en jev-kubectl-voice). Frontend sin dependencias.
- **Cero lógica diagnóstica en el server**: el server solo recolecta y delega; las decisiones las produce `jev-ops` con sus packs.
- Backend y frontend en **inglés** (convención del repo). Talk script en README, en inglés (como jev-kubectl-voice).
- No tocar el código Rust de `src/` — el demo vive en un directorio nuevo `demo/live-cluster/`.
- Imagen de la app: `node:20-alpine` + Dockerfile propio; versiones verificadas: Node 22.

## Chunks

### Chunk 1 — Demo app + manifest

**Files Changed**
- `demo/live-cluster/app/Dockerfile` — base `node:20-alpine`, copia `server.js`, `CMD ["node","server.js"]`.
- `demo/live-cluster/app/server.js` — app HTTP en Node puro (sin deps):
  - `GET /health` → 200 `{"status":"ok"}`.
  - `GET /` → tráfico normal; log estructurado a stdout: `{"ts":ISO,"level":"info","msg":"request completed","path":"/api/orders","status":200,"latency_ms":42}` + un "heartbeat" cada 5 s en modo normal (siempre hay logs que mostrar).
  - `GET /boom` → modo errores: 500 con `level:"error"`, stack trace y errores de conexión a DB simulados.
  - `GET /crash` → `process.exit(1)` → CrashLoopBackOff con `restartPolicy: Always`.
  - `GET /oom` → asigna buffers creciendo hasta exceder el límite de memoria del contenedor (cgroup OOMKilled, exit 137).
  - `GET /reset` → vuelve a modo normal.
- `demo/live-cluster/k8s/deployment.yaml` — Deployment `demo-app`:
  - `image: ${DEMO_APP_IMAGE:-demo-app:local}` (documentado para el día de la charla: apuntar a la imagen en un registry).
  - limits: `memory: 128Mi`, `cpu: 100m`; `restartPolicy: Always`; liveness probe a `/health`.
  - label `app=demo-app` (selector para logs/pods).

**Depends On** — nada.
**Accept When** — `docker build` OK; `kubectl apply` contra kind; los 5 endpoints responden vía `kubectl exec`; cada fallo produce un cambio visible en los logs del pod; `GET /boom` devuelve 500 sostenido; `crash` deja el pod en CrashLoopBackOff; `oom` mata el contenedor con exit 137 (OOMKilled).
**Test Coverage** — script `scripts/e2e-smoke.sh` (Chunk 5) ejercita los 5 modos.

### Chunk 2 — Pack custom `demo-app`

**Files Changed**
- `demo/live-cluster/packs/demo-app/pack.yaml` — manifest declarativo:
  - `health`: choice `[healthy, degraded, unhealthy, unknown]`
  - `root_cause`: choice `[normal, errors_5xx, crashloop, oom_killed, db_connection, slow_latency, unknown]`
  - `severity`: score 0–5 (misma rúbrica que los packs builtin)
  - `needs_attention`: boolean
  - `instructions`: "Analyze application logs from the demo web service; classify health; identify most probable root cause…"
  - `spec.input.max_bytes`: 524288

**Depends On** — Chunk 1 (para tener logs reales que probar).
**Accept When** — `jev-ops packs validate demo/live-cluster/packs/demo-app/pack.yaml` pasa; `jev-ops analyze demo-app --provider mock --pack-dir demo/live-cluster/packs --json` devuelve JSON válido con las 4 decisiones y, con input de crash/healthy, `crashloop`/`healthy` (el mock del binario detecta `CrashLoopBackOff` y `status: Running`; los 5xx/oom quedan en fallback `unknown` — es esperado y se documenta: el mock es solo para plomería, la validación semántica de decisiones por fallo es del chequeo live).
**Test Coverage** — assertion dentro de `e2e-smoke.sh` con `--provider mock` + `jq`.

### Chunk 3 — Backend Node

**Files Changed**
- `demo/live-cluster/package.json` — scripts: `dev`, `start`, `typecheck`, `test` (node:test). devDependencies: `typescript`, `@types/node` (únicas).
- `demo/live-cluster/tsconfig.json`
- `demo/live-cluster/.env.example` — documenta cada variable.
- `demo/live-cluster/.gitignore` — `node_modules/`, `.env`, `*.kubeconfig`.
- `demo/live-cluster/server/config.ts` — env tipado:
  - `PORT` (8080) · `JEVOPS_BIN` (`jev-ops`) · `TYPESAFE_API_KEY` (requerida; error claro si falta) · `K8S_KUBECONFIG` (opcional) · `K8S_CONTEXT` (opcional) · `K8S_NAMESPACE` (`default`) · `K8S_DEPLOYMENT` (`demo-app`) · `DEMO_APP_PORT` (3000, puerto interno de la app) · `ANALYZE_TAIL` (100 líneas).
- `demo/live-cluster/server/kubectl.ts` — wrapper sin shell y con errores tipados (patrón `kubectl.ts` de jev-kubectl-voice): `getDeployment`, `getPods(path)` (JSON), `getEvents(ns)`, `logs(label, tail)`, `exec(pod, cmd)`.
- `demo/live-cluster/server/collector.ts` — arma el input diagnóstico:
  - `collectAppInput()`: `kubectl logs -l app=demo-app --tail=100 --all-containers` + estado resumido de pods.
  - `collectK8sInput()`: `kubectl get pods -l app=demo-app -o wide` + eventos (Warning/BackOff/OOMKilled/Failed) de las últimas 30 min.
- `demo/live-cluster/server/jevops.ts` — `analyze(pack, input, {packDir})`: spawn `JEVOPS_BIN analyze <pack> --pack-dir <dir> --json` con stdin = input; parsea stdout; mide `elapsed_ms`; errores con exit code 1–6 mapeados a mensajes legibles; `--provider typesafe` explícito (live).
- `demo/live-cluster/server/faults.ts` — `trigger(mode)`: `kubectl exec <pod> -- wget -qO- http://localhost:3000/<endpoint>` (busybox wget viene en node:20-alpine); mapeo boom→/boom, crash→/crash, oom→/oom, reset→/reset.
- `demo/live-cluster/server/server.ts` — rutas HTTP:
  - `GET /api/status` → deployment, replicas, readyReplicas, breakdown de pods, contexto k8s actual.
  - `GET /api/logs?kind=app|k8s` → últimas líneas recolectadas (poll del front).
  - `POST /api/analyze` → corre los 2 análisis en paralelo (kubernetes + demo-app) → `{analyses:[{pack,command,provider,inputBytes,decisions,elapsed_ms}], ts}`.
  - `POST /api/fault` `{mode}` → `faults.trigger`.
  - Nunca 500 por culpa de Jev o kubectl (errores tipados, patrón voice demo); sirve `public/` estático.

**Depends On** — Chunk 1 (contrato de logs/endpoints); Chunk 2 (pack).
**Accept When** — `npm run typecheck` y `npm test` pasan (tests unitarios con `node:test`, sin cluster ni API real: collector/jevops/faults mockeados); contra kind real: `/api/status` muestra la app, `/api/analyze` —con API key y red— devuelve decisiones de ambos packs con `elapsed_ms` sensible; `/api/fault` induce los 4 modos; `K8S_KUBECONFIG`/`K8S_CONTEXT` apuntan a otro contexto y todo sigue funcionando.
**Test Coverage** — `server/*.test.ts` (config, collector formatting, jevops parsing de JSON/errores, faults mapping). Sin llamadas reales (same rule que jev-kubectl-voice).

### Chunk 4 — Frontend

**Files Changed**
- `demo/live-cluster/public/index.html` — layout: header (pill de estado cluster + contexto), pod squares, log pane (pestañas app/k8s), botones de fault + Analyze, verdict cards, footer terminal.
- `demo/live-cluster/public/app.js` — polling `/api/status` y `/api/logs` cada 2 s; `analyze()` → POST `/api/analyze` → render cards (health/root_cause/severity/attention con confianza y barra, colores por severidad); botones fault → POST `/api/fault`; registro del último comando ejecutado por pack.
- `demo/live-cluster/public/style.css` — dark theme, sin fuentes externas (el wifi de la sala no es confiable — regla del demo de voz).

**Depends On** — Chunk 3.
**Accept When** — en kind: los squares se ponen rojo/naranja según fallo; los logs fluyen; Analyze contra live devuelve cards verosímiles por estado (sano → healthy/0, boom → errors_5xx/severity≥3, crash → crashloop, oom → oom_killed); footer muestra el comando real; todo funciona offline de assets (sin CDN).

### Chunk 5 — Scripts, e2e y docs

**Files Changed**
- `demo/live-cluster/scripts/demo-up.sh` — setup local: si no hay contexto activo → `kind create cluster --name jev-ops-demo`; `docker build -t demo-app:local app/`; `kind load docker-image demo-app:local`; `kubectl apply -f k8s/deployment.yaml`; `kubectl rollout status`. Respeta `K8S_KUBECONFIG` existente (no crea cluster si hay contexto).
- `demo/live-cluster/scripts/publish-image.sh` — push de la imagen a un registry (Docker Hub/GHCR) para el cluster de la nube el día de la charla (`DEMO_APP_IMAGE` ej. `pablokbs/jev-ops-demo-app:2026.11`).
- `demo/live-cluster/scripts/trigger-fault.sh` — helpers de terminal: `./trigger-fault.sh boom|crash|oom|reset|status`.
- `demo/live-cluster/scripts/e2e-smoke.sh` — smoke completo (mock provider, cero API): up → deploy → estado sano arroja `kubernetes.health=healthy` → induce cada fallo y `jq`-asserta con el pack `kubernetes` (crash → `root_cause=crashloop`; oom → `root_cause=resources`) y estructural con `demo-app` (JSON válido, 4 decisiones presentes, runner exit 0) → boom: pipeline corre y el cluster sigue healthy (los 5xx no cambian estado de pods) → reset → deja el cluster limpio. Falla con exit ≠ 0 si algo no matchea.
- `demo/live-cluster/README.md` — requisitos, setup (instalar binario jev-ops prebuilt v2026.09.19, exportar `TYPESAFE_API_KEY`), modo dev, **talk script 5–7 min** con checklist de pantallas y frases, checklist del día de la charla (cluster nube, imagen publicada, kubeconfig, red), troubleshooting.

**Depends On** — Chunks 1–4.
**Accept When** — `scripts/demo-up.sh` deja la demo corriendo de cero en una máquina limpia (con kind); `e2e-smoke.sh` pasa de punta a punta en < ~5 min con mock; README cubre el escenario cluster-nube.

## Verification Strategy

1. `npm run typecheck` + `npm test` (unit, sin cluster ni API).
2. `jev-ops packs validate demo/live-cluster/packs/demo-app/pack.yaml`.
3. `scripts/e2e-smoke.sh` contra kind con `--provider mock` (verifica pipeline completo: recolección → análisis → decisiones esperadas por fallo sobre el pack `kubernetes`; el pack `demo-app` se valida estructural, y su semántica por fallo se cubre en el chequeo live).
4. Chequeo live manual (documentado): `export TYPESAFE_API_KEY && npm run dev`, un `/api/analyze` real contra kind devuelve decisiones con confianza sane (coste: 2 llamadas a la API por análisis — excepción deliberada a "solo live": mock solo para tests/ensayo).
5. Checklist día de la charla ejecutado una vez contra el cluster de la nube antes del evento (red + imagen + kubeconfig + latencia).

## Decision Log

| Decisión | Opción elegida | Alternativas rechazadas |
| :--- | :--- | :--- |
| Interacción | Solo visual (UI) | Voz completa / voz-input — ya cubierta por jev-kubectl-voice; el usuario la descartó para esta demo |
| Cluster | kind en dev; cualquier kubeconfig externo (K8S_KUBECONFIG/K8S_CONTEXT) en la charla | Fijar minikube/rancher-desktop — el usuario usará un cluster chico en la nube |
| Modelo | Live `typesafe` en la charla; `mock` solo en tests/ensayo | Mock-only (el usuario quiere el modelo real) |
| App demo | App HTTP propia con modos de fallo (boom/crash/oom/reset) | Logs sintéticos sin cluster; reusar nginx del demo de voz |
| Packs | Pack builtin `kubernetes` + pack custom `demo-app` (demuestra extensibilidad sin tocar Rust) | Solo packs builtin — pierde la narrativa "packs = data" |
| Backend | Node 22 + TS + `node:http`, sin frameworks (patrón jev-kubectl-voice) | Express/Next — deps innecesarias |
| Binario | Prebuilt release `jev-ops-macos-arm64` v2026.09.19 (`curl` install) | Compilar con rustup — cargo no está instalado en esta máquina (verificado) y no aporta nada para una demo |
| Trigger de fallos | `kubectl exec <pod> -- wget` al puerto local del pod | Service/NodePort/Ingress — exec funciona igual en cluster externo y no expone nada |
| Idioma UI | Inglés (convención del repo); README con talk script en inglés | Español — repo/READMEs están en inglés |

## Risks

- **Solo live**: si la sala no tiene red, no hay demo. Mitigación: `mock` está siempre disponible (`--provider mock`, sin red) para ensayo y como plan B de emergencia; el ensayo general se hace con mock; la decisión de live-only es del usuario.
- **Latencia / rate limit de la API**: jev-ops reintenta 429/529 (built-in, max 3 con backoff). El UI mide y muestra `elapsed_ms` (parte de la demo: "Jev decide en ~1–3 s").
- **Pull de imagen en la sala**: para kind se precarga (`kind load`); para el cluster nube se publica antes (`publish-image.sh`) y el manifest apunta al registry.
- **Cluster nube el día D**: kubeconfig externo + kubectl compatible; `kubectl exec` debe estar permitido (cluster propio, ok); verificar latencia de la API desde la sala en el checklist.
- **Cargo no instalado**: no bloquea — se usa el binario prebuilt; si se quisiera compilar, instalar rustup (documentado como opción).

## Open Questions

- Ninguna bloqueante. Supuestos a confirmar en revisión: (a) el talk script y la UI en inglés; (b) usar el release prebuilt v2026.09.19 como binario de la demo en vez de compilar; (c) registry preferido para la imagen el día de la charla (Docker Hub vs GHCR — depende de la cuenta `pablokbs`).