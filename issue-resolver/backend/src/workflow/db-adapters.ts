import type { Db } from '../db/client';
import {
  appendStepRunEvent,
  createStepOutput,
  createStepRun,
  updateStepRun,
} from '../db/step-runs.repo';
import {
  getRepositoryByUrl,
  getRepositoryTestCredentials,
  updateRepositoryRunInstructions,
} from '../db/repositories.repo';
import { RunInstructionsStatus } from '@issue-resolver/shared';
import type { StepRunStore } from './iteration/contracts';
import type { RunInstructionsPort } from './prepare-workspace';

export function dbStepRunStore(db: Db): StepRunStore {
  return {
    createStepRun: (input) => createStepRun(db, input),
    updateStepRun: (id, patch) => updateStepRun(db, id, patch),
    appendStepRunEvent: (id, event) => appendStepRunEvent(db, id, event),
    createStepOutput: (input) => createStepOutput(db, input),
  };
}

export function dbRunInstructionsStore(db: Db): RunInstructionsPort {
  const warnUnmatched = (
    url: string,
    status: RunInstructionsStatus,
    matched: boolean,
  ): void => {
    if (matched) return;
    console.warn(
      `run instructions not saved: no repository row matches ${JSON.stringify(url)} (status ${status})`,
    );
  };

  return {
    getStatus: (url) => getRepositoryByUrl(db, url)?.runInstructionsStatus,
    getInstructions: (url) => getRepositoryByUrl(db, url)?.runInstructions ?? null,
    getCredentials: (url) => getRepositoryTestCredentials(db, url),
    saveGenerated: (url, instructions) =>
      warnUnmatched(
        url,
        RunInstructionsStatus.generated,
        updateRepositoryRunInstructions(db, url, {
          instructions,
          status: RunInstructionsStatus.generated,
        }),
      ),
    saveFailed: (url) =>
      warnUnmatched(
        url,
        RunInstructionsStatus.failed,
        updateRepositoryRunInstructions(db, url, {
          instructions: null,
          status: RunInstructionsStatus.failed,
        }),
      ),
  };
}
