import type {
  BootstrapperAgent,
  BootstrapResult,
} from '../../src/workflow/bootstrapper';

/** Зафиксированный вызов `analyze` (для assert'ов). */
export interface FakeBootstrapperCall {
  workspaceDir: string;
  repoUrl: string;
  repoName: string;
}

/**
 * Детерминированный фейк `BootstrapperAgent`: возвращает заданный результат и
 * записывает каждый вызов. Позволяет тестировать хук подготовки без pi.
 */
export class FakeBootstrapperAgent implements BootstrapperAgent {
  readonly calls: FakeBootstrapperCall[] = [];

  constructor(private readonly result: BootstrapResult) {}

  async bootstrap(
    workspaceDir: string,
    repoUrl: string,
    repoName: string,
  ): Promise<BootstrapResult> {
    this.calls.push({ workspaceDir, repoUrl, repoName });
    return this.result;
  }
}