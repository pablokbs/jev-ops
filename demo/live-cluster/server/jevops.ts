import { spawn } from 'node:child_process';

/** One typed decision returned by jev-ops. */
export interface Decision {
  type: string;
  value: string | number | boolean;
  confidence: number;
  probabilities?: Record<string, number>;
}

/** A completed analysis: the typed verdict plus provenance. */
export interface AnalysisResult {
  pack: string;
  command: string;
  provider: string;
  inputBytes: number;
  truncated: boolean;
  decisions: Record<string, Decision>;
  elapsedMs: number;
  ok: true;
}

/** A failed analysis, surfaced as a card the UI can render. */
export interface AnalysisError {
  pack: string;
  command: string;
  ok: false;
  error: string;
  elapsedMs: number;
}

export type AnalysisOutcome = AnalysisResult | AnalysisError;

export interface AnalyzeOptions {
  bin: string;
  packDir: string;
  apiKey: string | null;
  pack: string;
  input: string;
  command: string;
  provider?: string;
  timeoutMs?: number;
}

interface ParsedBody {
  provider: string;
  input: { bytes: number; truncated: boolean };
  decisions: Record<string, Decision>;
}

/** jev-ops exit codes (see README) mapped to human-readable reasons. */
function exitCodeMessage(code: number, stderr: string): string {
  switch (code) {
    case 2:
      return `jev-ops: invalid CLI usage${stderr ? ` — ${stderr.trim()}` : ''}`;
    case 3:
      return `jev-ops: invalid pack${stderr ? ` — ${stderr.trim()}` : ''}`;
    case 4:
      return 'jev-ops: invalid input (empty, too large, or not text)';
    case 5:
      return `jev-ops: inference provider failed (no TYPESAFE_API_KEY, or API error)${stderr ? ` — ${stderr.trim()}` : ''}`;
    case 6:
      return 'jev-ops: provider returned decisions that violate the pack schema';
    default:
      return `jev-ops exited with code ${code}${stderr ? ` — ${stderr.trim()}` : ''}`;
  }
}

/** Pure JSON body parser, exported for tests. */
export function parseAnalysisOutput(stdout: string): ParsedBody {
  const body = JSON.parse(stdout) as Partial<ParsedBody> & { schema_version?: unknown };
  if (body.schema_version !== '1' || !body.decisions || !body.input || !body.provider) {
    throw new Error('unexpected response shape from jev-ops (missing schema_version/decisions/input/provider)');
  }
  return { provider: body.provider, input: body.input, decisions: body.decisions };
}

/** Runs one `jev-ops analyze <pack> --json` against live TypeSafe Jev. */
export function analyze(opts: AnalyzeOptions): Promise<AnalysisOutcome> {
  const {
    bin,
    packDir,
    apiKey,
    pack,
    input,
    command,
    provider = 'typesafe',
    timeoutMs = 60_000,
  } = opts;

  return new Promise((resolve) => {
    // Live TypeSafe needs the key; the offline mock provider does not.
    if (!apiKey && provider === 'typesafe') {
      resolve({
        pack,
        command,
        ok: false,
        error: 'TYPESAFE_API_KEY is not set — export it (the server only reads environment variables). jev-ops exits 5 without it.',
        elapsedMs: 0,
      });
      return;
    }

    const started = Date.now();
    const args = [
      'analyze',
      pack,
      '--pack-dir',
      packDir,
      '--provider',
      provider,
      '--json',
    ];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (apiKey) env.TYPESAFE_API_KEY = apiKey;
    let child;
    try {
      child = spawn(bin, args, { env });
    } catch (err) {
      resolve({
        pack,
        command,
        ok: false,
        error: `failed to spawn ${bin}: ${err instanceof Error ? err.message : String(err)}`,
        elapsedMs: Date.now() - started,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome: AnalysisOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        pack,
        command,
        ok: false,
        error: `jev-ops timed out after ${timeoutMs}ms (TypeSafe API slow or unreachable)`,
        elapsedMs: Date.now() - started,
      });
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        finish({
          pack,
          command,
          ok: false,
          error: `jev-ops binary not found at '${bin}' — install the prebuilt binary or set JEVOPS_BIN`,
          elapsedMs: Date.now() - started,
        });
      } else {
        finish({
          pack,
          command,
          ok: false,
          error: `failed to start ${bin}: ${err.message}`,
          elapsedMs: Date.now() - started,
        });
      }
    });
    child.on('close', (code) => {
      const elapsedMs = Date.now() - started;
      if (code === 0) {
        try {
          const parsed = parseAnalysisOutput(stdout);
          finish({
            pack,
            command,
            provider: parsed.provider,
            inputBytes: parsed.input.bytes,
            truncated: parsed.input.truncated,
            decisions: parsed.decisions,
            elapsedMs,
            ok: true,
          });
        } catch (err) {
          finish({
            pack,
            command,
            ok: false,
            error: `could not parse jev-ops output: ${err instanceof Error ? err.message : String(err)}`,
            elapsedMs,
          });
        }
        return;
      }
      finish({
        pack,
        command,
        ok: false,
        error: exitCodeMessage(code ?? -1, stderr),
        elapsedMs,
      });
    });

    child.stdin.end(input + '\n');
  });
}