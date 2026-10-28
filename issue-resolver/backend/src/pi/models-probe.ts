import { spawn } from 'node:child_process';

import type { ModelDescriptor } from '@issue-resolver/shared';

import { modelDescriptorFromPiModel } from '../models/source';

/**
 * The model list, asked of Pi itself.
 *
 * A static read of `models.json` cannot answer two questions the UI asks: which
 * thinking levels a model really supports, and which models exist when the
 * config directory is not the one we guessed. A short-lived `pi --mode rpc`
 * answers both, and the probe keeps that answer for a while because spawning Pi
 * is not free.
 */
export interface ModelsProbe {
  /** Probed models, or `[]` when Pi could not answer (caller falls back). */
  list(): Promise<ModelDescriptor[]>;
}

export interface ModelsProbeOptions {
  /** Actual probe; replaceable so tests never spawn a process. */
  run?: () => Promise<ModelDescriptor[]>;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;

export function createModelsProbe(
  options: ModelsProbeOptions = {},
): ModelsProbe {
  const run = options.run ?? probeLiveModels;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  let cached: { at: number; models: ModelDescriptor[] } | null = null;
  let pending: Promise<ModelDescriptor[]> | null = null;

  return {
    async list() {
      if (cached && now() - cached.at < ttlMs) return cached.models;
      if (pending) return pending;
      pending = run()
        .then((models) => {
          // An empty answer means "not now", not "no models": caching it would
          // hide a transient failure for the whole TTL.
          if (models.length > 0) cached = { at: now(), models };
          return models;
        })
        .catch(() => [] as ModelDescriptor[])
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}

/**
 * Spawns a bare `pi --mode rpc` and asks for the model list once.
 *
 * No session, no MCP servers, no extensions: the probe only needs the model
 * catalogue, and every server or extension it would otherwise start shows up as
 * latency inside the timeout. Models come from the catalogue, not from them.
 */
function probeLiveModels(): Promise<ModelDescriptor[]> {
  return new Promise<ModelDescriptor[]>((resolve) => {
    const child = spawn(
      process.env.PI_BIN ?? 'pi',
      ['--mode', 'rpc', '--no-session', '--no-mcp', '--no-extensions'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let settled = false;
    let buffer = '';
    let stderr = '';

    const finish = (models: ModelDescriptor[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(models);
    };

    const timer = setTimeout(() => {
      console.error('models probe: timed out', { stderr: stderr.slice(-400) });
      finish([]);
    }, PROBE_TIMEOUT_MS);

    child.on('error', (error) => {
      console.error('models probe: spawn failed', error);
      finish([]);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.command !== 'get_available_models') continue;
        finish(modelsFromProbeResponse(event));
        return;
      }
    });

    child.stdin?.write(
      `${JSON.stringify({ type: 'get_available_models' })}\n`,
    );
  });
}

/** Pi answers with full model objects; we keep only the public projection. */
export function modelsFromProbeResponse(
  event: Record<string, unknown>,
): ModelDescriptor[] {
  if (event.success === false) return [];
  const data =
    typeof event.data === 'object' && event.data !== null
      ? (event.data as Record<string, unknown>)
      : {};
  const models = Array.isArray(data.models) ? data.models : [];
  const out: ModelDescriptor[] = [];
  for (const raw of models) {
    if (typeof raw !== 'object' || raw === null) continue;
    const descriptor = modelDescriptorFromPiModel(
      raw as Record<string, unknown>,
    );
    if (descriptor) out.push(descriptor);
  }
  return out;
}
