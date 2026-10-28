import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAX_ROOM_EXECUTORS,
  type DesiredResult,
  type NormalizedStage,
  type PipelineStep,
  type RoomWorkItem,
} from '@issue-resolver/shared';
import type { RepoChangeDigest } from '../git/service';

// ── Prompt file loader ──────────────────────────────────────────────

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'prompts');

/**
 * Reads a prompt `.md` file, strips the frontmatter `# Prompt: ...` header
 * line, and returns the body text.
 *
 * Кеш инвалидируется по (mtime, size) файла. Это не косметика: каталог
 * `prompts/` лежит ВНЕ `src/`, поэтому `tsx watch` на правку промпта процесс
 * НЕ перезапускает — с кешем «на весь life процесса» сервер до бесконечности
 * отдавал бы промпт, прочитанный на старте, и любая проверка правки промпта
 * молча проверяла бы СТАРЫЙ текст.
 */
const _cache = new Map<string, { mtimeMs: number; size: number; body: string }>();
function readPrompt(filename: string): string {
  const path = join(PROMPTS_DIR, filename);
  const { mtimeMs, size } = statSync(path);
  const cached = _cache.get(filename);
  if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.body;
  }
  const raw = readFileSync(path, 'utf-8');
  // Strip the metadata header line (`# Prompt: ...`) and leading blank.
  const body = raw.replace(/^#\s+Prompt:.*\n\n?/, '');
  _cache.set(filename, { mtimeMs, size, body });
  return body;
}

/**
 * Форма описания MR живёт ОДИН раз — в оригинальном скилле `pr`
 * (`mattpocock/skills:skills/engineering/pr`, credits Dex Horthy / Humanlayer),
 * который запечён в образ и обновляется вместе с ним. Конвейерный шаг получает
 * его текст целиком: второй версии структуры больше нигде нет (наш форк
 * `agent-skills/pr` удалён — две правки одного контракта расходятся молча).
 *
 * `~/.agents/skills` — то место, куда образ и запуск контейнера кладут скиллы.
 * Если файла нет, инъекция пустая: `step-pr.md` держит названия секций в
 * тексте, поэтому шаг остаётся рабочим, а пропажу ловит pr-skill.test.ts.
 */
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
  /** Число параллельных исполнителей для refine-промпта (0/undefined → 1). */
  workerCount?: number;
  /**
   * Снимок рабочей копии перед шагом (`git status` + `git diff --stat` по каждому
   * репозиторию). Движок measure'ит его сам, чтобы агент не тратил ходы на
   * `git status`/`git diff` ради первоначальной ориентации.
   */
  stateDigest?: RepoChangeDigest[];
  /** Число завершённых итераций для report-агента. */
  iterationCount?: number;
  /** Путь к каталогу narratives для report-агента (видный агенту). */
  iterationNarrativesDir?: string;
  /** Working folder as the agent sees it (session cwd); stated in the prompt. */
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
  /** Порт уже поднятого системой dev-сервера (null — сервер не поднимали). */
  devServerPort?: number | null;
  /**
   * Цели публикации шага `pr` (путь + base-ветка + create_mr). Нужны не только
   * `pr`: refine/resolve/room тоже должны видеть, в каких репозиториях запрошен
   * MR, иначе планировщик спрашивает пользователя то, что уже есть в задаче.
   */
  prTargets?: PrTarget[];
  /** Снимок рабочей копии перед шагом (см. `StepPromptInput.stateDigest`). */
  stateDigest?: RepoChangeDigest[];
  /** Working folder as the agent sees it (session cwd); stated in the prompt. */
  workingDir?: string;
}

export interface WorkerSummary {
  /** 1-based номер исполнителя, как он подписан в его отчёте. */
  index: number;
  summary: string;
}

// ── Shared blocks (single source of truth for every prompt) ─────────

function outputContract(workingDir?: string): string {
  const contract = readPrompt('output-contract.md');
  if (!workingDir) return contract;
  return [
    `Output contract — write exactly \`${join(workingDir, '.issue-step-result.json')}\` (absolute path).`,
    'A copy inside a repository working copy is ignored by the engine.',
    '',
    contract,
  ].join('\n');
}

/** The agent's cwd: the parent of the clones, never a clone itself. */
function workingFolderBlock(workingDir?: string): string {
  if (!workingDir) return '';
  return [
    `Working folder (your session's cwd): ${workingDir}`,
    'It is the parent of the repository working copies above — not a clone.',
    'Step artifacts (report files, screenshots/, narratives) belong here, never',
    'inside a clone: whatever the clone contains is what the merge request ships.',
  ].join('\n');
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
  options: { preparedNote?: boolean; prTargets?: PrTarget[] } = {},
): string {
  const lines: string[] = [];
  if (repoPaths.length === 0) {
    lines.push(
      'There are no repositories — write the results of your work as files',
      'directly into the task working folder.',
    );
  } else {
    // create_mr — часть входа задачи (чекбоксы pr-секции), а не вывод pr-шага:
    // показываем флаг каждому шагу, иначе refine спрашивает его у пользователя.
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

/**
 * Состояние рабочей копии, которое движок уже померил сам. Без него каждый
 * агент открывает шаг `git status` + `git diff --stat` во всех репозиториях,
 * чтобы понять, что делал предыдущий шаг: в staged-резолве на 9 агентов это
 * десятки одинаковых вызовов на ровном месте.
 */
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
    ? `Refined plan (from the refine step — follow it, do not re-plan from scratch):\n${plan}`
    : '';
}

function previousOutcomeBlock(outcome?: string | null): string {
  return outcome
    ? `Previous iteration outcome (build on it, do not redo from scratch):\n${outcome}`
    : '';
}

/** Блок narrative-файлов итераций для report-агента. */
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

// ── Pipeline awareness ──────────────────────────────────────────────

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

/** То же, что и для resolve, но в границах одной подзадачи исполнителя. */
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

// ── Step bodies (loaded from prompts/*.md) ──────────────────────

// ── Step bodies (loaded from prompts/*.md) ──────────────────────────

type StepBodyBuilder = (input: StepPromptInput) => string;

const STEP_BODIES: Record<PipelineStep, StepBodyBuilder> = {
  refine: (input) =>
    render(readPrompt('step-refine.md'), {
      MAX_EXECUTORS: String(DEFAULT_MAX_ROOM_EXECUTORS),
      WORKER_COUNT: String(input.workerCount ?? 1),
      DOWNSTREAM_AWARENESS: refinePipelineAwareness(input.pipelineSteps).join('\n'),
    }),

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
};

// ── buildStepPrompt ─────────────────────────────────────────────────

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

  // План refine — вход для следующих шагов; самому refine он не нужен.
  const plan = input.step === 'refine' ? '' : refinedPlanBlock(input.refinedPlan);
  if (plan) lines.push('', plan);

  lines.push('', STEP_BODIES[input.step](input));

  const previousOutcome = previousOutcomeBlock(input.previousOutcome);
  if (previousOutcome) lines.push('', previousOutcome);

  lines.push('', outputContract(input.workingDir));
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

/** Список итогов исполнителей: номер, файл отчёта и саммари (карта для лида). */
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
  )}\n\n${outputContract(input.workingDir)}`;
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

/**
 * Промпт единственного исполнителя одиночного этапа (`executors: 1`): у этапа нет
 * ни других исполнителей, ни координатора, поэтому он и делает работу, и пишет
 * файл этапа. Промпт координатора (`resolve-stages-lead.md`) врал бы про
 * интеграцию несуществующих исполнителей.
 */
export function buildStageSoloPrompt(
  input: RoomPromptInput,
  stage: NormalizedStage,
): string {
  return render(readPrompt('resolve-stages-solo.md'), {
    ...roomValues(input),
    STAGE_INDEX: String(stage.index),
    STAGE_NAME: stage.name,
    STAGE_TASK: stage.task,
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
  )}\n\n${outputContract(input.workingDir)}`;
}
