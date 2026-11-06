import type { RepoInfo } from '@issue-resolver/shared';
import type { RepoResolver } from './types';

export class FakeRepoResolver implements RepoResolver {
  readonly calls: string[] = [];
  private pendingError: Error | null = null;

  constructor(private readonly info: RepoInfo) {}

  failNextWith(err: Error): void {
    this.pendingError = err;
  }

  async resolve(url: string): Promise<RepoInfo> {
    this.calls.push(url);
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
    return { ...this.info, writeAccess: this.info.writeAccess ?? true };
  }
}