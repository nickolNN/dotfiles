import { join } from 'node:path';
import { asRecord } from './util/records';
import { stringOrNull } from './util/scalars';
import { readJsonFile } from './util/json-file';

export interface BackendConfig {
  BITBUCKET_TOKEN: string;
  BITBUCKET_USERNAME: string;
  BITBUCKET_PASSWORD: string;
  GITHUB_TOKEN: string;
  GITLAB_TOKEN: string;
  JIRA_BASE_URL: string;
  JIRA_TOKEN: string;
}

const CONFIG_KEYS = [
  'BITBUCKET_TOKEN',
  'BITBUCKET_USERNAME',
  'BITBUCKET_PASSWORD',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'JIRA_BASE_URL',
  'JIRA_TOKEN',
] as const satisfies readonly (keyof BackendConfig)[];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const file = readJsonFile(join(process.cwd(), 'config.json'), asRecord) ?? {};
  const config = {} as BackendConfig;
  for (const key of CONFIG_KEYS) {
    config[key] = env[key] || stringOrNull(file[key]) || '';
  }
  return config;
}
