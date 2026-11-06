import { join } from 'node:path';

import type { PipelineStep } from '@issue-resolver/shared';
import type { RepoChangeDigest } from '../../git/service';
import { readPrompt } from './loader';

export interface PrTarget {
  path: string;
  baseBranch: string;
  createMr: boolean;
}

export function outputContract(workingDir?: string): string {
  const contract = readPrompt('output-contract.md');
  if (!workingDir) return contract;
  return [
    `Output contract — write exactly \`${join(workingDir, '.issue-step-result.json')}\` (absolute path).`,
    '',
    contract,
  ].join('\n');
}

export function workingFolderBlock(workingDir?: string): string {
  if (!workingDir) return '';
  return [
    `Working folder (your session's cwd): ${workingDir}`,
    'It is the parent of the repository working copies above — not a clone.',
    'Step artifacts (report files, screenshots/, narratives) belong here, never',
    'inside a clone: whatever the clone contains is what the merge request ships.',
  ].join('\n');
}

export function taskContext(input: {
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

export const DEPENDENCIES_PREPARED =
  'Dependencies are already installed by the task preparation — run an install\nonly if you changed a manifest.';

export function reposBlock(
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

export function credentialsBlock(credentials?: string | null): string {
  if (!credentials?.trim()) {
    return [
      'No test account is configured for this repository. A mock or stub backend is',
      'allowed when it is the only way to reach the UI under test — it is not',
      'equivalent to the real stand, so say in `summary` that the run used one and',
      'name the scenarios that depend on it. Only findings that also hold on the',
      'real stand may be `major` or `critical`; the rest belong in `low`/`info`',
      'with the mock named as the reason. If the change cannot be judged any other',
      'way, the verdict is `blocked` with the missing-login reason.',
    ].join('\n');
  }
  return [
    'Test account for this repository (use it to log in for real):',
    '',
    '```',
    credentials.trim(),
    '```',
    '',
    'Never copy the password or token into `.issue-step-result.json`, the narrative,',
    'a screenshot or the report.',
  ].join('\n');
}

export function devServerBlock(devServerPort?: number | null): string {
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

export function workingStateBlock(digests?: RepoChangeDigest[]): string {
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

export function attachmentsBlock(paths?: string[]): string {
  const attachments = paths ?? [];
  if (attachments.length === 0) return '';
  return [
    'Uploaded files (already in the working folder):',
    ...attachments.map((path) => `- ${path}`),
    'Read them before solving.',
  ].join('\n');
}

export function refinedPlanBlock(plan?: string | null): string {
  return plan
    ? `Task brief (from the refine step — the size, the split, and the decisions behind them; follow it, do not re-plan from scratch):\n${plan}`
    : '';
}

export function previousOutcomeBlock(outcome?: string | null): string {
  return outcome
    ? `Previous iteration outcome (build on it, do not redo from scratch):\n${outcome}`
    : '';
}

export function pipelineLine(pipelineSteps: PipelineStep[] | undefined): string[] {
  if (!pipelineSteps || pipelineSteps.length === 0) return [];
  return [`Enabled pipeline for this run: ${pipelineSteps.join(' → ')}.`];
}

export function parallelismBlock(cap: number): string {
  return cap <= 1
    ? [
        'Parallel executors: 1 — only one agent runs at a time.',
        'This is a concurrency limit, not a limit on the run: the work still',
        'decomposes into `stages` with one executor per stage — 2, 5 or 20 stages,',
        'every stage a separate agent that runs after the previous one. Declaring',
        'more than 1 parallel executor in any stage is a planner error and the plan',
        'is rejected. A single stage with one executor is `single`, not a wave.',
      ].join('\n')
    : [
        `Parallel executors: at most ${cap} at the same moment — a concurrency ceiling,`,
        'not a limit on the plan: the number of stages is not limited by it, and a plan',
        'that declares more than this in one stage is rejected and sent back to you.',
        'One stage with several executors is a single parallel wave; when the work',
        'needs more hands than one wave, add a stage rather than oversubscribing one.',
      ].join('\n');
}

export function grouped(value: number): string {
  return value.toLocaleString('en-US').replace(/,/g, ' ');
}

const SHARED_FRAGMENTS = ['step-scope.md', 'capabilities.md', 'memory-rules.md'];

export function withSharedFragments(prompt: string): string {
  return [
    prompt,
    ...SHARED_FRAGMENTS.map((name) => readPrompt(name).trim()),
  ].join('\n\n');
}

const CODEMODE_DIRECTIVE = [
  'Prefer `codemode` over a pile of single calls: one script that calls the other',
  'tools does the work of twenty turns of `bash`. The plain tool stays right for',
  'a single call.',
].join(' ');

export const STEP_SYSTEM_APPEND = [
  'The deliverable of this run is `.issue-step-result.json` in the working folder.',
  'A summary in chat is not a deliverable: do not substitute prose for that file,',
  'and do not paste the plan, the report, or the diff into chat instead of writing it.',
  CODEMODE_DIRECTIVE,
].join(' ');

export const DEVOPS_SYSTEM_APPEND = [
  'The deliverable of this run is `RUN_INSTRUCTIONS.md` in the repository working',
  'copy. A summary in chat is not a deliverable: write the file the engine reads.',
  CODEMODE_DIRECTIVE,
].join(' ');