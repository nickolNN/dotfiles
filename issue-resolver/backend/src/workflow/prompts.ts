import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAX_ROOM_EXECUTORS,
  type DesiredResult,
  type NormalizedStage,
  type PipelineStep,
  type RoomWorkItem,
} from '@issue-resolver/shared';

// ── Prompt file loader ──────────────────────────────────────────────

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'prompts');

/**
 * Reads a prompt `.md` file, strips the frontmatter `# Prompt: ...` header
 * line, and returns the body text. Cache is per-process lifetime (prompts
 * don't change at runtime).
 */
const _cache = new Map<string, string>();
function readPrompt(filename: string): string {
  const cached = _cache.get(filename);
  if (cached !== undefined) return cached;
  const raw = readFileSync(join(PROMPTS_DIR, filename), 'utf-8');
  // Strip the metadata header line (`# Prompt: ...`) and leading blank.
  const body = raw.replace(/^#\s+Prompt:.*\n\n?/, '');
  _cache.set(filename, body);
  return body;
}

/** Подставляет плейсхолдеры `{{NAME}}` (глобально) и чистит пустые строки. */
function render(template: string, values: Record<string, string>): string {
  let body = template;
  for (const [name, value] of Object.entries(values)) {
    body = body.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), value);
  }
  return body
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Types ───────────────────────────────────────────────────────────

/** Репозиторий глазами шага `pr`: путь рабочей копии, base-ветка, нужен ли MR. */
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
  /** Порт уже поднятого системой dev-сервера (null — сервер не поднимали). */
  devServerPort?: number | null;
  /** Цели публикации для шага `pr` (путь + base-ветка + create_mr). */
  prTargets?: PrTarget[];
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
  /** Порт уже поднятого системой dev-сервера (null — сервер не поднимали). */
  devServerPort?: number | null;
}

export interface WorkerSummary {
  /** 1-based номер воркера, как он подписан в его отчёте. */
  index: number;
  summary: string;
}

// ── Shared blocks (single source of truth for every prompt) ─────────

function outputContract(): string {
  return readPrompt('output-contract.md');
}

/** Вход задачи: один блок для всех step- и room-промптов. */
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

/**
 * Зависимости уже поставлены разовой подготовкой задачи — говорим это
 * исполнителям явно, иначе каждый агент заново гоняет `npm ci`.
 */
const DEPENDENCIES_PREPARED =
  'Dependencies are already installed by the task preparation — run an install\nonly if you changed a manifest.';

/** Рабочие копии репозиториев + живой dev-сервер (общий блок контекста). */
function reposBlock(
  repoPaths: string[],
  devServerPort?: number | null,
  options: { preparedNote?: boolean } = {},
): string {
  const lines: string[] = [];
  if (repoPaths.length === 0) {
    lines.push(
      'There are no repositories — write the results of your work as files',
      'directly into the task working folder.',
    );
  } else {
    lines.push(
      'Repositories (working paths):',
      ...repoPaths.map((path) => `- ${path}`),
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

/** Куда смотреть шагу `test`, когда система dev-сервер не поднимала. */
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

/** Цели публикации шага `pr`: что коммитит бэкенд и в какую ветку. */
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
    ? `Refined plan (from the refine step — follow it, do not re-plan from scratch):\n${plan}`
    : '';
}

function previousOutcomeBlock(outcome?: string | null): string {
  return outcome
    ? `Previous iteration outcome (build on it, do not redo from scratch):\n${outcome}`
    : '';
}

/** Артефакт задачи по `desired_result` (один текст на все промпты). */
function desiredResultBlock(desiredResult?: DesiredResult): string {
  if (desiredResult === 'html') {
    return [
      'Deliverable: a single self-contained `report.html` at the working-folder',
      'root (inline CSS/JS/images via data URIs) — a styled standalone page to',
      'share. In addition to `.issue-step-result.json`.',
    ].join('\n');
  }
  if (desiredResult === 'md') {
    return [
      'Deliverable: `report.md` at the working-folder root — a Markdown document:',
      'analysis/conclusions, or a reusable skill definition. Plain Markdown, no HTML wrapper.',
      'In addition to `.issue-step-result.json`.',
    ].join('\n');
  }
  return '';
}

// ── Pipeline awareness ──────────────────────────────────────────────

const PIPELINE_ORDER: readonly PipelineStep[] = ['refine', 'resolve', 'review', 'test', 'pr'];

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

/** Общая строка «где я в конвейере» — первая строка любого step-промпта. */
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

/** То же, что и для resolve, но в границах одной подзадачи воркера. */
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

// ── Step bodies (loaded from prompts/*.md) ──────────────────────────

type StepBodyBuilder = (input: StepPromptInput) => string;

const STEP_BODIES: Record<PipelineStep, StepBodyBuilder> = {
  refine: (input) =>
    render(readPrompt('step-refine.md'), {
      MAX_EXECUTORS: String(DEFAULT_MAX_ROOM_EXECUTORS),
      DOWNSTREAM_AWARENESS: refinePipelineAwareness(input.pipelineSteps).join('\n'),
    }),

  resolve: (input) =>
    render(readPrompt('step-resolve-single.md'), {
      REPO_GUIDANCE:
        input.repoPaths.length > 0
          ? `Work in the repository working paths above.\n${DEPENDENCIES_PREPARED}`
          : '',
      DESIRED_RESULT: desiredResultBlock(input.desiredResult),
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
    }),

  pr: (input) =>
    render(readPrompt('step-pr.md'), {
      PR_TARGETS: prTargetsBlock(input.prTargets),
    }),
};

// ── buildStepPrompt ─────────────────────────────────────────────────

export function buildStepPrompt(input: StepPromptInput): string {
  const lines: string[] = [
    `Pipeline step: ${input.step}.`,
    ...pipelineLine(input.pipelineSteps),
    '',
    taskContext(input),
    '',
    reposBlock(input.repoPaths, input.devServerPort),
  ];

  const attachments = attachmentsBlock(input.attachmentPaths);
  if (attachments) lines.push('', attachments);

  // План refine — вход для следующих шагов; самому refine он не нужен.
  const plan = input.step === 'refine' ? '' : refinedPlanBlock(input.refinedPlan);
  if (plan) lines.push('', plan);

  lines.push('', STEP_BODIES[input.step](input));

  const previousOutcome = previousOutcomeBlock(input.previousOutcome);
  if (previousOutcome) lines.push('', previousOutcome);

  lines.push('', outputContract());
  return lines.join('\n');
}

// ── Room / staged resolve prompts (loaded from prompts/*.md) ────────

/** Общий набор блоков для всех room/staged-промптов (у них нет preamble). */
function roomValues(
  input: RoomPromptInput,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    TASK_CONTEXT: taskContext(input),
    REPOS: reposBlock(input.repoPaths, input.devServerPort, { preparedNote: true }),
    REFINED_PLAN: refinedPlanBlock(input.refinedPlan),
    ATTACHMENTS: attachmentsBlock(input.attachmentPaths),
    PREVIOUS_OUTCOME: previousOutcomeBlock(input.previousOutcome),
    DESIRED_RESULT: desiredResultBlock(input.desiredResult),
    DOWNSTREAM_AWARENESS: resolveDownstreamAwareness(input.pipelineSteps).join('\n'),
    ...extra,
  };
}

/** Список итогов воркеров: номер, файл отчёта и саммари (карта для лида). */
function workerSummariesBlock(files: (index: number) => string, workers: WorkerSummary[]): string {
  if (workers.length === 0) return '';
  return workers
    .map((worker) => `- worker ${worker.index} → \`${files(worker.index)}\`: ${worker.summary}`)
    .join('\n');
}

export function buildRoomWorkerPrompt(
  input: RoomPromptInput,
  item: RoomWorkItem,
  total: number,
): string {
  const worker = item.index + 1;
  return render(
    readPrompt('resolve-room-worker.md'),
    roomValues(input, {
      WORKER_NUMBER: String(worker),
      TOTAL_WORKERS: String(total),
      WORKER_TASK: item.task,
      DOWNSTREAM_AWARENESS: workerDownstreamAwareness(input.pipelineSteps).join('\n'),
    }),
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
  return `${render(
    readPrompt('resolve-room-lead.md'),
    roomValues(input, {
      WORKER_SUMMARIES:
        summaries || 'No worker reports: perform the resolve task YOURSELF and produce the step result directly.',
    }),
  )}\n\n${outputContract()}`;
}

export function buildStageWorkerPrompt(
  input: RoomPromptInput,
  stage: NormalizedStage,
  item: RoomWorkItem,
  total: number,
): string {
  const worker = item.index + 1;
  return render(readPrompt('resolve-stages-worker.md'), {
    ...roomValues(input),
    STAGE_INDEX: String(stage.index),
    STAGE_NAME: stage.name,
    STAGE_TASK: stage.task,
    WORKER_INDEX: String(worker),
    TOTAL_WORKERS: String(total),
    WORKER_TASK: item.task,
    DOWNSTREAM_AWARENESS: workerDownstreamAwareness(input.pipelineSteps).join('\n'),
  });
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
  return render(readPrompt('resolve-stages-lead.md'), {
    ...roomValues(input),
    STAGE_INDEX: String(stage.index),
    STAGE_NAME: stage.name,
    STAGE_TASK: stage.task,
    WORKER_SUMMARIES:
      summaries ||
      'There are no worker agents for this stage: perform the stage task YOURSELF\nand produce the stage result directly.',
  });
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
  return `${render(
    readPrompt('resolve-stages-final.md'),
    roomValues(input, {
      STAGE_OUTCOMES:
        outcomes || 'No stage reports: perform the resolve task YOURSELF and produce the step result directly.',
    }),
  )}\n\n${outputContract()}`;
}
