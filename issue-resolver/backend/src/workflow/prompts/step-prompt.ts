import {
  MAX_PIPELINE_ATTEMPTS,
  maxExecutorsFor,
  REFINED_PLAN_CHAR_LIMIT,
  type DesiredResult,
  PipelineStep,
} from '@issue-resolver/shared';
import type { RepoChangeDigest } from '../../git/service';
import { refinePipelineAwareness, resolveDownstreamAwareness } from './downstream';
import {
  attachmentsBlock,
  DEPENDENCIES_PREPARED,
  credentialsBlock,
  devServerBlock,
  grouped,
  outputContract,
  parallelismBlock,
  pipelineLine,
  previousOutcomeBlock,
  refinedPlanBlock,
  reposBlock,
  taskContext,
  withSharedFragments,
  workingFolderBlock,
  workingStateBlock,
  type PrTarget,
} from './fragments';
import { prSkillBlock, readPrompt, render } from './loader';

export interface StepPromptInput {
  step: PipelineStep;
  issueTitle: string;
  description: string;
  jiraText: string | null;
  reviewContext?: string | null;
  context: string;
  feedback: string | null;
  repoPaths: string[];
  refinedPlan?: string | null;
  desiredResult?: DesiredResult;
  attachmentPaths?: string[];
  previousOutcome?: string | null;
  pipelineSteps?: PipelineStep[];
  devServerPort?: number | null;
  credentials?: string | null;
  prTargets?: PrTarget[];
  workerCount?: number;
  stateDigest?: RepoChangeDigest[];
  iterationCount?: number;
  iterationNarrativesDir?: string;
  workingDir?: string;
  attempt?: number;
}

function attemptLimitBlock(): string {
  return [
    'A `fail` with a `major` or `critical` finding sends the change back to',
    'development. `minor`, `low` and `info` findings are recorded and the pipeline',
    'moves on. The iteration gets',
    `${MAX_PIPELINE_ATTEMPTS} development attempts in total; while blocking findings`,
    'remain and the budget is used up, the run stops and asks the human',
    '(`needs_input`) instead of starting another cycle. Report the honest verdict',
    'even on the last attempt — exhausting the budget is the system\'s problem,',
    'not a reason to inflate a severity or to soften one.',
  ].join('\n');
}

function verificationModeBlock(attempt?: number): string {
  const current = attempt ?? 1;
  if (current <= 1) {
    return [
      '## Verification mode',
      '',
      `This is verification attempt 1 of ${MAX_PIPELINE_ATTEMPTS}: run the FULL matrix`,
      'in one pass — every scenario, the responsive extremes, the unhappy paths — and',
      'put every defect it produces into the `findings` of this same report.',
    ].join('\n');
  }
  return [
    '## Verification mode',
    '',
    `This is verification attempt ${current} of ${MAX_PIPELINE_ATTEMPTS} — a`,
    're-verification round, not a fresh audit:',
    '',
    '1. Re-check the findings the previous round handed you (the previous-step',
    '   feedback above lists them), one by one: fixed or not.',
    '2. Check the paths those findings name plus the code this round used to close',
    '   them. The rest of the change set was accepted in an earlier round: a',
    '   finding there is `minor`, not a blocker.',
    "3. Run the repository's own build and tests.",
    '',
    'Anything you notice outside that surface goes into `findings` as `info`/`low`/',
    '`minor`; it is recorded but does not start another development round.',
    'Re-run the full matrix (responsive extremes, JS off, clean clone, guard',
    'mutations) only when the round changed executable code; a round that touched',
    'only prose gets the prose re-check plus the build and tests above. When the',
    'feedback lists no findings, treat this as the first round and run the full',
    'matrix. Say in `summary` what you re-ran and what came from the earlier pass.',
    '',
    'If every finding of the previous round is closed and no blocker remains,',
    'report `pass` — even if an improvement can be imagined. Finding nothing is a',
    'result, not a failed verification.',
    'A scenario that only execution can check does not belong in `findings`:',
    'name it in `summary` for the `test` step, or as a risk left untested when',
    'this pipeline has no `test` step.',
  ].join('\n');
}

function prTargetsBlock(targets?: PrTarget[]): string {
  if (!targets || targets.length === 0) {
    return 'No repositories in this task — there is nothing to publish.';
  }
  return [
    ...targets.map(
      (target) =>
        `- ${target.path} — base \`${target.baseBranch}\`, create MR: ${target.createMr ? 'yes' : 'no (the result stays as files in the working folder)'}`,
    ),
  ].join('\n');
}

function iterationNarrativesBlock(iterationCount: number): string {
  if (iterationCount <= 0) {
    return '(No iteration narratives available — the pipeline produced no iterations.)';
  }
  const lines: string[] = [
    'The following folders are at the working-folder root. Each contains',
    'per-step narratives written by the pipeline steps of that iteration.',
    'The files are `.<step>.md` (e.g. `.refine.md`, `.resolve.md`,',
    '`.review.md`, `.test.md`, `.pr.md`). Read every file — they are your',
    'primary sources.',
    '',
  ];
  for (let i = 1; i <= iterationCount; i++) {
    lines.push(
      `- \`iterations/${i}/\` — iteration ${i} narratives:`,
      '  `.<step>.md` files for each pipeline step that ran in this iteration.',
    );
  }
  return lines.join('\n');
}

type StepBodyBuilder = (input: StepPromptInput) => string;

/** Fragments only a verifying step reads: the severity ladder is not resolve's job. */
const VERIFIER_FRAGMENTS: Partial<Record<PipelineStep, string[]>> = {
  [PipelineStep.review]: ['severity.md', 'review-standards.md'],
  [PipelineStep.test]: ['severity.md'],
};

const STEP_BODIES: Record<PipelineStep, StepBodyBuilder> = {
  refine: (input) => {
    const cap = maxExecutorsFor(input.workerCount);
    return render(readPrompt('step-refine.md'), {
      MAX_EXECUTORS: String(cap),
      PLAN_CHAR_LIMIT: grouped(REFINED_PLAN_CHAR_LIMIT),
      PARALLELISM: parallelismBlock(cap),
      DOWNSTREAM_AWARENESS: refinePipelineAwareness(input.pipelineSteps).join('\n'),
    });
  },

  resolve: (input) =>
    render(readPrompt('step-resolve-single.md'), {
      REPO_GUIDANCE:
        input.repoPaths.length > 0
          ? `Work in the repository working paths above.\n${DEPENDENCIES_PREPARED}`
          : '',
      DOWNSTREAM_AWARENESS: resolveDownstreamAwareness(input.pipelineSteps).join('\n'),
    }),

  review: (input) =>
    render(readPrompt('step-review.md'), {
      REVIEW_CONTEXT: input.reviewContext
        ? `Reviewer context (focus points, regression risks, or acceptance\ncriteria from the task owner) — check each of them explicitly:\n${input.reviewContext}`
        : '',
      VERIFICATION_MODE: verificationModeBlock(input.attempt),
    }),

  test: (input) =>
    render(readPrompt('step-test.md'), {
      DEV_SERVER: devServerBlock(input.devServerPort),
      CREDENTIALS: credentialsBlock(input.credentials),
      ATTEMPT_LIMIT: attemptLimitBlock(),
      VERIFICATION_MODE: verificationModeBlock(input.attempt),
    }),

  pr: (input) =>
    render(readPrompt('step-pr.md'), {
      PR_TARGETS: prTargetsBlock(input.prTargets),
      PR_SKILL: prSkillBlock(),
    }),

  report: (input) => {
    const iterationCount = input.iterationCount ?? 0;
    return render(readPrompt('step-report.md'), {
      ITERATION_NARRATIVES: iterationNarrativesBlock(iterationCount),
    });
  },

  devops: () => 'DevOps step — prompt built by loadDevOpsPrompt in devops.ts',
};

export function buildStepPrompt(input: StepPromptInput): string {
  const lines: string[] = [
    `Pipeline step: ${input.step}.`,
    ...pipelineLine(input.pipelineSteps),
    '',
    taskContext(input),
    '',
    reposBlock(input.repoPaths, input.devServerPort, {
      prTargets: input.prTargets,
    }),
  ];

  const attachments = attachmentsBlock(input.attachmentPaths);
  if (attachments) lines.push('', attachments);

  const state = workingStateBlock(input.stateDigest);
  if (state) lines.push('', state);

  const working = workingFolderBlock(input.workingDir);
  if (working) lines.push('', working);

  const plan = input.step === PipelineStep.refine ? '' : refinedPlanBlock(input.refinedPlan);
  if (plan) lines.push('', plan);

  lines.push('', STEP_BODIES[input.step](input));

  const previousOutcome = previousOutcomeBlock(input.previousOutcome);
  if (previousOutcome) lines.push('', previousOutcome);

  lines.push('', outputContract(input.workingDir));
  return withSharedFragments(lines.join('\n'), VERIFIER_FRAGMENTS[input.step] ?? []);
}