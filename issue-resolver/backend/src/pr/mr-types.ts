import type { RepoPlatform } from '@issue-resolver/shared';

export type MrSource = Exclude<RepoPlatform, 'unknown'>;

export interface MrCreateInput {
  repositoryUrl: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  description: string;
  token: string;
  source: MrSource;
}

export interface MrCreateResult {
  mrUrl: string;
  id: string;
}

export interface MrUpdateInput {
  repositoryUrl: string;
  mrId: string;
  title: string;
  description: string;
  token: string;
  source: MrSource;
}

export interface MrComment {
  file: string | null;
  line: number | null;
  body: string;
  author: string;
  created_at: string;
}

export interface MrFetchCommentsInput {
  mrUrl: string;
  token: string;
  repositoryUrl?: string;
}

export interface MrFindInput {
  repositoryUrl: string;
  headBranch: string;
  baseBranch: string;
  token: string;
  source: MrSource;
}

export interface MrClient {
  createMr(input: MrCreateInput): Promise<MrCreateResult>;
  fetchComments(input: MrFetchCommentsInput): Promise<MrComment[]>;
  findOpenMr(input: MrFindInput): Promise<MrCreateResult | null>;
  updateMr(input: MrUpdateInput): Promise<void>;
}

export interface PrPublishError {
  repositoryUrl: string;
  message: string;
}

export function formatPrPublishErrors(errors: PrPublishError[]): string {
  return errors.map((error) => error.message).join('; ');
}

export interface MrTokens {
  gitlab?: string;
  github?: string;
  bitbucket?: string;
}
