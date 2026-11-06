import { PipelineStep } from '@issue-resolver/shared';

const PIPELINE_ORDER: readonly PipelineStep[] = [
  PipelineStep.refine,
  PipelineStep.resolve,
  PipelineStep.review,
  PipelineStep.test,
  PipelineStep.pr,
  PipelineStep.report,
];

export interface VerificationGate {
  step: PipelineStep;
  label: string;
  description: string;
}

const VERIFICATION_STEPS: readonly VerificationGate[] = [
  { step: PipelineStep.review, label: 'Review', description: 'independent code review (source code only).' },
  { step: PipelineStep.test, label: 'Test', description: 'runtime/browser verification (Playwright).' },
];

export function downstreamVerification(
  pipelineSteps: PipelineStep[] | undefined,
  step: PipelineStep,
): VerificationGate[] {
  if (!pipelineSteps || pipelineSteps.length === 0) return [];
  const from = PIPELINE_ORDER.indexOf(step);
  return VERIFICATION_STEPS.filter(
    (gate) => PIPELINE_ORDER.indexOf(gate.step) > from && pipelineSteps.includes(gate.step),
  );
}

export function refinePipelineAwareness(pipelineSteps?: PipelineStep[]): string[] {
  if (!pipelineSteps || pipelineSteps.length === 0) return [];
  const gates = downstreamVerification(pipelineSteps, PipelineStep.refine);
  const lines: string[] = [''];
  if (gates.length > 0) {
    lines.push(
      'The following verification steps run AFTER the execution (resolve) step:',
      ...gates.map((gate) => `  - ${gate.label}: ${gate.description}`),
      'Coordinate your plan with these steps — do NOT duplicate their work.',
      'Keep only lightweight developer self-checks in the plan (local build/',
      'typecheck/unit smoke) so the hand-off to review/test is clean. Do NOT',
      'bake a full verification/acceptance pass into the execution plan — that',
      'belongs to the dedicated Review/Test steps. You MAY add intermediate',
      'checkpoints if useful.',
    );
  } else {
    lines.push(
      'No separate Review/Test step follows the execution step — the resolve step',
      'is the FINAL verification gate, so plan full self-verification there.',
    );
  }
  return lines;
}

export function resolveDownstreamAwareness(pipelineSteps?: PipelineStep[]): string[] {
  const gates = downstreamVerification(pipelineSteps, PipelineStep.resolve);
  if (gates.length === 0) {
    return [
      '',
      'This run has no separate Review/Test step after you — your own verification',
      'is the FINAL gate, so check the change end to end before reporting pass.',
    ];
  }
  return [
    '',
    'Downstream verification steps run AFTER you — do NOT duplicate them:',
    ...gates.map((gate) => `  - ${gate.label}: ${gate.description}`),
    'Limit your own verification to local self-checks (build/tests/typecheck) to',
    'hand over cleanly. Full verification is done by the dedicated steps.',
  ];
}

export function workerDownstreamAwareness(pipelineSteps?: PipelineStep[]): string[] {
  const gates = downstreamVerification(pipelineSteps, PipelineStep.resolve);
  if (gates.length === 0) {
    return [
      '',
      'This run has no separate Review/Test step after the resolve step — your own',
      'check of your sub-task is part of the FINAL gate, so make it thorough.',
    ];
  }
  return [
    '',
    'Downstream verification steps run AFTER the resolve step — do NOT duplicate them:',
    ...gates.map((gate) => `  - ${gate.label}: ${gate.description}`),
    'Keep to local self-checks of your own sub-task; the dedicated steps verify',
    'the integrated result.',
  ];
}