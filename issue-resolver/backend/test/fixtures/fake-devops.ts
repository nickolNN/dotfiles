import type {
  DevOpsAgent,
  DevOpsResult,
} from '../../src/workflow/devops';

/** Зафиксированный вызов `analyze` (для assert'ов). */
export interface FakeDevOpsCall {
  workspaceDir: string;
  repoUrl: string;
  repoName: string;
}

/**
 * Детерминированный фейк `DevOpsAgent`: возвращает заданный результат и
 * записывает каждый вызов. Позволяет тестировать хук подготовки без pi.
 */
export class FakeDevOpsAgent implements DevOpsAgent {
  readonly calls: FakeDevOpsCall[] = [];

  constructor(private readonly result: DevOpsResult) {}

  async runDevOps(
    workspaceDir: string,
    repoUrl: string,
    repoName: string,
  ): Promise<DevOpsResult> {
    this.calls.push({ workspaceDir, repoUrl, repoName });
    return this.result;
  }
}