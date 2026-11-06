import type { RepoConnectionStatus, RunInstructionsStatus } from '../status';

export const RepoPlatform = Object.freeze({
  github: 'github',
  gitlab: 'gitlab',
  bitbucket: 'bitbucket',
  unknown: 'unknown',
} as const);
export type RepoPlatform =
  (typeof RepoPlatform)[keyof typeof RepoPlatform];

export function isKnownRepoPlatform(
  platform: RepoPlatform,
): platform is Exclude<RepoPlatform, 'unknown'> {
  return platform !== RepoPlatform.unknown;
}

export interface RepoInfo {
  platform: RepoPlatform;
  fullName: string;
  defaultBranch: string;
  branches: string[];
  language: string | null;
  description: string | null;
  stars: number;
  isPrivate: boolean;
  cloneUrl: string;
  writeAccess: boolean;
}

export interface RepoValidationResult {
  url: string;
  valid: boolean;
  platform: RepoPlatform;
  info?: RepoInfo;
  error?: string;
}

export interface SavedRepo {
  id: string;
  url: string;
  platform: RepoPlatform | null;
  fullName: string | null;
  defaultBranch: string | null;
  cloneUrl: string | null;
  language: string | null;
  description: string | null;
  isPrivate: boolean | null;
  connectionStatus: RepoConnectionStatus;
  lastValidatedAt: string | null;
  writeAccess: boolean;
  runInstructions: string | null;
  runInstructionsStatus: RunInstructionsStatus;
  testCredentials: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepoRequest {
  url: string;
}

export interface UpdateRepoRequest {
  url: string;
}

export interface RepoBranchesResponse {
  branches: string[];
}

export interface TagRepository {
  id: string;
  tag_id: string;
  repository_id: string;
  bootstrap_enabled: boolean;
  created_at: string;
}

export interface Tag {
  id: string;
  name: string;
  description: string | null;
  run_instructions: string | null;
  run_instructions_status: RunInstructionsStatus;
  repositories: TagRepositoryWithRepo[];
  created_at: string;
  updated_at: string;
}

export interface TagRepositoryWithRepo extends TagRepository {
  repository: SavedRepo;
}

export interface CreateTagRequest {
  name: string;
  description?: string;
  run_instructions?: string | null;
  repositories: { repository_id: string; bootstrap_enabled?: boolean }[];
}

export interface UpdateTagRequest {
  name?: string;
  description?: string;
  run_instructions?: string | null;
  repositories?: { repository_id: string; bootstrap_enabled?: boolean }[];
}