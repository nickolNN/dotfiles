import type {
  DesiredResult,
  NormalizedStage,
  PipelineStep,
  RoomWorkItem,
} from '@issue-resolver/shared';

export interface StepPromptInput {
  step: PipelineStep;
  issueTitle: string;
  /** Issue description (additional_context). */
  description: string;
  /** Jira issue text (or null if absent/unavailable). */
  jiraText: string | null;
  /** Контекст для шага review (review_context итерации; пусто/undefined — секция не выводится). */
  reviewContext?: string | null;
  context: string;
  feedback: string | null;
  repoPaths: string[];
  /** План из refine-шага (summary отчёта); передаётся в resolve. */
  refinedPlan?: string | null;
  /** Желаемый результат задачи: 'md' (report.md), 'html' (report.html) или 'pr'. */
  desiredResult?: DesiredResult;
  /**
   * Пути загруженных файлов (относительно корня рабочей папки = cwd агента),
   * уже лежащих в рабочей папке. Пусто/undefined — секция не выводится.
   */
  attachmentPaths?: string[];
  /**
   * Итог предыдущей итерации (отчёт resolve + документ результата): агент
   * должен продолжать с него, а не решать задачу заново. Для итерации №1
   * отсутствует.
   */
  previousOutcome?: string | null;
}

/** Общий контекст комнаты resolve (coordinator + workers). */
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
}

/** Сводка подзадачи работника для интеграции координатором. */
export interface WorkerSummary {
  index: number;
  summary: string;
}

/** Required step output contract (ISSUE_RESOLVER_PLAN.md §13.6). */
function outputContract(): string {
  return [
    'Output contract:',
    'When the step is complete, you must write the file `.issue-step-result.json` to the root of the working copy.',
    'Format (ISSUE_RESOLVER_PLAN.md §13.6):',
    '{ "status": "pass|fail|blocked", "summary": "...", "scenarios": [ ... ], "findings": [ ... ] }',
    'Without this file the step is considered incomplete.',
  ].join('\n');
}

type StepBodyBuilder = (input: StepPromptInput) => string;

const STEP_BODIES: Record<PipelineStep, StepBodyBuilder> = {
  refine: () =>
    [
      'Role: refiner.',
      'You have the full context of the task (title, description, Jira text, repositories, iteration context).',
      'If anything about the task is ambiguous or under-specified, ask the user via the `question` TOOL',
      '(call the tool `question` with args `{ question, options: [ {label, description?}, ... ] }`).',
      'One call per question; each call BLOCKS until the user answers — it forwards the question to the',
      'user and returns the answer to you.',
      'Give 2-5 concrete `options` per question so the user answers fast. If the task is already fully',
      'clear, SKIP questions and go straight to the plan.',
      'Order: (questions → answers) → plan. Then, based on the answers received, build an implementation plan.',
      'Step outcome: refined context and a plan for the following steps.',
      'Also write the implementation plan as human-readable Markdown to `plan.md` at the',
      'root of the working folder (in addition to `.issue-step-result.json`).',
      'Execution topology: recommend how the resolve step should execute by adding an',
      '"execution" object to .issue-step-result.json:',
      '{ "mode": "single" | "room" | "stages", "executors": <N>, "decomposition": ["sub-task", ...], "stages": [ ... ], "rationale": "..." }.',
      '- "single": the implementation is simple enough for ONE agent to do alone.',
      '- "room": needs a coordinator (lead) plus N worker agents (2 <= N <= 4). Provide',
      '  a decomposition with exactly one sub-task per worker.',
      '- "stages": a sequential plan of 2+ ordered stages executed one after another.',
      '  Each stage runs either a single agent or 1..4 parallel workers, and after all',
      '  stages a final coordinator integrates every stage outcome:',
      '  { "mode": "stages", "stages": [ { "index": 1, "name": "...", "task": "...",',
      '    "executors": N, "decomposition": ["...", ...] }, ... ], "rationale": "..." }',
      '  (indexes are 1..N in execution order; for executors > 1 provide one',
      '  decomposition entry per worker, otherwise a single agent runs the stage).',
      'Only the coordinator (lead) ever makes the final pass/fail decision for the step.',
    ].join('\n'),

  resolve: (input) => {
    const repoGuidance =
      input.repoPaths.length > 0
        ? [
            'Study the contents of the repositories and install dependencies',
            '(npm/pnpm/yarn/bun — based on the manifest found) before solving.',
          ]
        : [
            'There are no repositories — write the results of your research/analysis',
            'as files directly into the task working folder.',
          ];
    return [
      'Role: implementer.',
      `Task: ${input.issueTitle}`,
      `Issue description: ${input.description}`,
      ...(input.jiraText ? [`Jira text: ${input.jiraText}`] : []),
      'Repositories (working paths):',
      ...input.repoPaths.map((path) => `- ${path}`),
      ...repoGuidance,
      ...(input.desiredResult === 'html'
        ? [
            'Write the deliverable as a single self-contained `report.html` at the',
            'working-folder root (inline CSS/JS/images via data URIs) — a styled',
            'standalone page to share. In addition to `.issue-step-result.json`.',
          ]
        : []),
      ...(input.desiredResult === 'md'
        ? [
            'Write the deliverable as `report.md` at the working-folder root — a',
            'Markdown document: analysis/conclusions, or a reusable skill definition.',
            'Plain Markdown, no HTML wrapper. In addition to `.issue-step-result.json`.',
          ]
        : []),
      'HARD-RULES: running build, test, commit, or push is forbidden —',
      'you are only allowed to edit code. Verification and publishing are done by other steps.',
    ].join('\n');
  },

  review: (input) =>
    [
      'Role: independent reviewer, do NOT continue the implementation.',
      ...(input.reviewContext
        ? [
            'Reviewer context (focus points, regression risks, or acceptance',
            'criteria from the task owner):',
            input.reviewContext,
          ]
        : []),
      'You are allowed to run build, tests, and the browser (Playwright / agent-browser).',
      'Verify the real behavior of the application, not just reading code.',
      'Format the result in `.issue-step-result.json`:',
      '{ status: pass|fail|blocked, summary, scenarios[], findings[] }.',
    ].join('\n'),

  test: () =>
    [
      'Role: tester.',
      'Run the target application in the browser (Playwright).',
      'Record the verified scenarios and the defects found.',
      'Format the result in `.issue-step-result.json`.',
    ].join('\n'),

  pr: () =>
    [
      'Role: PR.',
      'Use the pr skill to assemble the changes into a meaningful PR.',
      'Return { title, description, summary }.',
      'Do NOT push and do NOT create an MR — the backend does that.',
    ].join('\n'),
};

/**
 * Pure deterministic step prompt builder: the same input always yields
 * the same string (no timestamps/random).
 */
export function buildStepPrompt(input: StepPromptInput): string {
  const lines: string[] = [
    `Pipeline step: ${input.step}.`,
    `Task: ${input.issueTitle}`,
    `Issue description: ${input.description}`,
    ...(input.jiraText ? [`Jira text: ${input.jiraText}`] : []),
    'Iteration context:',
    input.context,
  ];

  const attachments = input.attachmentPaths ?? [];
  if (attachments.length > 0) {
    lines.push(
      '',
      'Uploaded files (already in the working folder):',
      ...attachments.map((path) => `- ${path}`),
      'Read them before solving.',
    );
  }

  if (input.refinedPlan) {
    lines.push(
      '',
      'Refined plan (from the refine step — follow it, do not re-plan from scratch):',
      input.refinedPlan,
    );
  }

  lines.push('', STEP_BODIES[input.step](input));

  if (input.previousOutcome) {
    lines.push(
      '',
      'Previous iteration outcome (build on it, do not redo from scratch):',
      input.previousOutcome,
    );
  }

  if (input.feedback !== null) {
    lines.push('', `Previous step feedback: ${input.feedback}`);
  }

  lines.push('', outputContract());
  return lines.join('\n');
}

/** Промпт работника комнаты resolve: решает только свою подзадачу, не финальное решение. */
export function buildRoomWorkerPrompt(
  input: RoomPromptInput,
  item: RoomWorkItem,
  total: number,
): string {
  const lines: string[] = [
    'Role: worker agent (executor) in a coordinated agent room. You are a peer, NOT the lead.',
    'The coordinator (lead) alone makes the final pass/fail decision for this step — never you.',
    `Sub-task ${item.index + 1} of ${total}: ${item.task}`,
    `Task: ${input.issueTitle}`,
    `Issue description: ${input.description}`,
    ...(input.jiraText ? [`Jira text: ${input.jiraText}`] : []),
    'Iteration context:',
    input.context,
  ];

  if (input.refinedPlan) {
    lines.push('', 'Refined plan (follow it):', input.refinedPlan);
  }

  const attachments = input.attachmentPaths ?? [];
  if (attachments.length > 0) {
    lines.push(
      '',
      'Uploaded files (already in the working folder):',
      ...attachments.map((path) => `- ${path}`),
    );
  }

  if (input.repoPaths.length > 0) {
    lines.push(
      '',
      'Repositories (working paths):',
      ...input.repoPaths.map((path) => `- ${path}`),
    );
  } else {
    lines.push(
      '',
      'There are no repositories — write your work files into the task working folder.',
    );
  }

  if (input.feedback !== null) {
    lines.push('', `Previous step feedback: ${input.feedback}`);
  }

  lines.push(
    '',
    'Instructions:',
    '- Solve ONLY your sub-task above. Do not touch files outside its scope.',
    '- You are allowed to edit code and write files. Build/test/commit/push are FORBIDDEN.',
    '- Report your OWN sub-task outcome (not the whole step) by writing the file',
    `  .issue-worker-result-${item.index}.json at the working-folder root:`,
    '  { "status": "pass|fail|blocked", "summary": "..." }.',
    '- The coordinator will integrate all sub-tasks and make the final decision.',
    'Output contract:',
    `.issue-worker-result-${item.index}.json is required; without it your sub-task is incomplete.`,
  );
  return lines.join('\n');
}

/**
 * Промпт координатора (старшего) комнаты resolve: интегрирует подзадачи и
 * ОДИН принимает финальное решение pass/fail/blocked шага.
 */
export function buildRoomCoordinatorPrompt(
  input: RoomPromptInput,
  workers: WorkerSummary[],
): string {
  const lines: string[] = [
    'Role: coordinator (LEAD) of this agent room. You are the senior who takes the FINAL',
    'decision whether the resolve step passed. You integrate the workers below.',
    `Task: ${input.issueTitle}`,
    `Issue description: ${input.description}`,
    ...(input.jiraText ? [`Jira text: ${input.jiraText}`] : []),
    'Iteration context:',
    input.context,
  ];

  if (input.refinedPlan) {
    lines.push('', 'Refined plan (follow it):', input.refinedPlan);
  }

  if (input.repoPaths.length > 0) {
    lines.push(
      '',
      'Repositories (working paths):',
      ...input.repoPaths.map((path) => `- ${path}`),
    );
  } else {
    lines.push(
      '',
      'There are no repositories — the deliverables are files in the task working folder.',
    );
  }

  if (input.feedback !== null) {
    lines.push('', `Previous step feedback: ${input.feedback}`);
  }

  if (input.desiredResult === 'html') {
    lines.push(
      '',
      'Write the deliverable as a single self-contained `report.html` at the',
      'working-folder root (inline CSS/JS/images via data URIs) — a styled',
      'standalone page to share. In addition to `.issue-step-result.json`.',
    );
  } else if (input.desiredResult === 'md') {
    lines.push(
      '',
      'Write the deliverable as `report.md` at the working-folder root — a',
      'Markdown document. Plain Markdown, no HTML wrapper. In addition to `.issue-step-result.json`.',
    );
  }

  lines.push(
    '',
    'Worker sub-task reports (read the full files .issue-worker-result-<index>.json in the working folder):',
    ...workers.map((worker) => `  worker ${worker.index}: ${worker.summary}`),
    '',
    'Instructions:',
    "- Integrate the workers' changes, resolve conflicts between them, and finish the implementation.",
    '- You are the ONLY one allowed to conclude the step. Workers do not decide pass/fail.',
    '- Decide pass/fail/blocked based on the integrated result, and write the FINAL',
    '  .issue-step-result.json at the working-folder root:',
    '  { "status": "pass|fail|blocked", "summary": "...", "scenarios": [ ... ], "findings": [ ... ] }.',
    '- Do NOT push and do NOT create an MR — the backend publishes.',
    'Output contract:',
    '`.issue-step-result.json` is the single source of truth for this step result.',
  );
  return lines.join('\n');
}

/**
 * Промпт воркера этапа staged-режима: решает свою подзадачу этапа параллельно
 * другим воркерам; пишет `.issue-stage-<index>-worker-<w>.json`, но НЕ финальное
 * решение (ни этапа, ни шага).
 */
export function buildStageWorkerPrompt(
  input: RoomPromptInput,
  stage: NormalizedStage,
  item: RoomWorkItem,
  total: number,
): string {
  const worker = item.index + 1;
  const lines: string[] = [
    `Role: worker agent (executor) of stage ${stage.index} ("${stage.name}") in a staged agent room. You are a peer, NOT the lead.`,
    'The stage coordinator and the final lead alone make pass/fail decisions — never you.',
    `Stage ${stage.index} task: ${stage.task}`,
    `Sub-task ${worker} of ${total}: ${item.task}`,
    `Task: ${input.issueTitle}`,
    `Issue description: ${input.description}`,
    ...(input.jiraText ? [`Jira text: ${input.jiraText}`] : []),
    'Iteration context:',
    input.context,
  ];

  if (input.refinedPlan) {
    lines.push('', 'Refined plan (follow it):', input.refinedPlan);
  }

  const attachments = input.attachmentPaths ?? [];
  if (attachments.length > 0) {
    lines.push(
      '',
      'Uploaded files (already in the working folder):',
      ...attachments.map((path) => `- ${path}`),
    );
  }

  if (input.repoPaths.length > 0) {
    lines.push(
      '',
      'Repositories (working paths):',
      ...input.repoPaths.map((path) => `- ${path}`),
    );
  } else {
    lines.push(
      '',
      'There are no repositories — write your work files into the task working folder.',
    );
  }

  if (input.feedback !== null) {
    lines.push('', `Previous step feedback: ${input.feedback}`);
  }

  lines.push(
    '',
    'Instructions:',
    `- Solve ONLY sub-task ${worker} of stage ${stage.index}. Do not touch files outside its scope.`,
    '- You are allowed to edit code and write files. Build/test/commit/push are FORBIDDEN.',
    '- Report your OWN sub-task outcome (not the stage, not the step) by writing the file',
    `  .issue-stage-${stage.index}-worker-${worker}.json at the working-folder root:`,
    '  { "status": "pass|fail|blocked", "summary": "..." }.',
    '- The stage coordinator integrates the workers; the final lead decides the step.',
    'Output contract:',
    `.issue-stage-${stage.index}-worker-${worker}.json is required; without it your sub-task is incomplete.`,
  );
  return lines.join('\n');
}

/**
 * Промпт координатора этапа staged-режима: интегрирует воркеров СВОЕГО этапа и
 * пишет `.issue-stage-<index>.json`; финальное решение шага принимает отдельный
 * финальный lead. Итоги предыдущих этапов читаются из общей памяти комнаты.
 */
export function buildStageCoordinatorPrompt(
  input: RoomPromptInput,
  stage: NormalizedStage,
  workers: WorkerSummary[],
): string {
  const lines: string[] = [
    `Role: coordinator (integrator) of stage ${stage.index} ("${stage.name}") in a staged agent room.`,
    `You integrate the workers of stage ${stage.index} ONLY; the FINAL pass/fail decision for the step belongs to the final lead.`,
    `Stage ${stage.index} task: ${stage.task}`,
    `Task: ${input.issueTitle}`,
    `Issue description: ${input.description}`,
    ...(input.jiraText ? [`Jira text: ${input.jiraText}`] : []),
    'Iteration context:',
    input.context,
  ];

  if (input.refinedPlan) {
    lines.push('', 'Refined plan (follow it):', input.refinedPlan);
  }

  if (input.repoPaths.length > 0) {
    lines.push(
      '',
      'Repositories (working paths):',
      ...input.repoPaths.map((path) => `- ${path}`),
    );
  } else {
    lines.push(
      '',
      'There are no repositories — the stage deliverables are files in the task working folder.',
    );
  }

  if (input.feedback !== null) {
    lines.push('', `Previous step feedback: ${input.feedback}`);
  }

  if (workers.length > 0) {
    lines.push(
      '',
      `Worker sub-task reports of stage ${stage.index} (read the full files .issue-stage-${stage.index}-worker-<w>.json in the working folder):`,
      ...workers.map(
        (worker) => `  worker ${worker.index + 1}: ${worker.summary}`,
      ),
    );
  } else {
    lines.push(
      '',
      'There are no worker agents for this stage: perform the stage task YOURSELF',
      'and produce the stage result directly.',
    );
  }

  lines.push(
    '',
    'Shared room memory:',
    '- Previous stages publish their outcomes to the shared room memory. Read them',
    '  BEFORE integrating by using the `memory_read` tool and the `memory_search` tool',
    '  (tags `#issue-resolver`, `[[stage-N]]`), in addition to the working-folder files.',
    '- When your stage is done, write a short stage outcome to the shared memory with',
    `  the \`memory_write\` tool: tags \`#issue-resolver\` and \`[[stage-${stage.index}]]\`.`,
    '',
    'Instructions:',
    "- Integrate the workers' changes for YOUR stage, resolve conflicts between them, and finish the stage implementation.",
    `- Write the stage outcome to .issue-stage-${stage.index}.json at the working-folder root:`,
    '  { "status": "pass|fail|blocked", "summary": "..." }.',
    '- This is NOT the final step result: do NOT write .issue-step-result.json.',
    '- Do NOT push and do NOT create an MR — the backend publishes.',
    'Output contract:',
    `.issue-stage-${stage.index}.json is required; without it the stage is incomplete.`,
  );
  return lines.join('\n');
}

/**
 * Промпт финального lead staged-режима: интегрирует исходы ВСЕХ этапов и ОДИН
 * пишет deliverable (`report.html`/`report.md` по desiredResult) и финальный
 * `.issue-step-result.json`.
 */
export function buildStagedFinalCoordinatorPrompt(
  input: RoomPromptInput,
  stages: { stage: NormalizedStage; outcome: string }[],
): string {
  const lines: string[] = [
    'Role: final coordinator (LEAD) of this staged agent room. You integrate the',
    'outcomes of ALL stages below and take the FINAL decision whether the resolve',
    'step passed.',
    `Task: ${input.issueTitle}`,
    `Issue description: ${input.description}`,
    ...(input.jiraText ? [`Jira text: ${input.jiraText}`] : []),
    'Iteration context:',
    input.context,
  ];

  if (input.refinedPlan) {
    lines.push('', 'Refined plan (follow it):', input.refinedPlan);
  }

  if (input.repoPaths.length > 0) {
    lines.push(
      '',
      'Repositories (working paths):',
      ...input.repoPaths.map((path) => `- ${path}`),
    );
  } else {
    lines.push(
      '',
      'There are no repositories — the deliverables are files in the task working folder.',
    );
  }

  if (input.feedback !== null) {
    lines.push('', `Previous step feedback: ${input.feedback}`);
  }

  if (input.desiredResult === 'html') {
    lines.push(
      '',
      'Write the deliverable as a single self-contained `report.html` at the',
      'working-folder root (inline CSS/JS/images via data URIs) — a styled',
      'standalone page to share. In addition to `.issue-step-result.json`.',
    );
  } else if (input.desiredResult === 'md') {
    lines.push(
      '',
      'Write the deliverable as `report.md` at the working-folder root — a',
      'Markdown document. Plain Markdown, no HTML wrapper. In addition to `.issue-step-result.json`.',
    );
  }

  lines.push(
    '',
    'Stage outcomes (read the full files .issue-stage-<index>.json in the working folder):',
    ...stages.map(
      ({ stage, outcome }) =>
        `  stage ${stage.index} (${stage.name}): ${outcome}`,
    ),
    '',
    'Shared room memory:',
    '- Each stage published a short outcome to the shared room memory. Read them with',
    '  the `memory_read` / `memory_search` tools (tags `#issue-resolver`, `[[stage-N]]`),',
    '  in addition to the working-folder files.',
    '- When the resolve step is finished, write the overall resolve outcome to the',
    '  shared memory with the `memory_write` tool: tags `#issue-resolver` and `[[resolve]]`.',
    '',
    'Instructions:',
    '- Integrate the stage outcomes, resolve conflicts between stages, and finalize the implementation.',
    '- You are the ONLY one allowed to conclude the step.',
    '- Decide pass/fail/blocked based on the integrated result, and write the FINAL',
    '  .issue-step-result.json at the working-folder root:',
    '  { "status": "pass|fail|blocked", "summary": "...", "scenarios": [ ... ], "findings": [ ... ] }.',
    '- Do NOT push and do NOT create an MR — the backend publishes.',
    'Output contract:',
    '`.issue-step-result.json` is the single source of truth for this step result.',
  );
  return lines.join('\n');
}