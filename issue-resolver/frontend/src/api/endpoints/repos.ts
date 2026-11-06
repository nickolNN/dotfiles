import type {
  CreateRepoRequest,
  RepoBranchesResponse,
  RepoInfo,
  RepoValidationResult,
  SavedRepo,
  UpdateRepoRequest,
} from '@issue-resolver/shared';
import {
  RepoConnectionStatus,
  RepoPlatform,
  RunInstructionsStatus,
} from '@issue-resolver/shared';
import {
  isArrayWhere,
  isBoolean,
  isNullableString,
  isNumber,
  isOneOf,
  isOptionalOf,
  isRecord,
  isString,
} from '../guards';
import {
  API_BASE,
  requestJson,
  requestVoid,
  send,
  statusErrorMessage,
} from './http';

const PLATFORMS = Object.values(RepoPlatform);
const CONNECTION_STATUSES = Object.values(RepoConnectionStatus);
const RUN_INSTRUCTIONS_STATUSES = Object.values(RunInstructionsStatus);

function isRepoInfo(value: unknown): value is RepoInfo {
  return (
    isRecord(value) &&
    isOneOf(PLATFORMS, value.platform) &&
    isString(value.fullName) &&
    isString(value.defaultBranch) &&
    isArrayWhere(value.branches, isString) &&
    isNullableString(value.language) &&
    isNullableString(value.description) &&
    isNumber(value.stars) &&
    isBoolean(value.isPrivate) &&
    isString(value.cloneUrl) &&
    isBoolean(value.writeAccess)
  );
}

function isRepoValidationResult(
  value: unknown,
): value is RepoValidationResult {
  return (
    isRecord(value) &&
    isString(value.url) &&
    isBoolean(value.valid) &&
    isOneOf(PLATFORMS, value.platform) &&
    isOptionalOf(value.info, isRepoInfo) &&
    isOptionalOf(value.error, isString)
  );
}

function isSavedRepo(value: unknown): value is SavedRepo {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.url) &&
    (value.platform === null || isOneOf(PLATFORMS, value.platform)) &&
    isNullableString(value.fullName) &&
    isNullableString(value.defaultBranch) &&
    isNullableString(value.cloneUrl) &&
    isNullableString(value.language) &&
    isNullableString(value.description) &&
    (value.isPrivate === null || isBoolean(value.isPrivate)) &&
    isOneOf(CONNECTION_STATUSES, value.connectionStatus) &&
    isNullableString(value.lastValidatedAt) &&
    isBoolean(value.writeAccess) &&
    isNullableString(value.runInstructions) &&
    isOneOf(RUN_INSTRUCTIONS_STATUSES, value.runInstructionsStatus) &&
    isNullableString(value.testCredentials) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

async function readRepositoryResponse(response: Response): Promise<SavedRepo> {
  const data: unknown = await response.json().catch(() => null);
  if (response.ok && isSavedRepo(data)) {
    return data;
  }
  const repository = isRecord(data) ? data.repository : null;
  if (isSavedRepo(repository)) {
    return repository;
  }
  const message =
    isRecord(data) && isString(data.error) && data.error
      ? data.error
      : statusErrorMessage(response);
  throw new Error(message);
}

export async function validateRepos(
  urls: string[],
): Promise<RepoValidationResult[]> {
  const data = await requestJson<{ results?: unknown }>(
    `${API_BASE}/repos/validate`,
    { method: 'POST', json: { urls } },
  );
  return Array.isArray(data?.results)
    ? data.results.filter(isRepoValidationResult)
    : [];
}

export function getRepositories(): Promise<SavedRepo[]> {
  return requestJson<SavedRepo[]>(`${API_BASE}/repositories`);
}

export async function createRepository(url: string): Promise<SavedRepo> {
  const request: CreateRepoRequest = { url };
  const response = await send(`${API_BASE}/repositories`, {
    method: 'POST',
    json: request,
  });
  return readRepositoryResponse(response);
}

export async function updateRepository(
  id: string,
  url: string,
): Promise<SavedRepo> {
  const request: UpdateRepoRequest = { url };
  const response = await send(`${API_BASE}/repositories/${id}`, {
    method: 'PUT',
    json: request,
  });
  return readRepositoryResponse(response);
}

export async function saveRepositoryCredentials(
  id: string,
  testCredentials: string | null,
): Promise<SavedRepo> {
  const response = await send(
    `${API_BASE}/repositories/${id}/credentials`,
    { method: 'PUT', json: { testCredentials } },
  );
  return readRepositoryResponse(response);
}

export function deleteRepository(id: string): Promise<void> {
  return requestVoid(`${API_BASE}/repositories/${id}`, { method: 'DELETE' });
}

export function validateRepository(id: string): Promise<SavedRepo> {
  return requestJson<SavedRepo>(`${API_BASE}/repositories/${id}/validate`, {
    method: 'POST',
  });
}

export async function getRepositoryBranches(id: string): Promise<string[]> {
  const data = await requestJson<RepoBranchesResponse>(
    `${API_BASE}/repositories/${id}/branches`,
  );
  return Array.isArray(data?.branches) ? data.branches : [];
}

