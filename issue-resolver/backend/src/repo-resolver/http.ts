import { JSON_PARSE_FAILED, tryParseJson } from '../util/json-file';
import { asRecord } from '../util/records';

export async function readJson(response: Response): Promise<unknown | null> {
  if (!response.ok) return null;
  const body = await response.text().catch(() => '');
  const parsed = tryParseJson(body);
  return parsed === JSON_PARSE_FAILED ? null : parsed;
}

export async function fetchBranchList(
  url: string,
  init: RequestInit,
  extract: (payload: unknown) => string[] | undefined,
): Promise<string[] | null> {
  try {
    const payload = await readJson(await fetch(url, init));
    if (!payload) return null;
    return extract(payload) ?? [];
  } catch {
    return null;
  }
}

export const namesOf = (list: unknown): string[] | undefined =>
  Array.isArray(list)
    ? list.flatMap((branch) => {
        const name = asRecord(branch)?.name;
        return typeof name === 'string' ? [name] : [];
      })
    : undefined;

export interface BranchChoice {
  defaultBranch: string;
  branches: string[];
}

export function chooseBranches(
  declared: string | null | undefined,
  listed: string[] | null,
): BranchChoice {
  const fallback = declared ?? '';
  if (listed === null) {
    return fallback
      ? { defaultBranch: fallback, branches: [fallback] }
      : { defaultBranch: '', branches: [] };
  }
  if (listed.length === 0) {
    return { defaultBranch: '', branches: [] };
  }
  return { defaultBranch: fallback || listed[0], branches: listed };
}

export function assertRepoResponse(response: Response, api: string): void {
  if (response.status === 404) {
    throw new Error('Repository not found');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('Access denied');
  }
  if (!response.ok) {
    throw new Error(`${api} API request failed: ${response.status}`);
  }
}