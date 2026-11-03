# Autopilot: cerrar el loop — de decisión tipada a acción en el cluster

## Goal

Extender el demo `demo/live-cluster/` para que, además de diagnosticar, **actúe automáticamente** sobre decisiones de Jev cuando está armado:

1. **Remediar** faults de infraestructura (crashloop / OOM): delete de pods acotado al selector, solo con confianza y severidad altas.
2. **Volver a analizar (verificar)** tras remediar, con máximo 1 intento por incidente.
3. **Escalar a humano (alerta)** cuando (a) la remediación no curó el incidente, o (b) el problema es de aplicación (`errors_5xx`, `db_connection`…) y no existe acción de cluster segura — "automation knows its limits".

Alertas: feed en el dashboard siempre; `SLACK_WEBHOOK_URL` opcional (timeout 3s, no-fatal). UI: toggle **Autopilot: ARMED/DISARMED**, resumen de política, y feed de acciones/alertas.

Narrativa resultante en escena: armás el toggle → Crash → cuadrados rojos → Jev detecta (sev ≥ 4, conf ≥ 85%) → el server borra pods → cuadrados verdes **sin que toques nada** → con 500s, banner de escalación "no safe action — paging human".

## Constraints

- Cero dependencias nuevas (node:http + fetch global de Node 22, igual que hoy).
- `AUTOPILOT_ARMED` default **false** — en escena lo armás explícitamente.
- La única acción sobre el cluster sigue siendo `kubectl delete pod -l <selector> -n <ns>`, ya existente y acotada por label + namespace.
- No persistencia: estado de incidentes en memoria (un restart del server = slate limpio, más seguro para el demo).
- Respetar convenciones: TS estricto (`npm run typecheck`), tests node:test por módulo, README/env como fuente de verdad.

## Chunks

### 1. Política pura + estado de incidentes — `server/remediate.ts` (nuevo) + `server/remediate.test.ts` (nuevo)

**Goal:** decidir qué hacer (nada / remediar / escalar) sin tocar IO.

- Tipos: `RemediationDecision = { kind: 'none'|'remediate'|'escalate', reason, action?, decision snapshot }`, `Incident { key, rootCause, attempts, lastActionAt, lastAlertAt, resolved }`, `IncidentStore` en memoria (Map + dedup + cooldown fijo 90s para alertas).
- `evaluatePolicy(analyses: AnalysisOutcome[], store, now, thresholds)`:
  - Toma el pack `kubernetes`: `needs_attention=true` && `severity >= min` && `root_cause ∈ {crashloop, resources}` && `confidence >= minConf` && attempts < max → `remediate` (action: `delete-pods`).
  - Mismo incidente sigue `needs_attention` después de un intento agotado → `escalate` ("remediation ineffective").
  - Pack `demo-app`: `needs_attention=true` && `confidence >= minConf` && `root_cause ∉ {crashloop, oom_killed}` (los dos se curan con pod delete, que ya cubre el pack k8s) → `escalate` ("no safe automated action").
  - `health=healthy` en ambos packs cierra el incidente abierto.
- **Accept when:** la matriz de casos está cubierta por tests puros: healthy→none; crashloop alta conf→remediate; baja conf→none con razón; mismo incidente re-detectado tras 1 intento→escalate; 500s→escalate "no safe action"; cooldown evita alertas duplicadas; healthy cierra incidente.
- **Test coverage:** `remediate.test.ts` con outcomes sintéticos `AnalysisOutcome`.
- **Depends on:** — (usa tipos de `jevops.ts`, sin cambios ahí).
- **Open questions:** —

### 2. Orquestador, config y API — `server/autopilot.ts` (nuevo) + `server/config.ts`, `server/server.ts`, tests

**Goal:** conectar política con kubectl/Slack y exponerlo por HTTP.

- `config.ts` (+test): `autopilotArmed` (AUTOPILOT_ARMED, false), `autopilotIntervalMs` (15000), `autopilotMinConfidence` (0.85), `autopilotMinSeverity` (4), `autopilotMaxAttempts` (1), `slackWebhookUrl` (SLACK_WEBHOOK_URL, null).
- `autopilot.ts`:
  - `runAnalysisOnce(cfg)` — extrae lo que hoy hace `/api/analyze` (collect → analyze × 2 → si armed, evaluatePolicy → actuar/alertar → registrar) para que ambos caminos compartan lógica; single-flight (si hay una corrida en curso, la devuelve).
  - Loop `setInterval` solo cuando armed.
  - Ejecutor: `deletePods(cfg)` (ya existe en `kubectl.ts`); registra acción con snapshot de la decisión que la disparó.
  - Feed server-side (acciones + alertas, cap 50, in-memory) y `postSlack(text)`: solo escalaciones, fetch global, `AbortSignal.timeout(3000)`, errores al feed, nunca rompen el loop.
- `server.ts`: `GET /api/autopilot` → `{armed, policy, actions, alerts}`; `POST /api/autopilot {armed}` → arma/desarma (arranca/frena el loop); `/api/analyze` delega en `runAnalysisOnce` y agrega `automation` al body; `/api/config` expone `hasSlackWebhook`.
- **Accept when:** con `JEVOPS_PROVIDER=mock` y umbral de confianza 0, armar por POST + inyectar crash deja una acción `delete-pods` registrada y los pods se recuperan solos; desarmar frena el loop; sin `SLACK_WEBHOOK_URL` no hay llamadas externas; errores de kubectl llegan al feed, no 500.
- **Test coverage:** `autopilot.test.ts` liviano (feed con cap, slack no-op sin URL, single-flight); `config.test.ts` extendido.
- **Depends on:** chunk 1.
- **Open questions:** —

### 3. UI — `public/index.html`, `public/app.js`, `public/style.css`

**Goal:** que la automatización sea visible sin tocar el speaker notes.

- Toggle grande **Autopilot** (gris DISARMED / rojo pulsante ARMED) junto al botón Analyze; pill secundaria con la política resumida (`sev≥4 · conf≥85% · delete pods · 1 intento`).
- Panel nuevo "🤖 Automation" con feed de acciones (🤖 `deleted 3 pods — crashloop sev4 conf 96%`) y escalaciones (🚨, estilo `bad`), poll de `GET /api/autopilot` cada 2s; el resultado `automation` de `/api/analyze` se muestra bajo los verdicts como razón de "actuó / no actuó".
- **Accept when:** en vivo se ve toggle→rojo, cuadrados rojos→acción en el feed→cuadrados verdes, y con boom aparece la 🚨 sin acción de cluster.
- **Test coverage:** — (UI sin tests, verificación manual + e2e).
- **Depends on:** chunk 2.
- **Open questions:** —

### 4. e2e + docs — `scripts/e2e-smoke.sh`, `README.md`, `.env.example`

**Goal:** el loop completo queda probado offline y documentado.

- `e2e-smoke.sh`: nueva sección autopilot con `JEVOPS_PROVIDER=mock`, `AUTOPILOT_MIN_CONFIDENCE=0` (la confianza del mock es opaca), intervalo corto (3s): arm POST → crash → assert recuperación sin reset manual + acción registrada vía GET → desarmar.
- README: sección Autopilot (modo manual vs armado), filas nuevas en la tabla de env, paso en el talk script ("arm → crash → se cura solo → 500s → escalación"), troubleshooting.
- `.env.example`: variables `AUTOPILOT_*` + `SLACK_WEBHOOK_URL`.
- **Accept when:** `./scripts/e2e-smoke.sh` pasa completo contra el cluster de DO con mock.
- **Test coverage:** la propia e2e.
- **Depends on:** chunks 2 y 3.
- **Open questions:** —

## Verification Strategy

1. `npm run typecheck` + `npm test` tras cada chunk (unidad: política al 100% de la matriz, config, autopilot liviano).
2. `./scripts/e2e-smoke.sh` completo contra el cluster DO (mock) — chunk 4.
3. Pasada manual con `TYPESAFE_API_KEY` real (la hace el usuario): arm → crash → autocura; 500s → escalación en feed; y si hay webhook de Slack configurado, mensaje recibido.

## Decision Log

- **Acción = `kubectl delete pod`** (no `rollout undo`): las fallas del demo se inyectan por exec, no por deploy; borrar el pod destruye el `emptyDir` del fault flag → cura real de crash/OOM. Rollback no tendría causa en este demo.
- **Trigger ligado al pack `kubernetes`** para actuar y al pack `demo-app` solo para escalar: separación infra (automatizable) vs aplicación (humano) — es el discurso "two packs, one cluster".
- **Max 1 intento + verify antes de escalar**: automatización acotada, anti-flapping; si no curó, humano.
- **La escalación de 500s es "no safe action"**, no "remediate falló": da el momento escénico de límites sin necesitar un fault irreparable.
- **Cooldown de alertas fijo en código (90s)** y no env var: achicar superficie de configuración.
- **`/api/analyze` manual también evalúa la política** (vía `runAnalysisOnce` compartido): coherencia — si está armado, Analyze muestra "por qué actuó / no actuó".
- **Estado en memoria, DISARMED al boot:** durante un demo, persistencia es un bug, no un feature.
- **Sin dependencias nuevas**: Slack vía `fetch` global de Node 22.

## Risks

- **Confianza/severidad del mock desconocidas** → la e2e fija `AUTOPILOT_MIN_CONFIDENCE=0` (y severidad 0 si hiciera falta) para ser determinística; se confirma al implementar corriendo el mock una vez.
- **Latencia del loop con la API live** (2 calls/15s): trivial en un demo de 7 min; intervalo configurable; el loop solo corre armed.
- **Red de Slack en el venue**: canal opcional, default off, timeout 3s no-fatal; el dashboard es el canal primario.
- **Overlap entre Analyze manual y el loop**: single-flight en `runAnalysisOnce`.
- **Blast radius del delete**: acotado a `-l app=demo-app -n default` (mismo patrón que el Recover actual).
