import { readFileSync } from 'fs';
import { join } from 'path';

export interface BackendConfig {
  BITBUCKET_TOKEN: string;
  BITBUCKET_USERNAME: string;
  BITBUCKET_PASSWORD: string;
  GITHUB_TOKEN: string;
  GITLAB_TOKEN: string;
  JIRA_BASE_URL: string;
  JIRA_TOKEN: string;
}

/** Читает config.json и merge с process.env (env приоритетнее файла). */
export function loadConfig(): BackendConfig {
  const defaults: BackendConfig = {
    BITBUCKET_TOKEN: '',
    BITBUCKET_USERNAME: '',
    BITBUCKET_PASSWORD: '',
    GITHUB_TOKEN: '',
    GITLAB_TOKEN: '',
    JIRA_BASE_URL: '',
    JIRA_TOKEN: '',
  };
  try {
    const raw = readFileSync(join(process.cwd(), 'config.json'), 'utf-8');
    const file = JSON.parse(raw);
    return {
      BITBUCKET_TOKEN: process.env.BITBUCKET_TOKEN || file.BITBUCKET_TOKEN || defaults.BITBUCKET_TOKEN,
      BITBUCKET_USERNAME: process.env.BITBUCKET_USERNAME || file.BITBUCKET_USERNAME || defaults.BITBUCKET_USERNAME,
      BITBUCKET_PASSWORD: process.env.BITBUCKET_PASSWORD || file.BITBUCKET_PASSWORD || defaults.BITBUCKET_PASSWORD,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN || file.GITHUB_TOKEN || defaults.GITHUB_TOKEN,
      GITLAB_TOKEN: process.env.GITLAB_TOKEN || file.GITLAB_TOKEN || defaults.GITLAB_TOKEN,
      JIRA_BASE_URL: process.env.JIRA_BASE_URL || file.JIRA_BASE_URL || defaults.JIRA_BASE_URL,
      JIRA_TOKEN: process.env.JIRA_TOKEN || file.JIRA_TOKEN || defaults.JIRA_TOKEN,
    };
  } catch {
    // Файла нет или битый JSON — верни defaults с env-оверрайдами
    return {
      BITBUCKET_TOKEN: process.env.BITBUCKET_TOKEN || defaults.BITBUCKET_TOKEN,
      BITBUCKET_USERNAME: process.env.BITBUCKET_USERNAME || defaults.BITBUCKET_USERNAME,
      BITBUCKET_PASSWORD: process.env.BITBUCKET_PASSWORD || defaults.BITBUCKET_PASSWORD,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN || defaults.GITHUB_TOKEN,
      GITLAB_TOKEN: process.env.GITLAB_TOKEN || defaults.GITLAB_TOKEN,
      JIRA_BASE_URL: process.env.JIRA_BASE_URL || defaults.JIRA_BASE_URL,
      JIRA_TOKEN: process.env.JIRA_TOKEN || defaults.JIRA_TOKEN,
    };
  }
}