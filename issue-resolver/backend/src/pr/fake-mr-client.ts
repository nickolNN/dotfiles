import { RepoPlatform } from '@issue-resolver/shared';
import { hostOf } from './git-host';
import type {
  MrClient,
  MrComment,
  MrCreateInput,
  MrCreateResult,
  MrFetchCommentsInput,
  MrFindInput,
  MrUpdateInput,
} from './mr-types';
import {
  bitbucketProjectRepo,
  githubOwnerRepo,
} from '../repo-resolver/url';

export class FakeMrClient implements MrClient {
  readonly calls: MrCreateInput[] = [];
  private pendingError: Error | null = null;

  reviewComments: MrComment[] = [];

  failNextWith(err: Error): void {
    this.pendingError = err;
  }

  async fetchComments(_input: MrFetchCommentsInput): Promise<MrComment[]> {
    return [...this.reviewComments];
  }

  openMrs: Array<{
    repositoryUrl: string;
    headBranch: string;
    baseBranch: string;
    mrUrl: string;
  }> = [];

  async findOpenMr(input: MrFindInput): Promise<MrCreateResult | null> {
    const found = this.openMrs.find(
      (mr) =>
        mr.repositoryUrl === input.repositoryUrl &&
        mr.headBranch === input.headBranch &&
        mr.baseBranch === input.baseBranch,
    );
    return found ? { mrUrl: found.mrUrl, id: found.mrUrl } : null;
  }

  readonly updateCalls: MrUpdateInput[] = [];
  private pendingUpdateError: Error | null = null;

  failNextUpdateWith(err: Error): void {
    this.pendingUpdateError = err;
  }

  async updateMr(input: MrUpdateInput): Promise<void> {
    this.updateCalls.push(input);
    if (this.pendingUpdateError) {
      const err = this.pendingUpdateError;
      this.pendingUpdateError = null;
      throw err;
    }
  }

  async createMr(input: MrCreateInput): Promise<MrCreateResult> {
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
    this.calls.push(input);
    const id = `mr-${this.calls.length}`;
    if (input.source === RepoPlatform.bitbucket) {
      const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
      return {
        mrUrl: `https://${hostOf(input.repositoryUrl)}/projects/${project}/repos/${repo}/pull-requests/${id}`,
        id,
      };
    }
    if (input.source === RepoPlatform.github) {
      const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
      return {
        mrUrl: `https://${hostOf(input.repositoryUrl)}/${owner}/${repo}/pull/${id}`,
        id,
      };
    }
    const webBase = input.repositoryUrl
      .replace(/^[^@/]+@/, 'https://')
      .replace(/:/, '/')
      .replace(/\.git$/, '');
    return { mrUrl: `${webBase}/-/merge_requests/${id}`, id };
  }
}
