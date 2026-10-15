/**
 * Пакетная валидация URL репозиториев: определяет платформу, резолвит
 * метаданные и не роняет запрос из-за одной ошибки (сеть/404/403 →
 * `valid: false` с сообщением).
 */

import type { RepoValidationResult } from '@issue-resolver/shared';
import {
  createRepoResolver,
  detectPlatform,
  type RepoResolverFactory,
} from './resolver';

/** Валидатор URL репозиториев (шов инъекции для роута и тестов). */
export type ReposValidator = (
  urls: string[],
) => Promise<RepoValidationResult[]>;

/**
 * Валидирует список URL. Резолвер выбирается фабрикой (`createRepoResolver`
 * по умолчанию); фабрику можно подменить в тестах.
 */
export async function validateRepos(
  urls: string[],
  env: NodeJS.ProcessEnv,
  factory: RepoResolverFactory = createRepoResolver,
): Promise<RepoValidationResult[]> {
  return Promise.all(
    urls.map(async (url) => {
      const platform = detectPlatform(url);
      if (platform === 'unknown') {
        return { url, valid: false, platform, error: 'Unsupported platform' };
      }
      try {
        const resolver = factory(url, env);
        const info = await resolver.resolve(url);
        return {
          url,
          valid: true,
          platform,
          // Инжектированные/fake-резолверы могут не знать о правах записи.
          info: { ...info, writeAccess: info.writeAccess ?? false },
        };
      } catch (err) {
        return {
          url,
          valid: false,
          platform,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    }),
  );
}

/** Собирает валидатор, замкнутый на env (и, в тестах, на фабрику резолверов). */
export function createReposValidator(
  env: NodeJS.ProcessEnv,
  factory?: RepoResolverFactory,
): ReposValidator {
  return (urls) => validateRepos(urls, env, factory);
}