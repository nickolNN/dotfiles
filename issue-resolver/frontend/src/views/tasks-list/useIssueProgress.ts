import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { StepRunStatus } from '@issue-resolver/shared';
import { subscribeToGlobalStream } from '../../api/sse';
import { isRecord } from '../../api/guards';
import { isTaskStatus } from './format';
import type { IssueWithActiveStep } from './types';

interface ProgressEventPayload {
  status?: string;
  step?: string;
  model?: string | null;
}

function isProgressPayload(value: unknown): value is ProgressEventPayload {
  if (!isRecord(value)) return false;
  return (
    (typeof value.status === 'undefined' ||
      typeof value.status === 'string') &&
    (typeof value.step === 'undefined' || typeof value.step === 'string') &&
    (typeof value.model === 'undefined' ||
      value.model === null ||
      typeof value.model === 'string')
  );
}

function parseProgressPayload(data: string): ProgressEventPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return isProgressPayload(parsed) ? parsed : null;
}

function applyStepStatus(
  current: IssueWithActiveStep[],
  issueId: string,
  payload: ProgressEventPayload | null,
): IssueWithActiveStep[] {
  if (payload === null) return current;

  if (payload.status === StepRunStatus.running && payload.step !== undefined) {
    const activeStep = payload.step;
    const activeModel = payload.model ?? null;
    return current.map((issue) =>
      issue.id === issueId
        ? { ...issue, activeStep, activeModel }
        : issue,
    );
  }
  if (payload.status && payload.status !== StepRunStatus.running) {
    return current.map((issue) =>
      issue.id === issueId
        ? { ...issue, activeStep: undefined, activeModel: undefined }
        : issue,
    );
  }
  return current;
}

export function useIssueProgress(
  setIssues: Dispatch<SetStateAction<IssueWithActiveStep[]>>,
): void {
  useEffect(() => {
    return subscribeToGlobalStream({
      onStepStatus: (event) => {
        const issueId = event.issueId;
        if (!issueId) return;
        const payload = parseProgressPayload(event.data);
        setIssues((current) => applyStepStatus(current, issueId, payload));
      },
      onIterationStatus: (event) => {
        const issueId = event.issueId;
        if (!issueId) return;
        const payload = parseProgressPayload(event.data);
        if (payload === null || !isTaskStatus(payload.status)) return;
        const nextStatus = payload.status;
        setIssues((current) =>
          current.map((issue) =>
            issue.id === issueId ? { ...issue, status: nextStatus } : issue,
          ),
        );
      },
    });
  }, [setIssues]);
}