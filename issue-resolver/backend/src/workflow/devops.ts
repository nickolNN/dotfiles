import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionEvent, SessionStats, ThinkingLevel } from '@issue-resolver/shared';
import type { PiRunner } from '../pi/runner';
import { PORT_RANGE_LABEL } from '../port-allocator';
import { issueSessionDir, sessionDisplayName } from '../pi/session-paths';
import { soloRunExcludeTools } from '../pi/tool-policy';
import { STEP_SYSTEM_APPEND } from './prompts';

export const DEFAULT_DEVOPS_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..',
  'prompts',
  'devops.md',
);

export const RUN_INSTRUCTIONS_FILE = 'RUN_INSTRUCTIONS.md';

export interface DevOpsResult {
  success: boolean;
  instructions: string | null;
  error?: string;
  stats?: SessionStats | null;
}

export interface DevOpsAgent {
  runDevOps(
    workspaceDir: string,
    repoUrl: string,
    repoName: string,
    devServerPort?: number,
  ): Promise<DevOpsResult>;
}

export interface PiDevOpsAgentOptions {
  pi: PiRunner;
  containerName: string;
  hostWorkspaceDir: string;
  issueId?: string;
  iterationId?: string;
  stepRunId?: string;
  registry?: import('../pi/session-registry').StepSessionRegistry;
  tagInstructions?: string | null;
  reposNames?: string | null;
  reposRequireDevServer?: string | null;
  reposInstructions?: string | null;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
  promptPath?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onEvent?: (event: SessionEvent) => void;
}

export function renderDevOpsPrompt(
  template: string,
  repoDir: string,
  repoName: string,
  devServerPort: number,
  tagInstructions?: string | null,
  reposNames?: string | null,
  reposRequireDevServer?: string | null,
  reposInstructions?: string | null,
): string {
  const buildReposInstructions = (
    raw: string | null | undefined,
  ): string => {
    if (!raw?.trim()) return '';
    return `\n## Repository Instructions (per-repo)\n\n${raw.trim()}\n`;
  };

  return template
    .replace(/\{\{REPO_DIR\}\}/g, repoDir)
    .replace(/\{\{REPO_NAME\}\}/g, repoName)
    .replace(/\{\{DEV_SERVER_PORT\}\}/g, String(devServerPort))
    .replace(/\{\{DEV_PORT_RANGE\}\}/g, PORT_RANGE_LABEL)
    .replace(
      /\{\{TAG_INSTRUCTIONS\}\}/g,
      tagInstructions?.trim()
        ? `\n## Tag Instructions (workspace-level)\n\n${tagInstructions.trim()}\n`
        : '',
    )
    .replace(/\{\{REPOS_NAMES\}\}/g, reposNames ?? '')
    .replace(
      /\{\{REPOS_REQUIRE_DEV_SERVER\}\}/g,
      reposRequireDevServer ?? '',
    )
    .replace(
      /\{\{REPOS_INSTRUCTIONS\}\}/g,
      buildReposInstructions(reposInstructions),
    );
}

export function loadDevOpsPrompt(
  repoDir: string,
  repoName: string,
  devServerPort: number,
  promptPath: string = DEFAULT_DEVOPS_PROMPT_PATH,
  tagInstructions?: string | null,
  reposNames?: string | null,
  reposRequireDevServer?: string | null,
  reposInstructions?: string | null,
): string {
  const template = readFileSync(promptPath, 'utf-8');
  return renderDevOpsPrompt(
    template,
    repoDir,
    repoName,
    devServerPort,
    tagInstructions,
    reposNames,
    reposRequireDevServer,
    reposInstructions,
  );
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function readRunInstructions(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export class PiDevOpsAgent implements DevOpsAgent {
  constructor(private readonly options: PiDevOpsAgentOptions) {}

  async runDevOps(
    workspaceDir: string,
    _repoUrl: string,
    repoName: string,
    devServerPort?: number,
  ): Promise<DevOpsResult> {
    if (devServerPort === undefined) {
      return {
        success: false,
        instructions: null,
        error: 'задаче не выделен entry-порт dev-сервера',
        stats: null,
      };
    }
    const repoDir = posix.join(workspaceDir, repoName);
    const hostInstructionsPath = join(
      this.options.hostWorkspaceDir,
      repoName,
      RUN_INSTRUCTIONS_FILE,
    );

    let stderr = '';
    try {
      const prompt = loadDevOpsPrompt(
        repoDir,
        repoName,
        devServerPort,
        this.options.promptPath,
        this.options.tagInstructions,
        this.options.reposNames,
        this.options.reposRequireDevServer,
        this.options.reposInstructions,
      );
      const result = await this.options.pi.run(
        this.options.containerName,
        prompt,
        {
          cwd: workspaceDir,
          model: this.options.model,
          thinkingLevel: this.options.thinkingLevel,
          timeoutMs: this.options.timeoutMs,
          issueId: this.options.issueId,
          iterationId: this.options.iterationId,
          stepRunId: this.options.stepRunId,
          registry: this.options.registry,
          excludeTools: soloRunExcludeTools(),
          systemAppend: STEP_SYSTEM_APPEND,
          ...(this.options.issueId
            ? {
                sessionDir: issueSessionDir(this.options.issueId),
                sessionName: sessionDisplayName({
                  step: 'devops',
                  issueId: this.options.issueId,
                }),
              }
            : {}),
          onStdout: this.options.onStdout,
          onStderr: this.options.onStderr,
          onEvent: this.options.onEvent,
        },
      );
      stderr = result.stderr.trim();

      const instructions = await readRunInstructions(hostInstructionsPath);
      if (instructions !== null) {
        return { success: true, instructions, stats: result.stats ?? null };
      }
      return {
        success: false,
        instructions: null,
        stats: result.stats ?? null,
        error:
          stderr ||
          (result.exitCode !== 0
            ? `devops exited with code ${result.exitCode}`
            : `${RUN_INSTRUCTIONS_FILE} not found or empty`),
      };
    } catch (error) {
      return {
        success: false,
        instructions: null,
        error: errorMessage(error),
      };
    }
  }
}