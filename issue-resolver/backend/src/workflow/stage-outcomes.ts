import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStepReport, type NormalizedStage } from '@issue-resolver/shared';

/** Исход уже завершённого этапа staged-прогона (для финального lead). */
export interface StageOutcome {
  stage: NormalizedStage;
  outcome: string;
}

/** Прогресс staged-прогона, восстановленный по файлам исходов этапов. */
export interface StagedResume {
  /** Этапы с валидным сохранённым исходом до первого пропуска, по порядку. */
  completed: StageOutcome[];
  /**
   * 1-based индекс первого этапа без валидного исхода; `stages.length + 1`,
   * если готовы все (тогда запускается только финальный координатор).
   */
  resumeIndex: number;
}

/**
 * Читает `.issue-stage-<i>.json` из рабочей папки задачи и возвращает его
 * непустое summary либо null (файла нет / не парсится / summary пустое).
 */
export function readStageOutcome(
  hostWorkspaceDir: string,
  stageIndex: number,
): string | null {
  try {
    const report = parseStepReport(
      readFileSync(
        join(hostWorkspaceDir, `.issue-stage-${stageIndex}.json`),
        'utf-8',
      ),
    );
    const summary = report?.summary?.trim();
    return summary ? summary : null;
  } catch {
    return null;
  }
}

/**
 * Восстанавливает прогресс staged-прогона по персистентным файлам этапов.
 * `completed` — этапы с валидным `.issue-stage-<i>.json` до первого пропуска,
 * `resumeIndex` — первый этап без валидного исхода. Упавший/прерванный этап не
 * оставляет файла, поэтому self-retry естественно возобновляется с него.
 *
 * Без `hostWorkspaceDir` (тесты/фейки без диска) прогресс не восстанавливается:
 * прогон идёт с первого этапа целиком, как раньше.
 */
export function readStageOutcomes(
  hostWorkspaceDir: string | undefined,
  stages: NormalizedStage[],
): StagedResume {
  if (!hostWorkspaceDir) return { completed: [], resumeIndex: 1 };
  const completed: StageOutcome[] = [];
  for (const stage of stages) {
    const outcome = readStageOutcome(hostWorkspaceDir, stage.index);
    if (outcome === null) {
      return { completed, resumeIndex: stage.index };
    }
    completed.push({ stage, outcome });
  }
  return { completed, resumeIndex: stages.length + 1 };
}