import type { DesiredResult, PipelineStep } from '@issue-resolver/shared';

export interface StepPromptInput {
  step: PipelineStep;
  issueTitle: string;
  /** Issue description (additional_context). */
  description: string;
  /** Jira issue text (or null if absent/unavailable). */
  jiraText: string | null;
  context: string;
  feedback: string | null;
  repoPaths: string[];
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
      'First ask the user clarifying questions — output them to stdout (they will appear in the live log);',
      'then, based on the answers received, build an implementation plan.',
      'Order: questions → answers → plan.',
      'For questions use the grill-me skill, and for ambiguities additionally the to-questionnaire skill.',
      'Step outcome: refined context and a plan for the following steps.',
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

  review: () =>
    [
      'Role: independent reviewer, do NOT continue the implementation.',
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