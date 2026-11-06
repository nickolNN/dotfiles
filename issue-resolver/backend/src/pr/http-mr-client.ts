import {
  createBitbucketMr,
  fetchBitbucketComments,
  findBitbucketOpenMr,
  updateBitbucketMr,
} from './bitbucket-mr';
import { detectGitHost } from './git-host';
import {
  createGitHubMr,
  fetchGitHubComments,
  findGitHubOpenMr,
  updateGitHubMr,
} from './github-mr';
import {
  createGitLabMr,
  fetchGitLabComments,
  findGitLabOpenMr,
  updateGitLabMr,
} from './gitlab-mr';
import type {
  MrClient,
  MrComment,
  MrSource,
  MrCreateInput,
  MrCreateResult,
  MrFetchCommentsInput,
  MrFindInput,
  MrTokens,
  MrUpdateInput,
} from './mr-types';

interface MrSourceHandlers {
  create: (input: MrCreateInput, token: string) => Promise<MrCreateResult>;
  find: (input: MrFindInput, token: string) => Promise<MrCreateResult | null>;
  update: (input: MrUpdateInput, token: string) => Promise<void>;
  comments: (
    input: MrFetchCommentsInput,
    token: string,
  ) => Promise<MrComment[]>;
}

const MR_SOURCE_HANDLERS: Record<MrSource, MrSourceHandlers> = {
  github: {
    create: createGitHubMr,
    find: findGitHubOpenMr,
    update: updateGitHubMr,
    comments: (input, token) =>
      fetchGitHubComments(input.mrUrl, token, input.repositoryUrl),
  },
  gitlab: {
    create: createGitLabMr,
    find: findGitLabOpenMr,
    update: updateGitLabMr,
    comments: (input, token) =>
      fetchGitLabComments(input.mrUrl, token, input.repositoryUrl),
  },
  bitbucket: {
    create: createBitbucketMr,
    find: findBitbucketOpenMr,
    update: updateBitbucketMr,
    comments: (input, token) =>
      fetchBitbucketComments(input.mrUrl, token, input.repositoryUrl),
  },
};

export class HttpMrClient implements MrClient {
  constructor(
    private readonly token = '',
    private readonly tokens: MrTokens = {},
  ) {}

  private tokenFor(source: MrCreateInput['source'], inputToken: string): string {
    return inputToken || this.tokens[source] || this.token;
  }

  async fetchComments(input: MrFetchCommentsInput): Promise<MrComment[]> {
    const source = detectGitHost(input.repositoryUrl || input.mrUrl, input.mrUrl);
    const token = this.tokenFor(source, input.token);

    return MR_SOURCE_HANDLERS[source].comments(input, token);
  }

  async findOpenMr(input: MrFindInput): Promise<MrCreateResult | null> {
    const token = this.tokenFor(input.source, input.token);

    return MR_SOURCE_HANDLERS[input.source].find(input, token);
  }

  async updateMr(input: MrUpdateInput): Promise<void> {
    const token = this.tokenFor(input.source, input.token);

    return MR_SOURCE_HANDLERS[input.source].update(input, token);
  }

  async createMr(input: MrCreateInput): Promise<MrCreateResult> {
    const token = this.tokenFor(input.source, input.token);

    return MR_SOURCE_HANDLERS[input.source].create(input, token);
  }
}
