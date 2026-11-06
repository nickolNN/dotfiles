import { readTextFileOrNullAsync } from '../util/files';
import { join } from 'node:path';
import { REFINED_PLAN_CHAR_LIMIT } from '@issue-resolver/shared';

const LINE_REF = /(?:^|[\s(`'"[\]])((?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|css|scss|py|go|rb|vue|json|md|ya?ml)):(\d+)(?:-\d+)?/;

export function planShapeWarnings(plan: string | null): string[] {
  if (plan === null) {
    return [
      'plan.md отсутствует — исполнитель получит только summary, брифа нет.',
    ];
  }
  const match = LINE_REF.exec(plan);
  if (!match) return [];
  return [
    `plan.md ссылается на строки (${match[1]}:${match[2]}) — правку проектирует исполнитель, бриф описывает поведение; ссылка на строку устареет после первого же изменения.`,
  ];
}

export type ExpandedPlan = { text: string; truncated: boolean };

export async function readExpandedPlan(
  dir: string,
): Promise<ExpandedPlan | null> {
  const trimmed = (await readTextFileOrNullAsync(join(dir, 'plan.md')))?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= REFINED_PLAN_CHAR_LIMIT) {
    return { text: trimmed, truncated: false };
  }
  return { text: trimmed.slice(0, REFINED_PLAN_CHAR_LIMIT), truncated: true };
}