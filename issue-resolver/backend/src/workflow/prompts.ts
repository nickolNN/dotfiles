import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  maxExecutorsFor,
  MAX_PIPELINE_ATTEMPTS,
  REFINED_PLAN_CHAR_LIMIT,
  type DesiredResult,
  type NormalizedStage,
  type PipelineStep,
  type RoomWorkItem,
} from '@issue-resolver/shared';
import type { RepoChangeDigest } from '../git/service';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'prompts');

const _cache = new Map<string, { mtimeMs: number; size: number; body: string }>();
function readPrompt(filename: string): string {
  const path = join(PROMPTS_DIR, filename);
  const { mtimeMs, size } = statSync(path);
  const cached = _cache.get(filename);
  if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.body;
  }
  const raw = readFileSync(path, 'utf-8');
  const body = raw.replace(/^#\s+Prompt:.*\n\n?/, '');
  _cache.set(filename, { mtimeMs, size, body });
  return body;
}

const PR_SKILL_PATHS = [join(homedir(), '.agents', 'skills', 'pr', 'SKILL.md')];

function prSkillBlock(): string {
  for (const path of PR_SKILL_PATHS) {
    if (!existsSync(path)) continue;
    return readFileSync(path, 'utf-8')
      .replace(/^---\n[\s\S]*?\n---\n?/, '')
      .trim();
  }
  return '';
}

function render(template: string, values: Record<string, string>): string {
  let body = template;
  for (const [name, value] of Object.entries(values)) {
    body = body.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), value);
  }
  return body
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PrTarget {
  path: string;
  baseBranch: string;
  createMr: boolean;
}

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
  prTargets?: PrTarget[];
  workerCount?: number;
  stateDigest?: RepoChangeDigest[];
  iterationCount?: number;
  iterationNarrativesDir?: string;
  workingDir?: string;
}

export interface RoomPromptInput {
  issueTitle: string;
  description: string;
  jiraText: string | null;
  context: string;
  feedback: string | null;
  refinedPlan: string | null;
  repoPaths: string[];
  desiredResult?: DesiredResult;
  previousOutcome?: string | null;
  attachmentPaths?: string[];
  pipelineSteps?: PipelineStep[];
  devServerPort?: number | null;
  prTargets?: PrTarget[];
  stateDigest?: RepoChangeDigest[];
  workingDir?: string;
}

export interface WorkerSummary {
  index: number;
  summary: string;
}

function outputContract(workingDir?: string): string {
  const contract = readPrompt('output-contract.md');
  if (!workingDir) return contract;
  return [
    `Output contract — write exactly \`${join(workingDir, '.issue-step-result.json')}\` (absolute path).`,
    '',
    contract,
  ].join('\n');
}

function workingFolderBlock(workingDir?: string): string {
  if (!workingDir) return '';
  return [
    `Working folder (your session's cwd): ${workingDir}`,
    'It is the parent of the repository working copies above — not a clone.',
    'Step artifacts (report files, screenshots/, narratives) belong here, never',
    'inside a clone: whatever the clone contains is what the merge request ships.',
  ].join('\n');
}

function taskContext(input: {
  issueTitle: string;
  description: string;
  jiraText: string | null;
  context: string;
  feedback: string | null;
}): string {
  const lines = [
    `Task: ${input.issueTitle}`,
    `Issue description: ${input.description}`,
  ];
  if (input.jiraText) {
    lines.push(`Jira text: ${input.jiraText}`);
  }
  lines.push('Iteration context:', input.context);
  if (input.feedback !== null) {
    lines.push('', `Previous step feedback (fix exactly this): ${input.feedback}`);
  }
  return lines.join('\n');
}

const DEPENDENCIES_PREPARED =
  'Dependencies are already installed by the task preparation — run an install\nonly if you changed a manifest.';

function reposBlock(
  repoPaths: string[],
  devServerPort?: number | null,
  options: { preparedNote?: boolean; prTargets?: PrTarget[] } = {},
): string {
  const lines: string[] = [];
  if (repoPaths.length === 0) {
    lines.push(
      'There are no repositories — write the results of your work as files',
      'directly into the task working folder.',
    );
  } else {
    const createMrByPath = new Map(
      (options.prTargets ?? []).map((target) => [target.path, target.createMr]),
    );
    lines.push(
      'Repositories (working paths):',
      ...repoPaths.map((path) => {
        const createMr = createMrByPath.get(path);
        if (createMr === undefined) return `- ${path}`;
        return `- ${path} — create MR: ${createMr ? 'yes' : 'no'}`;
      }),
    );
    if (options.preparedNote) {
      lines.push('', DEPENDENCIES_PREPARED);
    }
  }
  if (devServerPort !== undefined && devServerPort !== null) {
    lines.push(
      '',
      `Dev server: the app is already running at http://localhost:${devServerPort}`,
      '(started by the system; `<repo>/DEV_SERVER.sh` restarts it if it died).',
    );
  }
  return lines.join('\n');
}

function devServerBlock(devServerPort?: number | null): string {
  if (devServerPort === undefined || devServerPort === null) {
    return [
      'No dev server is running for this task. Start the app yourself from the',
      'repository working path above (`DEV_SERVER.sh`, or the `## Run` command in',
      '`RUN_INSTRUCTIONS.md`), and stop it when the verification is done.',
    ].join('\n');
  }
  return [
    `The app is already running at http://localhost:${devServerPort} — the system`,
    'started it from the repository `DEV_SERVER.sh`. Verify against this URL;',
    'restart the script only if the server is dead.',
  ].join('\n');
}

function attemptLimitBlock(): string {
  return [
    'A `fail` sends the pipeline back to development with your findings. The',
    `iteration gets ${MAX_PIPELINE_ATTEMPTS} development attempts in total; when`,
    'they are used up the run stops and asks the human (`needs_input`) instead of',
    'starting another cycle. Report the honest verdict even on the last attempt —',
    'exhausting the budget is the system\'s problem, not a reason to soften it.',
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

function workingStateBlock(digests?: RepoChangeDigest[]): string {
  const useful = (digests ?? []).filter(
    (digest) => digest.changedFiles.length > 0 || digest.diffSummary !== '',
  );
  if (useful.length === 0) return '';
  const lines: string[] = [
    'Working copy right now (measured for you — do NOT re-run `git status` or',
    '`git diff --stat` just to find your bearings; open the files themselves):',
  ];
  for (const digest of useful) {
    const total = digest.changedFiles.length + digest.omittedFiles;
    const head = digest.changedFiles.length
      ? `- ${digest.repoPath} — ${total} touched file(s)`
      : `- ${digest.repoPath} — no loose files, changes staged or committed`;
    lines.push(
      digest.diffSummary ? `${head} (${digest.diffSummary})` : head,
    );
    for (const file of digest.changedFiles) {
      lines.push(`    ${file}`);
    }
    if (digest.omittedFiles > 0) {
      lines.push(
        `    … ${digest.omittedFiles} more — run \`git status\` for the full list`,
      );
    }
  }
  return lines.join('\n');
}

function attachmentsBlock(paths?: string[]): string {
  const attachments = paths ?? [];
  if (attachments.length === 0) return '';
  return [
    'Uploaded files (already in the working folder):',
    ...attachments.map((path) => `- ${path}`),
    'Read them before solving.',
  ].join('\n');
}

function refinedPlanBlock(plan?: string | null): string {
  return plan
    ? `Task brief (from the refine step — the size, the split, and the decisions behind them; follow it, do not re-plan from scratch):\n${plan}`
    : '';
}

function previousOutcomeBlock(outcome?: string | null): string {
  return outcome
    ? `Previous iteration outcome (build on it, do not redo from scratch):\n${outcome}`
    : '';
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

const PIPELINE_ORDER: readonly PipelineStep[] = ['refine', 'resolve', 'review', 'test', 'pr', 'report'];

const VERIFICATION_STEPS: ReadonlyArray<{ step: PipelineStep; label: string; description: string }> = [
  { step: 'review', label: 'Review', description: 'independent code review (source code only).' },
  { step: 'test', label: 'Test', description: 'runtime/browser verification (Playwright).' },
];

function downstreamVerification(pipelineSteps: PipelineStep[] | undefined, step: PipelineStep): { step: PipelineStep; label: string; description: string }[] {
  if (!pipelineSteps || pipelineSteps.length === 0) return [];
  const from = PIPELINE_ORDER.indexOf(step);
  return VERIFICATION_STEPS.filter(
    (gate) => PIPELINE_ORDER.indexOf(gate.step) > from && pipelineSteps.includes(gate.step),
  );
}

function pipelineLine(pipelineSteps: PipelineStep[] | undefined): string[] {
  if (!pipelineSteps || pipelineSteps.length === 0) return [];
  return [`Enabled pipeline for this run: ${pipelineSteps.join(' → ')}.`];
}

function refinePipelineAwareness(pipelineSteps?: PipelineStep[]): string[] {
  if (!pipelineSteps || pipelineSteps.length === 0) return [];
  const gates = downstreamVerification(pipelineSteps, 'refine');
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

function resolveDownstreamAwareness(pipelineSteps?: PipelineStep[]): string[] {
  const gates = downstreamVerification(pipelineSteps, 'resolve');
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

function workerDownstreamAwareness(pipelineSteps?: PipelineStep[]): string[] {
  const gates = downstreamVerification(pipelineSteps, 'resolve');
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

type StepBodyBuilder = (input: StepPromptInput) => string;

function parallelismBlock(cap: number): string {
  return cap <= 1
    ? [
        'Parallel executors: 1 — only one agent runs at a time, so `room` is out of reach.',
        'Volume still splits: order the work into `stages` with one executor per stage',
        '(2+ stages) instead of handing a single agent a change that outgrows its working set.',
      ].join('\n')
    : [
        `Parallel executors: at most ${cap} at a time — the engine clamps a higher number down.`,
        'When the work needs more hands than that, add a stage rather than oversubscribing one.',
      ].join('\n');
}

function grouped(value: number): string {
  return value.toLocaleString('en-US').replace(/,/g, ' ');
}

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
    }),

  test: (input) =>
    render(readPrompt('step-test.md'), {
      DEV_SERVER: devServerBlock(input.devServerPort),
      ATTEMPT_LIMIT: attemptLimitBlock(),
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

  const plan = input.step === 'refine' ? '' : refinedPlanBlock(input.refinedPlan);
  if (plan) lines.push('', plan);

  lines.push('', STEP_BODIES[input.step](input));

  const previousOutcome = previousOutcomeBlock(input.previousOutcome);
  if (previousOutcome) lines.push('', previousOutcome);

  lines.push('', outputContract(input.workingDir));
  return withSharedFragments(lines.join('\n'));
}

function roomValues(
  input: RoomPromptInput,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    TASK_CONTEXT: taskContext(input),
    REPOS: [
      reposBlock(input.repoPaths, input.devServerPort, {
        preparedNote: true,
        prTargets: input.prTargets,
      }),
      workingFolderBlock(input.workingDir),
    ]
      .filter((block) => block.length > 0)
      .join('\n\n'),
    REFINED_PLAN: refinedPlanBlock(input.refinedPlan),
    ATTACHMENTS: attachmentsBlock(input.attachmentPaths),
    WORKING_STATE: workingStateBlock(input.stateDigest),
    PREVIOUS_OUTCOME: previousOutcomeBlock(input.previousOutcome),
    DOWNSTREAM_AWARENESS: resolveDownstreamAwareness(input.pipelineSteps).join('\n'),
    ...extra,
  };
}

function workerSummariesBlock(files: (index: number) => string, workers: WorkerSummary[]): string {
  if (workers.length === 0) return '';
  return workers
    .map((worker) => `- worker ${worker.index} → \`${files(worker.index)}\`: ${worker.summary}`)
    .join('\n');
}

const SHARED_FRAGMENTS = ['capabilities.md', 'memory-rules.md'];

function withSharedFragments(prompt: string): string {
  return [
    prompt,
    ...SHARED_FRAGMENTS.map((name) => readPrompt(name).trim()),
  ].join('\n\n');
}

export const STEP_SYSTEM_APPEND = [
  'The deliverable of this run is `.issue-step-result.json` in the working folder.',
  'A summary in chat is not a deliverable: do not substitute prose for that file,',
  'and do not paste the plan, the report, or the diff into chat instead of writing it.',
].join(' ');

export function buildRoomWorkerPrompt(
  input: RoomPromptInput,
  item: RoomWorkItem,
  total: number,
): string {
  const worker = item.index + 1;
  return withSharedFragments(
    render(
      readPrompt('resolve-room-worker.md'),
      roomValues(input, {
        WORKER_NUMBER: String(worker),
        TOTAL_WORKERS: String(total),
        WORKER_TASK: item.task,
        DOWNSTREAM_AWARENESS: workerDownstreamAwareness(input.pipelineSteps).join('\n'),
      }),
    ),
  );
}

export function buildRoomCoordinatorPrompt(
  input: RoomPromptInput,
  workers: WorkerSummary[],
): string {
  const summaries = workerSummariesBlock(
    (index) => `.issue-worker-result-${index}.json`,
    workers,
  );
  return withSharedFragments(
    `${render(
      readPrompt('resolve-room-lead.md'),
      roomValues(input, {
        WORKER_SUMMARIES:
          summaries ||
          'No worker reports: perform the resolve task YOURSELF and produce the step result directly.',
      }),
    )}\n\n${outputContract(input.workingDir)}`,
  );
}

export function buildStageWorkerPrompt(
  input: RoomPromptInput,
  stage: NormalizedStage,
  item: RoomWorkItem,
  total: number,
): string {
  const worker = item.index + 1;
  return withSharedFragments(
    render(readPrompt('resolve-stages-worker.md'), {
      ...roomValues(input),
      STAGE_INDEX: String(stage.index),
      STAGE_NAME: stage.name,
      STAGE_TASK: stage.task,
      WORKER_INDEX: String(worker),
      TOTAL_WORKERS: String(total),
      WORKER_TASK: item.task,
      DOWNSTREAM_AWARENESS: workerDownstreamAwareness(input.pipelineSteps).join('\n'),
    }),
  );
}

export function buildStageCoordinatorPrompt(
  input: RoomPromptInput,
  stage: NormalizedStage,
  workers: WorkerSummary[],
): string {
  const summaries = workerSummariesBlock(
    (index) => `.issue-stage-${stage.index}-worker-${index}.json`,
    workers,
  );
  return withSharedFragments(
    render(readPrompt('resolve-stages-lead.md'), {
      ...roomValues(input),
      STAGE_INDEX: String(stage.index),
      STAGE_NAME: stage.name,
      STAGE_TASK: stage.task,
      WORKER_SUMMARIES:
        summaries ||
        'There are no worker agents for this stage: perform the stage task YOURSELF\nand produce the stage result directly.',
    }),
  );
}

export function buildStageSoloPrompt(
  input: RoomPromptInput,
  stage: NormalizedStage,
): string {
  return withSharedFragments(
    render(readPrompt('resolve-stages-solo.md'), {
      ...roomValues(input),
      STAGE_INDEX: String(stage.index),
      STAGE_NAME: stage.name,
      STAGE_TASK: stage.task,
    }),
  );
}

export function buildStagedFinalCoordinatorPrompt(
  input: RoomPromptInput,
  stages: { stage: NormalizedStage; outcome: string }[],
): string {
  const outcomes = stages
    .map(
      ({ stage, outcome }) =>
        `- stage ${stage.index} (${stage.name}) → \`.issue-stage-${stage.index}.json\`: ${outcome}`,
    )
    .join('\n');
  return withSharedFragments(
    `${render(
      readPrompt('resolve-stages-final.md'),
      roomValues(input, {
        STAGE_OUTCOMES:
          outcomes ||
          'No stage reports: perform the resolve task YOURSELF and produce the step result directly.',
      }),
    )}\n\n${outputContract(input.workingDir)}`,
  );
}
