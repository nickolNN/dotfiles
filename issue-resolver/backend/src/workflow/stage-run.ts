import { createHash } from 'node:crypto';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { numberOrNull } from '@issue-resolver/shared';
import type { NormalizedStage } from '@issue-resolver/shared';
import { asRecord } from '../util/records';
import { stringOrNull } from '../util/scalars';
import { readJsonFile } from '../util/json-file';

const MANIFEST_FILE = '.issue-stage-manifest.json';
const STAGE_FILE_PATTERN = /^\.issue-stage-.+\.json$/;

export interface StageRunManifest {
  iterationId: string;
  plan: string;
  stages: number;
}

export function stagePlanSignature(stages: NormalizedStage[]): string {
  const shape = stages.map((stage) => [
    stage.index,
    stage.name,
    stage.task,
    stage.executors ?? 1,
    stage.decomposition ?? [],
  ]);
  return createHash('sha1').update(JSON.stringify(shape)).digest('hex').slice(0, 12);
}

export function readStageRun(dir: string): StageRunManifest | null {
  const raw = readJsonFile(join(dir, MANIFEST_FILE), (value) => value);
  if (raw === null) return null;
  const record = asRecord(raw);
  const iterationId = stringOrNull(record?.iterationId);
  const plan = stringOrNull(record?.plan);
  if (iterationId === null || plan === null) return null;
  return { iterationId, plan, stages: numberOrNull(record?.stages) ?? 0 };
}

export function clearStageFiles(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === MANIFEST_FILE || !STAGE_FILE_PATTERN.test(name)) continue;
    rmSync(join(dir, name), { force: true });
  }
}

export function claimStageRun(
  dir: string,
  iterationId: string,
  plan: string,
  stages: number,
): boolean {
  const previous = readStageRun(dir);
  const sameRun =
    previous !== null &&
    previous.iterationId === iterationId &&
    previous.plan === plan;

  if (previous !== null && !sameRun) clearStageFiles(dir);
  writeStageRun(dir, { iterationId, plan, stages });

  return previous === null || sameRun;
}

function writeStageRun(dir: string, manifest: StageRunManifest): void {
  try {
    writeFileSync(
      join(dir, MANIFEST_FILE),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  } catch (error) {
    console.error('failed to write stage run manifest', error);
  }
}