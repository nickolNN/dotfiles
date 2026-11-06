import { readTextFileOrNull } from '../util/files';
import { join } from 'node:path';
import type { SessionEvent } from '@issue-resolver/shared';

const AUTHORED_REPORT_FILES = ['report.md', 'report.json'] as const;

const MODEL_ID_PATTERNS: RegExp[] = [
  /provider\d*\//i,
  /\*\*Model:\*\*/i,
  /\bmodel:\s*`?[a-z0-9._-]+\/[a-z0-9._-]+/i,
  /(?<=[`/:])(?:deepseek|claude|gpt|qwen|llama)[-.\w]*/i,
  /\b(?:deepseek|claude|gpt|qwen|llama)[-.\w]*(?=[`/:])/i,
];

export function detectModelLeak(issueDir: string, model?: string): string[] {
  const needles = new Set<string>();
  if (model) {
    needles.add(model);
    const bare = model.includes('/')
      ? model.slice(model.lastIndexOf('/') + 1)
      : '';
    if (bare.length >= 6) needles.add(bare);
  }

  const warnings: string[] = [];
  for (const name of AUTHORED_REPORT_FILES) {
    const text = readTextFileOrNull(join(issueDir, name));
    if (text === null) continue;
    const exact = [...needles].find((needle) => text.includes(needle));
    if (exact) {
      warnings.push(`model id leaked into ${name}`);
      continue;
    }
    if (MODEL_ID_PATTERNS.some((pattern) => pattern.test(text))) {
      warnings.push(`model-like id leaked into ${name}`);
    }
  }
  return warnings;
}

const PREVIOUS_REPORT_PATH =
  /(?:[^\s"'`\\]*\/)?(?:reports|\.iteration-results)\/[^\s"'`\\]+\/report\.(?:md|html)/;

export function anchoredPreviousReportPath(event: SessionEvent): string | null {
  if (event.type !== 'tool_use') return null;
  const match = PREVIOUS_REPORT_PATH.exec(JSON.stringify(event.args ?? ''));
  return match ? match[0] : null;
}

const reportWarnings = new Map<string, string[]>();

const observedReportModel = new Map<string, string>();

export function observedModelFor(issueId: string): string | undefined {
  return observedReportModel.get(issueId);
}

export function recordObservedModel(
  issueId: string,
  model: string | undefined,
): void {
  if (model) observedReportModel.set(issueId, model);
  else observedReportModel.delete(issueId);
}

export function recordReportWarnings(
  issueId: string,
  warnings: string[] | null,
): void {
  if (warnings === null) reportWarnings.delete(issueId);
  else reportWarnings.set(issueId, warnings);
}

export function reportWarningsFor(issueId: string, hostDir?: string): string[] {
  const live = reportWarnings.get(issueId) ?? [];
  if (!hostDir) return live;
  const flagged = new Set(live.map((warning) => warningFile(warning)));
  const derived = detectModelLeak(
    hostDir,
    observedReportModel.get(issueId),
  ).filter((warning) => !flagged.has(warningFile(warning)));
  return [...live, ...derived];
}

function warningFile(warning: string): string | null {
  const match = /leaked into (.+)$/.exec(warning);
  return match ? match[1] : null;
}
