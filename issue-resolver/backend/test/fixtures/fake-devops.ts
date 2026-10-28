import type {
  DevOpsAgent,
  DevOpsResult,
} from '../../src/workflow/devops';

export interface FakeDevOpsCall {
  workspaceDir: string;
  repoUrl: string;
  repoName: string;
}

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