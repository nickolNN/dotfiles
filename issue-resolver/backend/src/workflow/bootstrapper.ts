import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionEvent } from '@issue-resolver/shared';
import type { PiRunner } from '../pi/runner';

/** Cwd-agnostic path to <repo>/prompts/bootstrapper.md, resolved from this module. */
export const DEFAULT_BOOTSTRAP_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..',
  'prompts',
  'bootstrapper.md',
);

/** Имя Markdown-файла с инструкцией по запуску, который пишет bootstrapper. */
export const RUN_INSTRUCTIONS_FILE = 'RUN_INSTRUCTIONS.md';

/** Итог bootstrapper'a: инструкция по запуску либо причина сбоя. */
export interface BootstrapResult {
  success: boolean;
  /** Markdown-инструкция при `success`, иначе null. */
  instructions: string | null;
  error?: string;
}

/**
 * Bootstrapper: смотрит склонированный проект, пытается поставить зависимости
 * и вернуть Markdown-инструкцию по запуску. `workspaceDir` — рабочая папка
 * задачи, видимая агенту (container-путь в docker-режиме, host-путь в local).
 */
export interface BootstrapperAgent {
  bootstrap(
    workspaceDir: string,
    repoUrl: string,
    repoName: string,
    /** Порт dev-сервера, выделенный задаче; попадает в промпт как `{{DEV_SERVER_PORT}}`. */
    devServerPort?: number,
  ): Promise<BootstrapResult>;
}

/** Опции `PiBootstrapperAgent`; `pi` уже инжектится в `runIssueIteration`. */
export interface PiBootstrapperAgentOptions {
  pi: PiRunner;
  /** Имя контейнера задачи (в local-режиме не используется как docker-цель). */
  containerName: string;
  /** Host-путь рабочей папки задачи: отсюда читается `RUN_INSTRUCTIONS.md`. */
  hostWorkspaceDir: string;
  /** Модель bootstrapper-агента (по умолчанию — дефолт pi). */
  model?: string;
  thinkingLevel?: string;
  timeoutMs?: number;
  /** Путь к MD-шаблону промпта; по умолчанию корневой `prompts/bootstrapper.md`. */
  promptPath?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onEvent?: (event: SessionEvent) => void;
}

/**
 * Подставляет `{{REPO_DIR}}`/`{{REPO_NAME}}`/`{{DEV_SERVER_PORT}}` в шаблон
 * промпта bootstrapper'а. Без выделенного порта подставляется `AUTO`.
 */
export function renderBootstrapPrompt(
  template: string,
  repoDir: string,
  repoName: string,
  devServerPort?: number,
): string {
  return template
    .replace(/\{\{REPO_DIR\}\}/g, repoDir)
    .replace(/\{\{REPO_NAME\}\}/g, repoName)
    .replace(
      /\{\{DEV_SERVER_PORT\}\}/g,
      devServerPort !== undefined ? String(devServerPort) : 'AUTO',
    );
}

/** Читает MD-шаблон промпта bootstrapper'а и рендерит его плейсхолдеры. */
export function loadBootstrapPrompt(
  repoDir: string,
  repoName: string,
  devServerPort?: number,
  promptPath: string = DEFAULT_BOOTSTRAP_PROMPT_PATH,
): string {
  const template = readFileSync(promptPath, 'utf-8');
  return renderBootstrapPrompt(template, repoDir, repoName, devServerPort);
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
 * Боевой bootstrapper поверх `PiRunner`: пишет содержимое в контейнере, читает
 * результат с host-диска. Любая ошибка (spawn/timeout/нет файла) — это
 * `{ success: false }`, а не reject: сбой не должен ронять подготовку.
 */
export class PiBootstrapperAgent implements BootstrapperAgent {
  constructor(private readonly options: PiBootstrapperAgentOptions) {}

  async bootstrap(
    workspaceDir: string,
    _repoUrl: string,
    repoName: string,
    devServerPort?: number,
  ): Promise<BootstrapResult> {
    const repoDir = posix.join(workspaceDir, repoName);
    const hostInstructionsPath = join(
      this.options.hostWorkspaceDir,
      repoName,
      RUN_INSTRUCTIONS_FILE,
    );

    let stderr = '';
    try {
      const prompt = loadBootstrapPrompt(
        repoDir,
        repoName,
        devServerPort,
        this.options.promptPath,
      );
      const result = await this.options.pi.run(
        this.options.containerName,
        prompt,
        {
          cwd: workspaceDir,
          model: this.options.model,
          thinkingLevel: this.options.thinkingLevel,
          timeoutMs: this.options.timeoutMs,
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
            ? `bootstrap exited with code ${result.exitCode}`
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