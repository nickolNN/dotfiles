import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionEvent, ThinkingLevel } from '@issue-resolver/shared';
import type { PiRunner } from '../pi/runner';
import { issueSessionDir, sessionDisplayName } from '../pi/session-paths';
import { soloRunExcludeTools } from '../pi/tool-policy';
import { STEP_SYSTEM_APPEND } from './prompts';

/** Cwd-agnostic path to <repo>/prompts/devops.md, resolved from this module. */
export const DEFAULT_DEVOPS_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..',
  'prompts',
  'devops.md',
);

/** Имя Markdown-файла с инструкцией по запуску, который пишет DevOps-агент. */
export const RUN_INSTRUCTIONS_FILE = 'RUN_INSTRUCTIONS.md';

/** Итог DevOps-агента: инструкция по запуску либо причина сбоя. */
export interface DevOpsResult {
  success: boolean;
  /** Markdown-инструкция при `success`, иначе null. */
  instructions: string | null;
  error?: string;
}

/**
 * DevOps: смотрит склонированный проект, пытается поставить зависимости
 * и вернуть Markdown-инструкцию по запуску. `workspaceDir` — рабочая папка
 * задачи, видимая агенту (container-путь в docker-режиме, host-путь в local).
 */
export interface DevOpsAgent {
  runDevOps(
    workspaceDir: string,
    repoUrl: string,
    repoName: string,
    /** Порт dev-сервера, выделенный задаче; попадает в промпт как `{{DEV_SERVER_PORT}}`. */
    devServerPort?: number,
  ): Promise<DevOpsResult>;
}

/** Опции `PiDevOpsAgent`; `pi` уже инжектится в `runIssueIteration`. */
export interface PiDevOpsAgentOptions {
  pi: PiRunner;
  /** Имя контейнера задачи (в local-режиме не используется как docker-цель). */
  containerName: string;
  /** Host-путь рабочей папки задачи: отсюда читается `RUN_INSTRUCTIONS.md`. */
  hostWorkspaceDir: string;
  /** ID задачи — комната `issue-<issueId>` для интерактивной сессии. */
  issueId?: string;
  /** ID итерации — адрес сессии в реестре. */
  iterationId?: string;
  /** stepRunId для регистрации живой сессии. */
  stepRunId?: string;
  /** Реестр живых сессий для steer/abort. */
  registry?: import('../pi/session-registry').StepSessionRegistry;
  /**
   * Тег-инструкции проекта (Markdown): правила запуска всего набора репозиториев
   * вместе (прокси, порты, переменные окружения). Агент читает их до начала
   * работы и пишет `WORKSPACE_INSTRUCTIONS.md` в корень рабочей папки.
   */
  tagInstructions?: string | null;
  /** Имена всех репозиториев в workspace (через запятую). */
  reposNames?: string | null;
  /** Имена репозиториев, отмеченных для запуска dev-сервера (через запятую). */
  reposRequireDevServer?: string | null;
  /** Per-репозиторий инструкции по запуску (Markdown-секция с ###). */
  reposInstructions?: string | null;
  /** Модель DevOps-агента (по умолчанию — дефолт pi). */
  model?: string;
  /** Уровень размышления pi (`--thinking`); попадает в аргументы запуска pi. */
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
  /** Путь к MD-шаблону промпта; по умолчанию корневой `prompts/devops.md`. */
  promptPath?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onEvent?: (event: SessionEvent) => void;
}

/**
 * Подставляет `{{REPO_DIR}}`/`{{REPO_NAME}}`/`{{DEV_SERVER_PORT}}`/
 * `{{TAG_INSTRUCTIONS}}`/`{{REPOS_NAMES}}`/`{{REPOS_REQUIRE_DEV_SERVER}}`/
 * `{{REPOS_INSTRUCTIONS}}` в шаблон промпта DevOps-агента.
 * Без выделенного порта подставляется `AUTO`.
 */
export function renderDevOpsPrompt(
  template: string,
  repoDir: string,
  repoName: string,
  devServerPort?: number,
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
    .replace(
      /\{\{DEV_SERVER_PORT\}\}/g,
      devServerPort !== undefined ? String(devServerPort) : 'AUTO',
    )
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

/** Читает MD-шаблон промпта DevOps-агента и рендерит его плейсхолдеры. */
export function loadDevOpsPrompt(
  repoDir: string,
  repoName: string,
  devServerPort?: number,
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

/** Читает и обрезает `RUN_INSTRUCTIONS.md`; нет файла/пусто → null. */
async function readRunInstructions(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Боевой devops поверх `PiRunner`: пишет содержимое в контейнере, читает
 * результат с host-диска. Любая ошибка (spawn/timeout/нет файла) — это
 * `{ success: false }`, а не reject: сбой не должен ронять подготовку.
 */
export class PiDevOpsAgent implements DevOpsAgent {
  constructor(private readonly options: PiDevOpsAgentOptions) {}

  async runDevOps(
    workspaceDir: string,
    _repoUrl: string,
    repoName: string,
    devServerPort?: number,
  ): Promise<DevOpsResult> {
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
        return { success: true, instructions };
      }
      return {
        success: false,
        instructions: null,
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